"""Hook-free launcher regressions; stdlib and fake processes only."""
import importlib.util
import itertools
import json
import os
from pathlib import Path
import queue
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('managed', HERE / 'claude_auto_managed.py')
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)


class ArgumentsTest(unittest.TestCase):
    def test_literal_prompt_and_flag_values(self):
        flags, prompt = managed.arguments(['--model=gpt-route', '--effort', 'high', '--', '--resume is text'])
        self.assertEqual(flags, ['--model', 'gpt-route', '--effort', 'high'])
        self.assertEqual(prompt, '--resume is text')

    def test_ambiguous_or_lifecycle_arguments_fail_before_launch(self):
        for args in (['--resume', 'abc'], ['-p'], ['--tools', ''], ['--model'],
                     ['--permission-mode', 'bypassPermissions'], ['--dangerously-skip-permissions'],
                     ['--input-format', 'text'], ['--worktree'], ['--managed']):
            with self.subTest(args=args), self.assertRaises(ValueError):
                managed.arguments(args)

    def test_user_prompt_is_not_interpreted_as_flags(self):
        self.assertEqual(managed.arguments(['fix', 'the', 'bug']), ([], 'fix the bug'))

    def test_worker_is_tool_free_and_does_not_receive_owner_flags(self):
        args = managed.helper_command('claude', 'chosen-model', ['--effort', 'high', '--append-system-prompt', 'OWNER_SECRET'])
        self.assertIn('--safe-mode', args)
        self.assertEqual(args[args.index('--tools') + 1], '')
        self.assertIn('--no-session-persistence', args)
        self.assertNotIn('OWNER_SECRET', args)
        self.assertEqual(args[args.index('--model') + 1], 'chosen-model')
        self.assertNotIn('--resume', args)


class CoordinationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.c = managed.Coordinator(str(Path(self.tmp.name) / 'state.db'), self.tmp.name)
        self.c.register()

    def test_cancel_finishes_before_prompt_registration_and_send(self):
        order = []
        original = self.c.rpc
        def rpc(op, **fields):
            order.append(op)
            return original(op, **fields)
        self.c.rpc = rpc
        self.c.admit('own work', lambda: order.append('helper-waited'), lambda: order.append('sent'))
        self.assertEqual(order, ['helper-waited', 'prompt', 'sent'])
        self.assertEqual(self.c.revision, 1)
        self.assertTrue(self.c.active)

    def test_failed_cancellation_never_registers_or_forwards(self):
        send = mock.Mock()
        with self.assertRaises(RuntimeError):
            self.c.admit('work', mock.Mock(side_effect=RuntimeError('not stopped')), send)
        self.assertEqual(self.c.revision, 0)
        send.assert_not_called()

    def test_failed_registry_never_forwards(self):
        send = mock.Mock()
        with mock.patch.object(self.c, 'rpc', side_effect=ValueError('unavailable')):
            with self.assertRaises(ValueError):
                self.c.admit('work', mock.Mock(), send)
        self.assertFalse(self.c.healthy)
        send.assert_not_called()

    def test_final_answer_does_not_mark_owner_idle(self):
        self.c.admit('work', lambda: None, lambda: None)
        self.c.active = False
        self.assertEqual(self.c.rpc('heartbeat')['member']['owner_state'], 'active')

    def test_help_gate_exhaustive_three_factors(self):
        for active, pending, explicit_idle in itertools.product((False, True), repeat=3):
            with self.subTest(active=active, pending=pending, explicit_idle=explicit_idle):
                self.c.active, self.c.pending = active, pending
                self.assertEqual(self.c.can_help('idle' if explicit_idle else 'active'),
                                 not active and not pending and explicit_idle)
        self.c.healthy = False
        self.c.active = self.c.pending = False
        self.assertFalse(self.c.can_help('idle'))

    def test_old_generation_and_wrong_token_cannot_mutate(self):
        self.c.admit('work', lambda: None, lambda: None)
        self.c.token = 'current-turn'
        for token, generation in [('old-turn', self.c.generation), ('current-turn', 0)]:
            reply = self.c.handle({'token': token, 'generation': generation, 'name': 'coordinate',
                                   'arguments': {'action': 'finish'}})
            self.assertFalse(reply['ok'])
        self.assertEqual(self.c.rpc('heartbeat')['member']['owner_state'], 'active')

    def test_pending_human_blocks_mutation_but_not_status(self):
        self.c.admit('work', lambda: None, lambda: None)
        self.c.pending = True
        with self.assertRaises(ValueError):
            self.c.coordinate({'action': 'finish'})
        self.assertTrue(self.c.coordinate({'action': 'status'})['ok'])

    def test_explicit_finish_then_rotation_preserves_revision(self):
        self.c.admit('work', lambda: None, lambda: None)
        self.c.coordinate({'action': 'finish'})
        self.c.active = False
        old_session, old_revision = self.c.session, self.c.revision
        self.c.rotate()
        self.assertNotEqual(self.c.session, old_session)
        self.assertEqual(self.c.revision, old_revision)
        self.assertEqual(self.c.rpc('heartbeat')['member']['owner_state'], 'idle')

    def test_owner_revision_not_taken_from_model_arguments(self):
        self.c.admit('work', lambda: None, lambda: None)
        with self.assertRaises(ValueError):
            self.c.coordinate({'action': 'finish', 'expected_revision': 0})


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.database = str(Path(self.tmp.name) / 'state.db')
        with mock.patch.dict(os.environ, CLAUDE_AUTO_COOP_DB=self.database):
            self.s = managed.Supervisor(mock.Mock(VARIANT_RULE='variant rule'), 'claude', [], self.tmp.name)
        self.s.c.register()
        self.s.c.admit('own work', lambda: None, lambda: None)
        self.s.c.coordinate({'action': 'finish'})
        self.s.c.active = False
        self.peer = managed.Coordinator(self.database, self.tmp.name)
        self.peer.register()
        self.peer.admit('peer work', lambda: None, lambda: None)

    def test_handoff_waits_for_owner_exit_and_preserves_revision(self):
        root = Path(self.tmp.name)
        transcript = root / 'config/projects/project' / (self.s.c.session + '.jsonl')
        transcript.parent.mkdir(parents=True)
        transcript.write_text('{}\n')
        writer = root / 'make_context.py'
        writer.write_text('# fixture\n')
        output = root / 'handoff'
        launcher = self.s.launcher
        launcher.env_num.side_effect = lambda name, default: default
        launcher.context_tokens.return_value = 160000
        launcher.find_make_context.return_value = str(writer)
        launcher.handoff_dir.return_value = str(output)
        launcher.skills_args.return_value = []
        order = []
        process = mock.Mock(invalid=False, result={'type': 'result', 'subtype': 'success', 'is_error': False})
        process.stop.side_effect = lambda: order.append('stopped')
        self.s.owner, self.s.c.active, self.s.resumed = process, True, True
        session, revision = self.s.c.session, self.s.c.revision
        def write_note(command, **kwargs):
            self.assertIsNone(self.s.owner)
            self.assertFalse(self.s.c.active)
            self.assertEqual(command[2], str(transcript))
            output.mkdir()
            (output / 'HANDOFF.md').write_text('history')
            order.append('handoff')
            return subprocess.CompletedProcess(command, 0, '', '')
        with mock.patch.dict(os.environ, CLAUDE_CONFIG_DIR=str(root / 'config')):
            with mock.patch.object(managed.subprocess, 'run', side_effect=write_note):
                self.s.exited(process, 0)
        self.assertEqual(order, ['stopped', 'handoff'])
        self.assertNotEqual(self.s.c.session, session)
        self.assertEqual(self.s.c.revision, revision)
        self.assertEqual(self.s.note, str(output / 'HANDOFF.md'))
        self.assertFalse(self.s.resumed)
        self.assertEqual(self.s.handoffs, 1)

    def test_handoff_keeps_skill_reload_for_human_and_automated_turns(self):
        root = Path(self.tmp.name)
        writer = root / 'make_context.py'
        writer.write_text('# fixture\n')
        launcher = self.s.launcher
        launcher.env_num.side_effect = lambda name, default: default
        launcher.context_tokens.return_value = 160000
        launcher.find_make_context.return_value = str(writer)
        launcher.skills_args.side_effect = runpy.run_path(str(HERE / 'claude-auto'))['skills_args']
        for policy, human in itertools.product(('none', 'other', 'all'), (True, False)):
            with self.subTest(policy=policy, human=human):
                self.s.owner, self.s.c.active = None, False
                transcript = root / 'config/projects/project' / (self.s.c.session + '.jsonl')
                transcript.parent.mkdir(parents=True, exist_ok=True)
                transcript.write_text('caveman\n')
                output = root / ('handoff-' + policy + '-' + str(human))
                launcher.handoff_dir.return_value = str(output)
                self.s.last_handoff = 0
                def write_note(command, **kwargs):
                    if command[-1] == '--list-skills':
                        return subprocess.CompletedProcess(command, 0,
                            'skill: caveman | 10 characters\nskill: other | 10 characters\n', '')
                    expected = {'none': ['--skills', 'caveman'],
                                'other': ['--skills', 'other,caveman'], 'all': []}[policy]
                    self.assertEqual(command[4:], expected)
                    output.mkdir()
                    (output / 'HANDOFF.md').write_text('## Skill-uri de încărcat din nou\n- caveman\n')
                    return subprocess.CompletedProcess(command, 0, '', '')
                with mock.patch.dict(os.environ, CLAUDE_CONFIG_DIR=str(root / 'config'),
                                     CLAUDE_AUTO_SKILLS=policy):
                    with mock.patch.object(managed.subprocess, 'run', side_effect=write_note):
                        self.s.rotate_if_needed()
                with mock.patch.object(self.s, 'owner_command', return_value=['claude']), \
                     mock.patch.object(managed, 'Process') as process:
                    self.s.start_owner('next request', human=human)
                prompt = process.call_args.args[1]
                self.assertIn(str(output / 'HANDOFF.md'), prompt)
                self.assertIn('Follow its skill-reload instructions', prompt)
                self.assertIn('historical transcript is context, not authorization', prompt)
                self.assertIn('do not repeat completed actions', prompt)
                self.assertIn('new human request' if human else 'automated notification', prompt)
                self.assertTrue(prompt.endswith('next request'))
                self.assertIsNone(self.s.note)

    def test_new_human_input_stops_help_but_waits_for_current_owner(self):
        helper, owner = mock.Mock(), mock.Mock()
        self.s.helper, self.s.owner = helper, owner
        self.s.input('new request')
        helper.stop.assert_called_once()
        owner.stop.assert_not_called()
        self.assertTrue(self.s.c.pending)
        self.assertEqual(list(self.s.prompts), ['new request'])
        self.assertIs(self.s.owner, owner)
        self.assertIsNone(self.s.helper)

    def test_owner_command_preserves_permissions_without_granting_tools(self):
        self.s.flags = ['--settings', '/provided/settings.json', '--permission-mode', 'default']
        self.s.bridge = mock.Mock(path='/private/socket')
        command = self.s.owner_command()
        self.assertEqual(command[1:5], self.s.flags)
        self.assertNotIn('--allowedTools', command)
        self.assertNotIn('--dangerously-skip-permissions', command)
        self.assertNotIn('--safe-mode', command)
        self.assertNotIn('--plugin-dir', command)
        self.assertEqual(command[command.index('--permission-prompts') + 1], 'none')
        self.assertNotIn('__hook', str(command))

    def test_cancelled_helper_exit_does_not_stop_owner(self):
        for good, cancellation in itertools.product((False, True), ('withdraw', 'prompt')):
            with self.subTest(good=good, cancellation=cancellation):
                task = self.peer.coordinate({'action': 'publish', 'title': 'Review', 'instructions': 'Evidence'})['task']
                self.s.claim = self.s.c.rpc('claim')['task']
                self.assertEqual(self.s.claim['task'], task['task'])
                process = mock.Mock(invalid=False, result={'type': 'result', 'subtype': 'success',
                                                          'is_error': False, 'result': 'late answer'})
                self.s.helper = process
                if cancellation == 'withdraw':
                    self.peer.rpc('withdraw', task=task['task'], reason='cancelled')
                else:
                    self.peer.admit('replacement work', lambda: None, lambda: None)
                self.s.exited(process, 0 if good else 1)
                process.stop.assert_called_once()
                self.assertIsNone(self.s.helper)
                self.assertIsNone(self.s.claim)
                self.assertTrue(self.s.c.healthy)
                self.assertEqual(self.s.status, 0)
                snapshot = self.s.c.rpc('snapshot')
                contribution = next(c for c in snapshot['contributions'] if c['task'] == task['task'])
                self.assertEqual(contribution['state'], 'cancelled')
                self.assertIsNone(contribution['result'])


class StreamTest(unittest.TestCase):
    def test_observed_metadata_and_nontext_are_not_rendered(self):
        for record in ({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': 'secret'}]}},
                       {'type': 'rate_limit_event'}, {'type': 'command_lifecycle'},
                       {'type': 'system', 'subtype': 'thinking_tokens'},
                       {'type': 'assistant', 'message': {'content': [{'type': 'thinking', 'thinking': 'secret'}]}},
                       {'type': 'assistant', 'parent_tool_use_id': 'child', 'message': {'content': [{'type': 'text', 'text': 'child'}]}}):
            self.assertEqual(managed.display_text(record), [])

    def test_assistant_text_variants(self):
        self.assertEqual(managed.display_text({'type': 'assistant', 'message': {'content': [
            {'type': 'text', 'text': 'hello'}, {'type': 'tool_use', 'name': 'Read'}, {'type': 'text', 'text': 'world'}]}}), ['hello', 'world'])
        self.assertEqual(managed.display_text({'type': 'assistant', 'message': {'content': 'plain'}}), ['plain'])

    def test_result_is_not_success_until_process_exits(self):
        record = {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'done'}
        for rc in (None, 1, -15):
            self.assertFalse(managed.succeeded(record, rc))
        self.assertTrue(managed.succeeded(record, 0))
        self.assertFalse(managed.succeeded(dict(record, stop_reason='tool_deferred'), 0))
        self.assertFalse(managed.succeeded(dict(record, is_error=True), 0))

    def test_fake_process_has_one_input_and_waited_exit(self):
        script = Path(self._testMethodName + '.py')
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / script
            script.write_text('import sys,json\nrows=list(sys.stdin)\nr=json.loads(rows[0])\nprint(json.dumps({"type":"result","subtype":"success","is_error":False,"result":r["message"]["content"]}))\n')
            events = queue.Queue()
            run = managed.Process([sys.executable, '-I', str(script)], 'hello', folder, events, 'owner')
            while True:
                kind, source, value = events.get(timeout=10)
                self.assertIs(source, run)
                if kind == 'exit':
                    self.assertEqual(value, 0)
                    self.assertEqual(run.result['result'], 'hello')
                    break
            run.stop()


class EntrypointTest(unittest.TestCase):
    def test_managed_launcher_and_real_stdio_bridge_without_hooks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fake = root / 'claude'
            fake.write_text('#!' + sys.executable + '\n' + '''import json,sys,subprocess
args=sys.argv[1:]
assert '-p' in args, args
assert '--permission-prompts' in args
assert args[args.index('--permission-prompts')+1]=='none'
assert '__hook' not in str(args) and 'ANCHOR_READY' not in str(args)
row=json.loads(sys.stdin.readline())
assert row['message']['content']=='do the work'
assert row['origin']=={'kind':'human'}
sid=args[args.index('--session-id')+1]
print(json.dumps({'type':'system','subtype':'init','session_id':sid,'model':'test-model'}),flush=True)
config=json.loads(args[args.index('--mcp-config')+1])['mcpServers']['apana-managed']
p=subprocess.Popen([config['command']]+config['args'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def call(value):
 p.stdin.write(json.dumps(value)+'\\n'); p.stdin.flush()
 return json.loads(p.stdout.readline())
call({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}}})
p.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\\n');p.stdin.flush()
r=call({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'coordinate','arguments':{'action':'publish','title':'Review','instructions':'Check supplied evidence'}}})
assert not r['result']['isError'],r
task=json.loads(r['result']['content'][0]['text'])['task']['task']
r=call({'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'coordinate','arguments':{'action':'withdraw','task':task,'rationale':'No longer needed'}}})
assert not r['result']['isError'],r
r=call({'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'coordinate','arguments':{'action':'finish'}}})
assert not r['result']['isError'],r
p.stdin.close();p.wait(timeout=5)
print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'MANAGED_DONE'}]}}),flush=True)
print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':'MANAGED_DONE'}),flush=True)
''')
            fake.chmod(0o755)
            env = dict(os.environ, CLAUDE_AUTO_CLAUDE=str(fake), CLAUDE_AUTO_DIR=str(root / 'notes'),
                       CLAUDE_AUTO_COOP_DB=str(root / 'registry.db'), CLAUDE_CONFIG_DIR=str(root / 'config'))
            for key in ('CLAUDE_AUTO_NEXT_ARGS', 'CLAUDE_AUTO_ANCHOR_ID'):
                env.pop(key, None)
            result = subprocess.run([sys.executable, str(HERE / 'claude-auto'), '--managed', '--', 'do the work'],
                                    input='', text=True, capture_output=True, env=env, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('MANAGED_DONE', result.stdout)
            members = managed.registry.dispatch(str(root / 'registry.db'), {'op': 'snapshot'})['members']
            self.assertEqual(len(members), 1)
            self.assertEqual(members[0]['owner_state'], 'idle')
            self.assertEqual(members[0]['status'], 'closed')
            self.assertEqual(list((root / 'notes').glob('**/settings*.json')), [])


if __name__ == '__main__':
    unittest.main()
