"""Offline regression tests. Never starts Claude or a provider proxy."""
import copy
import errno
from contextlib import contextmanager, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest import mock

import live_check as live
import live_pty_check as pty_live


def result(text, **extra):
    return {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': text, **extra}


def assistant(text, **extra):
    return {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn'}, **extra}


class Records(unittest.TestCase):
    def test_setup_barrier_requires_exact_successful_result_not_assistant_or_idle(self):
        self.assertIsNone(live.successful_result([assistant('READY')], 'READY'))
        self.assertIsNone(live.successful_result([result('READY\n\nI ignored the next task.')], 'READY'))
        self.assertIsNone(live.successful_result([result('not READY')], 'READY'))
        self.assertIsNotNone(live.successful_result([result(' READY\n')], 'READY'))

    def test_result_scope_error_and_cursor_combinations(self):
        for parent in (None, 'subagent'):
            for error in (False, True):
                with self.subTest(parent=parent, error=error):
                    record = result('READY', parent_tool_use_id=parent, is_error=error)
                    self.assertEqual(live.successful_result([record], 'READY') is not None,
                                     parent is None and not error)
        self.assertIsNone(live.successful_result([result('READY')], 'READY', after=1))
        self.assertIsNone(live.successful_result([result('READY', subtype='error_max_turns')], 'READY'))

    def test_transcript_match_ignores_echoes_tools_thinking_sidechains_and_prose(self):
        records = [
            {'type': 'user', 'message': {'content': 'READY'}},
            {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': 'READY'}]}},
            {'type': 'assistant', 'message': {'content': [{'type': 'thinking', 'thinking': 'READY'}]}},
            {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'input': {'text': 'READY'}}]}},
            assistant('READY', isSidechain=True), assistant('READY', parent_tool_use_id='nested'),
            assistant('I cannot reply READY'), {'type': 'attachment', 'text': 'READY'},
        ]
        self.assertFalse(live.has_answer(records, 'READY'))
        self.assertTrue(live.has_answer(records + [assistant('READY')], 'READY'))

    def test_tool_calls_require_top_level_assistant_named_tool_and_input_object(self):
        call = {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'python3 -I test_gate.py'}}]}}
        self.assertEqual(live.tool_calls([call], 'Bash'), [{'command': 'python3 -I test_gate.py'}])
        self.assertEqual(live.tool_calls([call], 'Edit'), [])
        self.assertEqual(live.tool_calls([call], 'Bash', after=1), [])
        for changes in ({'type': 'user'}, {'isSidechain': True}, {'parent_tool_use_id': 'nested'}):
            self.assertEqual(live.tool_calls([dict(call, **changes)], 'Bash'), [])
        invalid = copy.deepcopy(call)
        invalid['message']['content'][0]['input'] = 'not-an-object'
        self.assertEqual(live.tool_calls([invalid], 'Bash'), [])

    def test_isolation_rejects_leak_in_either_direction_and_requires_private_deliverable(self):
        live.assert_isolation('private-owner', 'private-help', 'private-help: 323', [assistant('NO_PEER_CONTEXT')])
        with self.assertRaises(AssertionError):
            live.assert_isolation('private-owner', 'private-help', 'private-owner private-help 323', [])
        with self.assertRaises(AssertionError):
            live.assert_isolation('private-owner', 'private-help', 'private-help 323', [assistant('private-help')])
        with self.assertRaises(AssertionError):
            live.assert_isolation('private-owner', 'private-help', '323', [])

    def test_acceptance_is_bound_to_exact_attempt_owner_task_and_revision(self):
        task = {'task': 'task', 'owner': 'owner', 'owner_revision': 7}
        contribution = {'contribution': 'attempt', 'task': 'task', 'contributor': 'peer', 'state': 'completed', 'result': '323'}
        decision = {'contribution': 'attempt', 'task': 'task', 'owner': 'owner', 'owner_revision': 7,
                    'contributor': 'peer', 'verdict': 'accept'}
        live.assert_attribution(task, contribution, decision, 'peer')
        for key, value in [('contribution', 'other'), ('task', 'other'), ('owner', 'other'),
                           ('owner_revision', 8), ('contributor', 'other'), ('verdict', 'reject')]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                live.assert_attribution(task, contribution, dict(decision, **{key: value}), 'peer')


class RotationContext(unittest.TestCase):
    def records(self, path, *, error=True, source='top-level'):
        call = {'type': 'assistant', 'message': {'content': [
            {'type': 'tool_use', 'id': 'fixture-read', 'name': 'Read',
             'input': {'file_path': str(path), 'offset': 1, 'limit': 150}}]}}
        reply = {'type': 'user', 'message': {'content': [
            {'type': 'tool_result', 'tool_use_id': 'fixture-read',
             'is_error': error, 'content': 'fixture content or tool error'}]}}
        if source == 'sidechain':
            call['isSidechain'] = reply['isSidechain'] = True
        elif source == 'api-copy':
            call['type'] = reply['type'] = 'api-request-blob'
        return [call, reply]

    def test_owner_prompt_explains_hold_and_preserves_delegation_on_unclaimed_notice(self):
        with tempfile.TemporaryDirectory() as directory:
            owner, helper = mock.Mock(cwd=Path(directory)), mock.Mock()
            check = pty_live.Check.__new__(pty_live.Check)
            check.root, check.database, check.openai_state = Path(directory), Path(directory) / 'db', None
            check.clients = []
            check.wait = mock.Mock(side_effect=[{'provider': 'direct'}, {'provider': 'other'}, True,
                                               RuntimeError('prompt captured')])
            with mock.patch.object(pty_live, 'Interactive', side_effect=[owner, helper]):
                with self.assertRaisesRegex(RuntimeError, 'prompt captured'):
                    check.run('direct', 'other', 20000)
            prompt = owner.send.call_args.args[0]
            self.assertIn('helper is deliberately held busy', prompt)
            self.assertIn('Do not withdraw or finish on an unclaimed notification', prompt)
            self.assertIn('released automatically after rotation', prompt)
            self.assertIn('deliberately interrupt the first helper attempt with a new composer prompt', prompt)
            self.assertIn('automatically re-claim the same delegation', prompt)
            self.assertIn('Do not withdraw or finish because an earlier attempt was cancelled', prompt)
            self.assertIn('offset 151, limit 150', prompt)

    def test_pre_rotation_withdrawal_is_reported_without_waiting_for_generation(self):
        check = pty_live.Check.__new__(pty_live.Check)
        check.wait = lambda predicate, description: predicate({
            'tasks': [{'task': 'delegation', 'state': 'withdrawn'}]})
        check.member = mock.Mock(return_value={'generation': 1})
        with self.assertRaisesRegex(AssertionError, 'Delegation left queued state while awaiting rotation: withdrawn'):
            check.wait_for_rotation(mock.Mock(), {'generation': 1}, Path('/fixture'), 'delegation')

    def test_rotation_prompt_uses_bounded_reads_covering_the_fixture(self):
        prompt = pty_live.rotation_read_prompt(Path('/fixture/rotation-context.txt'))
        for offset in (1, 151, 301, 451):
            self.assertIn(f'offset {offset}, limit 150', prompt)
        self.assertNotIn('limit 600', prompt)
        self.assertIn('Stop loading filler after a context handoff', prompt)

    def test_fixture_result_source_path_and_error_combinations(self):
        path = Path('/fixture/rotation-context.txt')
        for source in ('top-level', 'sidechain', 'api-copy'):
            for same_path in (False, True):
                for error in (False, True):
                    with self.subTest(source=source, same_path=same_path, error=error):
                        records = self.records(path if same_path else path.with_name('other.txt'),
                                               error=error, source=source)
                        if source == 'top-level' and same_path and error:
                            with self.assertRaisesRegex(AssertionError, 'Context-loading failed'):
                                pty_live.successful_context_reads(records, path)
                        else:
                            self.assertEqual(pty_live.successful_context_reads(records, path),
                                             int(source == 'top-level' and same_path and not error))

    def test_pending_call_is_not_success_and_absent_error_field_is_success(self):
        path = Path('/fixture/rotation-context.txt')
        records = self.records(path, error=False)
        self.assertEqual(pty_live.successful_context_reads(records[:1], path), 0)
        del records[1]['message']['content'][0]['is_error']
        self.assertEqual(pty_live.successful_context_reads(records, path), 1)
        records[1]['message']['content'][0]['tool_use_id'] = 'unrelated'
        self.assertEqual(pty_live.successful_context_reads(records, path), 0)

    def test_only_pretool_hook_denial_with_prepared_handoff_is_expected(self):
        path = Path('/fixture/rotation-context.txt')
        for pending in (False, True):
            for source in ('config', 'hook'):
                for code in ('hook:PreToolUse', 'other'):
                    with self.subTest(pending=pending, source=source, code=code):
                        records = self.records(path)
                        records[1]['permissionDecision'] = {
                            'decision': 'reject', 'source': source, 'reasonCode': code}
                        if pending and source == 'hook' and code == 'hook:PreToolUse':
                            self.assertEqual(pty_live.successful_context_reads(records, path,
                                                                              handoff_pending=pending), 0)
                        else:
                            with self.assertRaisesRegex(AssertionError, 'Context-loading failed'):
                                pty_live.successful_context_reads(records, path, handoff_pending=pending)

    def test_rotation_wait_checks_loading_errors_before_generation(self):
        path = Path('/fixture/rotation-context.txt')
        check = pty_live.Check.__new__(pty_live.Check)
        owner = mock.Mock(notes=path.parent / 'handoffs')
        owner.records.return_value = self.records(path)
        check.wait = lambda predicate, description: predicate({'tasks': [{'task': 'delegation', 'state': 'queued'}]})
        check.member = mock.Mock(return_value={'generation': 2})
        with self.assertRaisesRegex(AssertionError, 'Context-loading failed'):
            check.wait_for_rotation(owner, {'generation': 1}, path, 'delegation')
        check.member.assert_not_called()

    def test_rotation_wait_requires_both_loaded_context_and_new_generation(self):
        path = Path('/fixture/rotation-context.txt')
        for loaded in (False, True):
            for generation in (1, 2):
                with self.subTest(loaded=loaded, generation=generation):
                    check = pty_live.Check.__new__(pty_live.Check)
                    owner = mock.Mock(notes=path.parent / 'handoffs')
                    owner.records.return_value = self.records(path, error=False) if loaded else []
                    check.wait = lambda predicate, description: predicate({'tasks': [{'task': 'delegation', 'state': 'queued'}]})
                    member = {'generation': generation}
                    check.member = mock.Mock(return_value=member)
                    observed = check.wait_for_rotation(owner, {'generation': 1}, path, 'delegation')
                    self.assertEqual(observed, member if loaded and generation > 1 else None)


class CollaborationCompletion(unittest.TestCase):
    def setUp(self):
        self.task = {'task': 'delegation', 'owner': 'owner', 'owner_revision': 1}
        self.check = pty_live.Check.__new__(pty_live.Check)

    def observe(self, state):
        self.check.wait = lambda predicate, description, **kwargs: predicate(state)
        return self.check.wait_for_completion(self.task, 'peer')

    def state(self, task_state='queued', owner_state='active', contribution=None):
        return {'tasks': [dict(self.task, state=task_state)],
                'own_tasks': [{'member': 'owner', 'revision': 1, 'state': owner_state},
                              {'member': 'owner', 'revision': 0, 'state': 'superseded'},
                              {'member': 'peer', 'revision': 1, 'state': 'done'}],
                'contributions': [contribution] if contribution else []}

    def test_delegation_owner_and_result_attribution_combinations(self):
        completed = {'task': 'delegation', 'contributor': 'peer', 'state': 'completed'}
        for task_state in ('queued', 'claimed', 'withdrawn', 'cancelled'):
            for owner_state in ('active', 'done', 'superseded'):
                for scope in ('absent', 'matching', 'other-task', 'other-peer'):
                    with self.subTest(task=task_state, owner=owner_state, scope=scope):
                        contribution = None if scope == 'absent' else dict(completed)
                        if scope == 'other-task':
                            contribution['task'] = 'other'
                        if scope == 'other-peer':
                            contribution['contributor'] = 'other'
                        state = self.state(task_state, owner_state, contribution)
                        if task_state in ('withdrawn', 'cancelled'):
                            with self.assertRaisesRegex(AssertionError, 'Delegation ended before collaboration completed: ' + task_state):
                                self.observe(state)
                        elif scope == 'matching':
                            self.assertEqual(self.observe(state), contribution)
                        elif owner_state != 'active':
                            with self.assertRaisesRegex(AssertionError, 'Owner task ended without a completed peer contribution: ' + owner_state):
                                self.observe(state)
                        else:
                            self.assertIsNone(self.observe(state))

    def test_cancelled_attempt_allows_reclaim_but_withdrawal_fails_immediately(self):
        cancelled = {'task': 'delegation', 'contributor': 'peer', 'state': 'cancelled',
                     'reason': 'user-prompt', 'contribution': 'first'}
        state = self.state(contribution=cancelled)
        self.assertIsNone(self.observe(state))
        retry = dict(cancelled, contribution='retry', state='claimed', reason=None)
        state['contributions'].append(retry)
        state['tasks'][0]['state'] = 'claimed'
        self.assertIsNone(self.observe(state))
        retry.update(state='cancelled', reason='withdrawn')
        state['tasks'][0]['state'] = 'withdrawn'
        with self.assertRaisesRegex(AssertionError, 'Delegation ended before collaboration completed: withdrawn'):
            self.observe(state)

    def test_already_accepted_result_survives_owner_finishing_between_polls(self):
        contribution = {'task': 'delegation', 'contributor': 'peer', 'state': 'completed'}
        self.assertEqual(self.observe(self.state('accepted', 'done', contribution)), contribution)

    def test_missing_delegation_or_matching_owner_revision_is_diagnosed(self):
        state = self.state()
        state['tasks'] = [dict(self.task, task='other', state='queued')]
        with self.assertRaisesRegex(AssertionError, 'Published delegation disappeared'):
            self.observe(state)
        state = self.state()
        state['own_tasks'].pop(0)
        with self.assertRaisesRegex(AssertionError, 'Owner task revision disappeared'):
            self.observe(state)


class FinishedOwner(unittest.TestCase):
    def records(self, *, error=False, session='current', source='top-level'):
        call = {'type': 'assistant', 'sessionId': session, 'message': {'content': [
            {'type': 'tool_use', 'id': 'finish', 'name': pty_live.TOOL, 'input': {'action': 'finish'}}]}}
        reply = {'type': 'user', 'sessionId': session, 'message': {'content': [
            {'type': 'tool_result', 'tool_use_id': 'finish', 'is_error': error, 'content': '{}'}]}}
        if source == 'sidechain':
            call['isSidechain'] = reply['isSidechain'] = True
        elif source == 'api-copy':
            call['type'] = reply['type'] = 'api-request-blob'
        elif source == 'nested':
            call['parent_tool_use_id'] = reply['parent_tool_use_id'] = 'parent'
        return [assistant('Old answer', sessionId='current'), call, reply,
                assistant('PTY_COLLABORATION_OK_323\n\nExtra explanation', sessionId='current')]

    def test_finish_provenance_session_and_result_combinations(self):
        for source in ('top-level', 'sidechain', 'api-copy', 'nested'):
            for session in ('current', 'old'):
                for error in (False, True):
                    with self.subTest(source=source, session=session, error=error):
                        answer = pty_live.finished_owner_answer(self.records(source=source, session=session, error=error), 'current')
                        self.assertEqual(answer is not None, source == 'top-level' and session == 'current' and not error)
        records = self.records()
        del records[2]['message']['content'][0]['is_error']
        self.assertIsNotNone(pty_live.finished_owner_answer(records, 'current'))

    def test_answer_requires_successful_matching_finish_then_top_level_terminal_text(self):
        records = self.records()
        self.assertIsNone(pty_live.finished_owner_answer(records[:-1], 'current'))
        for record, updates in ((1, {'type': 'user'}), (2, {'type': 'assistant'}),
                                (3, {'type': 'user'}), (3, {'sessionId': 'old'}),
                                (3, {'isSidechain': True}), (3, {'parent_tool_use_id': 'nested'})):
            changed = copy.deepcopy(records)
            changed[record].update(updates)
            with self.subTest(record=record, updates=updates):
                self.assertIsNone(pty_live.finished_owner_answer(changed, 'current'))
        for index, key, value in ((1, 'name', 'Other'), (1, 'input', {'action': 'status'}),
                                  (2, 'tool_use_id', 'other')):
            changed = copy.deepcopy(records)
            changed[index]['message']['content'][0][key] = value
            self.assertIsNone(pty_live.finished_owner_answer(changed, 'current'))
        records[-1]['message']['stop_reason'] = 'tool_use'
        self.assertIsNone(pty_live.finished_owner_answer(records, 'current'))

    def test_completed_ledger_and_terminal_answer_are_required_but_format_is_separate(self):
        task = {'owner': 'owner', 'owner_revision': 1}
        for idle in (False, True):
            for done in (False, True):
                for exact in (False, True):
                    with self.subTest(idle=idle, done=done, exact=exact):
                        check = pty_live.Check.__new__(pty_live.Check)
                        check.observations = []
                        check.member = mock.Mock(return_value={'member': 'owner', 'session': 'current', 'owner_state': 'idle' if idle else 'active'})
                        state = {'own_tasks': [{'member': 'owner', 'revision': 1, 'state': 'done' if done else 'active'}]}
                        def wait(predicate, description):
                            answer = predicate(state)
                            if answer is None:
                                raise TimeoutError('not finished')
                            return answer
                        check.wait = wait
                        owner = mock.Mock()
                        records = self.records()
                        if exact:
                            records[-1] = assistant('PTY_COLLABORATION_OK_323', sessionId='current')
                        owner.records.return_value = records
                        with redirect_stdout(io.StringIO()):
                            if idle and done:
                                check.wait_for_owner_finish(owner, task)
                                self.assertEqual(check.observations[-1]['passed'], exact)
                            else:
                                with self.assertRaisesRegex(TimeoutError, 'not finished'):
                                    check.wait_for_owner_finish(owner, task)
                                self.assertEqual(check.observations, [])


class FixtureDialogs(unittest.TestCase):
    def test_real_absolute_column_theme_variant_and_plain_variant(self):
        # Verbatim relevant escape sequence from the first real PTY capture.
        observed = b'\x1b[2G\x1b[1mChoose\x1b[9Gthe\x1b[13Gtext\x1b[18Gstyle\x1b[24Gthat\x1b[22m\r\r\n'
        self.assertEqual(pty_live.fixture_dialogs(observed), {'theme'})
        self.assertEqual(pty_live.fixture_dialogs(b'Choose the text style'), {'theme'})
        self.assertEqual(pty_live.fixture_dialogs(b'Yes, I trust this folder'), set())

    def test_trust_dialog_selects_yes_in_our_fresh_fixture_before_enter(self):
        observed = ('\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n'
                    '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder').encode()
        self.assertEqual(pty_live.fixture_dialogs(observed), {'trust'})
        for incomplete in ('❯ No, exit', 'No, exit\nYes, I trust this folder',
                           'No, exit\n❯ Yes, I trust this folder'):
            with self.subTest(incomplete=incomplete):
                self.assertEqual(pty_live.fixture_dialogs(incomplete.encode()), set())
        client = pty_live.Interactive.__new__(pty_live.Interactive)
        client.buffer = bytearray(observed)
        client.dialogs, client.events, client.fd = set(), io.StringIO(), 123456
        client.startup_complete = False
        client.trust_frame = None
        with mock.patch.object(pty_live.os, 'write') as write, mock.patch.object(pty_live.time, 'sleep'), \
                mock.patch.object(pty_live.time, 'monotonic', side_effect=[0, 1, 2, 3, 4]):
            client.acknowledge_fixture_dialogs()
            client.acknowledge_fixture_dialogs()
            write.assert_not_called()
            client.buffer.extend(b'\x1b[?2026l')
            client.acknowledge_fixture_dialogs()
            client.acknowledge_fixture_dialogs()
            write.assert_not_called()
            client.acknowledge_fixture_dialogs()
            client.acknowledge_fixture_dialogs()
        self.assertEqual(write.call_args_list, [mock.call(client.fd, b'\x1b[B'), mock.call(client.fd, b'\r')])

    def test_real_security_notice_requires_both_title_and_continue_prompt(self):
        observed = ('\x1b[1mSecurity notes:\x1b[22m\x1b[K\r\x1b[1C\x1b[2B'
                    'Claude can make mistakes.\r\x1b[1C\x1b[1B'
                    '\x1b[38;2;177;185;249mPress \x1b[1mEnter\x1b[22m to continue…\x1b[39m').encode()
        self.assertEqual(pty_live.fixture_dialogs(observed), {'security-notice'})
        self.assertEqual(pty_live.fixture_dialogs(b'Security notes:'), set())
        self.assertEqual(pty_live.fixture_dialogs('Press Enter to continue…'.encode()), set())

    def test_dialog_match_does_not_join_rows_vertical_moves_or_terminal_titles(self):
        for data in (b'Choose the\ntext style', b'Choose the\x1b[1Atext style',
                     b'\x1b]0;Choose the text style\x07', b'Not logged in; run /login'):
            with self.subTest(data=data):
                self.assertEqual(pty_live.fixture_dialogs(data), set())

    def test_acknowledges_only_once_and_never_after_session_registration(self):
        client = pty_live.Interactive.__new__(pty_live.Interactive)
        client.buffer = bytearray(b'Choose\x1b[9Gthe\x1b[13Gtext\x1b[18Gstyle')
        client.dialogs, client.events, client.fd = set(), io.StringIO(), 123456
        client.startup_complete = False
        with mock.patch.object(pty_live.os, 'write') as write:
            client.acknowledge_fixture_dialogs()
            client.acknowledge_fixture_dialogs()
            write.assert_called_once_with(client.fd, b'\r')
            client.startup_complete = True
            client.buffer.extend(b'\nYes, I trust this folder')
            client.acknowledge_fixture_dialogs()
            self.assertEqual(write.call_count, 1)


class TerminalCleanup(unittest.TestCase):
    def test_closed_slave_during_either_quit_key_still_reaps_and_cleans(self):
        for writes in ([OSError(errno.EIO, 'closed slave')], [1, OSError(errno.EIO, 'closed slave')]):
            with self.subTest(writes=len(writes)):
                client = pty_live.Interactive.__new__(pty_live.Interactive)
                client.fd, client.root = 17, Path('/fixture/client')
                client.reader, client.raw, client.events = mock.Mock(), mock.Mock(), mock.Mock()
                client.alive = mock.Mock(side_effect=[True, False, False, False, False])
                with mock.patch.object(pty_live.os, 'write', side_effect=writes), mock.patch.object(pty_live.os, 'close') as close, mock.patch.object(pty_live.time, 'sleep'), mock.patch.object(pty_live, 'stop_recorded_proxy') as stop_proxy:
                    client.stop()
                self.assertTrue(client.stopped)
                client.reader.join.assert_called_once()
                close.assert_called_once_with(client.fd)
                client.raw.close.assert_called_once()
                client.events.close.assert_called_once()
                stop_proxy.assert_called_once_with(client.root)

    def test_other_terminal_write_errors_are_not_hidden(self):
        client = pty_live.Interactive.__new__(pty_live.Interactive)
        client.fd = 17
        client.alive = mock.Mock(return_value=True)
        with mock.patch.object(pty_live.os, 'write', side_effect=OSError(errno.EBADF, 'bad descriptor')):
            with self.assertRaises(OSError) as caught:
                client.stop()
        self.assertEqual(caught.exception.errno, errno.EBADF)


class Isolation(unittest.TestCase):
    def test_help_and_live_gate_work_under_isolated_python_from_unrelated_cwd(self):
        with tempfile.TemporaryDirectory() as directory:
            for path in (Path(live.__file__), Path(pty_live.__file__)):
                help_run = subprocess.run([sys.executable, '-I', '-B', str(path), '--help'], cwd=directory, capture_output=True, text=True)
                self.assertEqual(help_run.returncode, 0, help_run.stderr)
                gate_run = subprocess.run([sys.executable, '-I', '-B', str(path)], cwd=directory, capture_output=True, text=True)
                self.assertEqual(gate_run.returncode, 2)
                self.assertIn('--run-live is required', gate_run.stderr)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_session_tool_scope_is_explicit_and_send_returns_stream_cursor(self):
        with tempfile.TemporaryDirectory() as directory:
            process = mock.Mock()
            process.poll.return_value = 0
            with mock.patch.object(live.subprocess, 'Popen', return_value=process) as popen, mock.patch.object(live.shutil, 'which', return_value='/fake/claude'), mock.patch.object(live.threading, 'Thread'):
                client = live.Session(Path(directory), 'owner', Path(directory) / 'db', tools='Read,Edit,Bash',
                                      allowed_tools=[live.TOOL, 'Read', 'Edit', 'Bash(python3 -I test_gate.py)'])
                argv = popen.call_args.args[0]
                self.assertEqual(argv[argv.index('--tools') + 1], 'Read,Edit,Bash')
                self.assertIn('Bash(python3 -I test_gate.py)', argv)
                self.assertEqual(argv[argv.index('--permission-mode') + 1], 'dontAsk')
                self.assertEqual(popen.call_args.kwargs['env']['HOME'], str(client.root / 'home'))
                client.records.append(result('SETUP'))
                self.assertEqual(client.send('new task'), 1)
                client.stop()

    def test_settings_mismatch_turns_otherwise_successful_pty_run_into_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / 'home'
            (home / '.claude').mkdir(parents=True)
            settings = home / '.claude/settings.json'
            settings.write_text('{}')
            evidence = Path(directory) / 'evidence'
            check = mock.Mock(stage='complete', observations=[])
            def finished(*args):
                settings.write_text('{"changed":true}')
                return {}
            check.run.side_effect = finished
            with mock.patch.object(pty_live.Path, 'home', return_value=home), mock.patch.object(pty_live, 'Check', return_value=check), mock.patch.object(pty_live, 'clone_openai_state'), mock.patch.object(sys, 'argv', ['live_pty_check.py', '--run-live', '--root', str(evidence)]), redirect_stdout(io.StringIO()):
                previous_umask = os.umask(0o077)
                try:
                    self.assertEqual(pty_live.main(), 1)
                finally:
                    os.umask(previous_umask)
            report = json.loads((evidence / 'observations.json').read_text())
            self.assertFalse(report['passed'])
            self.assertFalse(report['global_settings_unchanged'])

    def test_format_failure_keeps_overall_failure_after_remaining_checks_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory) / 'evidence'
            observations = [{'check': 'owner final answer is exact marker', 'passed': False},
                            {'check': 'bidirectional context output probes', 'passed': True}]
            check = mock.Mock(stage='complete', observations=observations)
            check.run.return_value = {}
            with mock.patch.object(pty_live, 'Check', return_value=check), mock.patch.object(pty_live, 'clone_openai_state'), mock.patch.object(sys, 'argv', ['live_pty_check.py', '--run-live', '--root', str(evidence)]), redirect_stdout(io.StringIO()):
                previous_umask = os.umask(0o077)
                try:
                    self.assertEqual(pty_live.main(), 1)
                finally:
                    os.umask(previous_umask)
            report = json.loads((evidence / 'observations.json').read_text())
            self.assertFalse(report['passed'])
            self.assertEqual(report['stage'], 'complete')
            self.assertEqual(report['failed_checks'], ['owner final answer is exact marker'])
            self.assertTrue(report['observations'][-1]['passed'])
            check.close.assert_called_once()

    def test_settings_digest_detects_modification_creation_and_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'settings.json'
            missing = live.settings_digest(path)
            path.write_text('{}')
            before = live.settings_digest(path)
            self.assertNotEqual(missing, before)
            live.assert_settings_unchanged(path, before)
            path.write_text('{"model":"other"}')
            with self.assertRaises(AssertionError):
                live.assert_settings_unchanged(path, before)
            path.unlink()
            with self.assertRaises(AssertionError):
                live.assert_settings_unchanged(path, before)

    def test_clean_environment_isolates_home_config_and_provider_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.dict(os.environ, {'ANTHROPIC_DEFAULT_FABLE_MODEL': 'bad', 'CLAUDE_AUTO_NEXT_ARGS': 'bad',
                                              'CLAUDE_CODE_USE_VERTEX': '1', 'CLAUDE_CONFIG_DIR': '/bad',
                                              'CLAUDE_CODE_CHILD_SESSION': '1'}, clear=True):
                env = live.clean_env(root)
            self.assertEqual(env['HOME'], str(root / 'home'))
            self.assertEqual(env['CLAUDE_CONFIG_DIR'], str(root / 'home/.claude'))
            for key in ('ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_AUTO_NEXT_ARGS', 'CLAUDE_CODE_USE_VERTEX',
                        'CLAUDE_CODE_CHILD_SESSION'):
                self.assertNotIn(key, tuple(env))
            self.assertTrue((root / 'home/.claude').is_dir())

    def test_plugin_default_is_checkout_bundle(self):
        self.assertEqual(live.PLUGIN, live.REPO / 'skills/install-claude-auto/assets/cooperation')

    def test_clone_auth_is_private_read_only_source_and_uses_no_source_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            (source / 'auth').mkdir(parents=True)
            credential = source / 'auth/account.json'
            credential.write_text(json.dumps({'type': 'codex', 'access_token': 'TEST_SECRET_ONLY', 'refresh_token': 'REFRESH'}))
            credential.chmod(0o644)
            config = source / 'proxy.json'
            config.write_text(json.dumps({'config-version': 8, 'oauth': {'auth-dir': str(source / 'auth')},
                                          'plugins': {'enabled': True}, 'unknown': {'output': '/outside'}}))
            before = {p: (p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns) for p in (credential, config)}
            clone = pty_live.clone_openai_state(source, root / 'private')
            for path, expected in before.items():
                self.assertEqual((path.read_bytes(), path.stat().st_mode, path.stat().st_mtime_ns), expected)
            cloned_config = json.loads((clone / 'proxy.json').read_text())
            self.assertEqual(cloned_config['oauth']['auth-dir'], str(clone / 'auth'))
            self.assertFalse(cloned_config['plugins']['enabled'])
            self.assertNotIn('unknown', cloned_config)
            self.assertEqual(clone.stat().st_mode & 0o777, 0o700)
            for path in clone.rglob('*'):
                if path.is_file():
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_missing_invalid_and_symlinked_auth_fail_closed(self):
        for kind in ('missing', 'invalid', 'wrong-provider', 'symlink'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / 'source'
                (source / 'auth').mkdir(parents=True)
                (source / 'proxy.json').write_text('{}')
                path = source / 'auth/account.json'
                if kind == 'invalid':
                    path.write_text('invalid')
                elif kind == 'wrong-provider':
                    path.write_text('{"type":"other","access_token":"not-codex"}')
                elif kind == 'symlink':
                    target = root / 'secret'
                    target.write_text('{"type":"codex","access_token":"private"}')
                    path.symlink_to(target)
                with self.assertRaises((RuntimeError, ValueError)):
                    pty_live.clone_openai_state(source, root / 'private')

    def test_private_openai_entrypoint_has_no_installed_launcher_or_login(self):
        with mock.patch.object(pty_live, 'load_openai_module') as load:
            module = load.return_value
            module.codex_credentials.return_value = []
            with self.assertRaisesRegex(RuntimeError, 'authentication'):
                pty_live.run_openai_child(Path('/private/state'), Path('/private/client'), 'model', [])
            module.login.assert_not_called()
            module.configure.assert_not_called()
            module.proxy_session.assert_not_called()

    def test_proxy_pid_is_recorded_before_readiness_failure_and_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state, client = root / 'state', root / 'client'
            (state / 'auth').mkdir(parents=True)
            client.mkdir()
            (state / 'harness-owned.json').write_text('{"purpose":"disposable-live-cooperation-auth"}')
            (state / 'proxy.json').write_text(json.dumps({'oauth': {'auth-dir': str(state / 'auth')}}))
            proxy = mock.Mock(pid=123456)
            proxy.poll.side_effect = [None, 0]
            module = mock.Mock()
            module.codex_credentials.return_value = ['private-fixture']
            module.subprocess = mock.Mock()
            module.subprocess.Popen.return_value = proxy
            @contextmanager
            def failing_startup(private_state):
                module.subprocess.Popen(['fake-proxy', '-config', str(state / 'session/proxy.json')])
                self.assertEqual(json.loads((client / 'proxy-process.json').read_text())['pid'], proxy.pid)
                raise RuntimeError('readiness failed')
                yield  # pragma: no cover
            module.proxy_session = failing_startup
            with mock.patch.object(pty_live, 'load_openai_module', return_value=module), mock.patch.object(pty_live.shutil, 'which', return_value='/fake/claude'), mock.patch.object(pty_live.signal, 'signal'):
                with self.assertRaisesRegex(RuntimeError, 'readiness failed'):
                    pty_live.run_openai_child(state, client, 'model', [])
            proxy.terminate.assert_called_once()
            self.assertTrue(json.loads((client / 'proxy-process.json').read_text())['stopped'])
            module.login.assert_not_called()

    def test_stage_survives_timeout_and_cleanup_attempts_all_clients(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            check = pty_live.Check(root, -1, root / 'state')
            with self.assertRaisesRegex(AssertionError, 'publication'):
                check.wait(lambda state: False, 'publication')
            self.assertEqual(check.stage, 'publication')
            first, second = mock.Mock(), mock.Mock()
            first.root, second.root = root / 'one', root / 'two'
            second.stop.side_effect = RuntimeError('terminal cleanup failed')
            check.clients = [first, second]
            with self.assertRaisesRegex(RuntimeError, 'terminal cleanup failed'):
                check.close()
            first.stop.assert_called_once()
            second.stop.assert_called_once()

    def test_proxy_cleanup_refuses_reused_pid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'proxy-process.json').write_text(json.dumps({'pid': 123456, 'config': str(root / 'proxy.json'), 'stopped': False}))
            with mock.patch.object(pty_live.subprocess, 'run', return_value=mock.Mock(stdout='unrelated-process', returncode=0)), mock.patch.object(pty_live.os, 'kill') as kill:
                with self.assertRaisesRegex(RuntimeError, 'identity'):
                    pty_live.stop_recorded_proxy(root)
                kill.assert_not_called()


if __name__ == '__main__':
    unittest.main()
