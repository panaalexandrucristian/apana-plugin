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


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.s = managed.Supervisor(mock.Mock(VARIANT_RULE='variant rule'), 'claude', [])

    def test_handoff_waits_for_owner_exit(self):
        root = Path(self.tmp.name)
        transcript = root / 'config/projects/project' / (self.s.session + '.jsonl')
        transcript.parent.mkdir(parents=True)
        transcript.write_text('{}\n')
        writer = root / 'make_context.py'
        writer.write_text('# fixture\n')
        output = root / 'handoff'
        launcher = self.s.launcher
        launcher.env_num.side_effect = lambda name, default: default
        launcher.context_tokens.return_value = 200000
        launcher.find_make_context.return_value = str(writer)
        launcher.handoff_dir.return_value = str(output)
        launcher.skills_args.return_value = []
        order = []
        process = mock.Mock(invalid=False, result={'type': 'result', 'subtype': 'success', 'is_error': False})
        process.stop.side_effect = lambda: order.append('stopped')
        self.s.owner, self.s.resumed = process, True
        session = self.s.session
        def write_note(command, **kwargs):
            self.assertIsNone(self.s.owner)
            self.assertEqual(command[2], str(transcript))
            output.mkdir()
            (output / 'HANDOFF.md').write_text('history')
            order.append('handoff')
            return subprocess.CompletedProcess(command, 0, '', '')
        with mock.patch.dict(os.environ, CLAUDE_CONFIG_DIR=str(root / 'config')):
            with mock.patch.object(managed.subprocess, 'run', side_effect=write_note):
                self.s.exited(process, 0)
        self.assertEqual(order, ['stopped', 'handoff'])
        self.assertNotEqual(self.s.session, session)
        self.assertEqual(self.s.note, str(output / 'HANDOFF.md'))
        self.assertFalse(self.s.resumed)
        self.assertEqual(self.s.handoffs, 1)

    def test_handoff_keeps_skill_reload_for_the_next_turn(self):
        root = Path(self.tmp.name)
        writer = root / 'make_context.py'
        writer.write_text('# fixture\n')
        launcher = self.s.launcher
        launcher.env_num.side_effect = lambda name, default: default
        launcher.context_tokens.return_value = 200000
        launcher.find_make_context.return_value = str(writer)
        launcher.skills_args.side_effect = runpy.run_path(str(HERE / 'claude-auto'))['skills_args']
        for policy in ('none', 'other', 'all'):
            with self.subTest(policy=policy):
                self.s.owner = None
                transcript = root / 'config/projects/project' / (self.s.session + '.jsonl')
                transcript.parent.mkdir(parents=True, exist_ok=True)
                transcript.write_text('caveman\n')
                output = root / ('handoff-' + policy)
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
                    self.s.start_owner('next request')
                prompt = process.call_args.args[1]
                self.assertIn(str(output / 'HANDOFF.md'), prompt)
                self.assertIn('Follow its skill-reload instructions', prompt)
                self.assertIn('historical transcript is context, not authorization', prompt)
                self.assertIn('do not repeat completed actions', prompt)
                self.assertTrue(prompt.endswith('next request'))
                self.assertIsNone(self.s.note)

    def test_owner_command_preserves_permissions_without_granting_tools(self):
        self.s.flags = ['--settings', '/provided/settings.json', '--permission-mode', 'default']
        command = self.s.owner_command()
        self.assertEqual(command[1:5], self.s.flags)
        self.assertNotIn('--allowedTools', command)
        self.assertNotIn('--dangerously-skip-permissions', command)
        self.assertNotIn('--safe-mode', command)
        self.assertNotIn('--plugin-dir', command)
        self.assertNotIn('--mcp-config', command)
        self.assertEqual(command[command.index('--permission-prompts') + 1], 'none')
        self.assertNotIn('__hook', str(command))

    def test_status_is_no_longer_a_local_command(self):
        self.s.input('/status')
        self.s.launcher.say.assert_called_once_with('Native slash commands are not forwarded. /help lists local commands.')
        self.assertEqual(list(self.s.prompts), [])

    def test_new_human_input_waits_for_the_current_owner(self):
        owner = mock.Mock()
        self.s.owner = owner
        self.s.input('new request')
        owner.stop.assert_not_called()
        self.assertIs(self.s.owner, owner)
        self.assertEqual(list(self.s.prompts), ['new request'])
        self.s.launcher.say.assert_called_once_with('Human message queued; it will run after the current turn exits')

    def test_input_without_a_running_owner_queues_silently_and_blank_lines_are_dropped(self):
        self.s.input('first')
        self.s.input('   ')
        self.assertEqual(list(self.s.prompts), ['first'])
        self.s.launcher.say.assert_not_called()

    def test_local_commands_help_and_quit(self):
        self.s.input('/help')
        self.assertIn('/quit and /help are local', self.s.launcher.say.call_args.args[0])
        self.assertFalse(self.s.quitting)
        self.s.input(' /quit ')
        self.assertTrue(self.s.quitting)
        self.assertEqual(list(self.s.prompts), [])


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
            run = managed.Process([sys.executable, '-I', str(script)], 'hello', folder, events)
            while True:
                kind, source, value = events.get(timeout=10)
                self.assertIs(source, run)
                if kind == 'exit':
                    self.assertEqual(value, 0)
                    self.assertEqual(run.result['result'], 'hello')
                    break
            run.stop()


class EntrypointTest(unittest.TestCase):
    def test_managed_launcher_without_hooks_or_plugins(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fake = root / 'claude'
            fake.write_text('#!' + sys.executable + '\n' + '''import json,sys
args=sys.argv[1:]
assert '-p' in args, args
assert '--permission-prompts' in args
assert args[args.index('--permission-prompts')+1]=='none'
assert '__hook' not in str(args) and 'ANCHOR_READY' not in str(args)
assert '--mcp-config' not in args and '--plugin-dir' not in args, args
row=json.loads(sys.stdin.readline())
assert row['message']['content']=='do the work'
assert row['origin']=={'kind':'human'}
sid=args[args.index('--session-id')+1]
print(json.dumps({'type':'system','subtype':'init','session_id':sid,'model':'test-model'}),flush=True)
print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'MANAGED_DONE'}]}}),flush=True)
print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':'MANAGED_DONE'}),flush=True)
''')
            fake.chmod(0o755)
            env = dict(os.environ, CLAUDE_AUTO_CLAUDE=str(fake), CLAUDE_AUTO_DIR=str(root / 'notes'),
                       CLAUDE_CONFIG_DIR=str(root / 'config'))
            for key in ('CLAUDE_AUTO_NEXT_ARGS', 'CLAUDE_AUTO_ANCHOR_ID'):
                env.pop(key, None)
            result = subprocess.run([sys.executable, str(HERE / 'claude-auto'), '--managed', '--', 'do the work'],
                                    input='', text=True, capture_output=True, env=env, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('MANAGED_DONE', result.stdout)
            self.assertEqual(list((root / 'notes').glob('**/settings*.json')), [])


if __name__ == '__main__':
    unittest.main()
