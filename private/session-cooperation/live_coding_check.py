#!/usr/bin/env python3
"""Opt-in real coding collaboration in a disposable, retained workspace."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote


HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parents[1] / 'skills/install-claude-auto/assets/cooperation'
TOOL = 'mcp__apana-cooperation__coordinate'
BROKEN_GATE = '''def accepts_result(owner_revision, result_revision, cancelled):
    return owner_revision == result_revision or not cancelled
'''
GATE_TEST = '''import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class ResultGateTests(unittest.TestCase):
    def test_all_revision_and_cancellation_combinations(self):
        for owner in (7, 8):
            for result in (7, 8):
                for cancelled in (False, True):
                    with self.subTest(owner=owner, result=result, cancelled=cancelled):
                        expected = owner == result and not cancelled
                        self.assertIs(gate.accepts_result(owner, result, cancelled), expected)

if __name__ == '__main__':
    unittest.main()
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def snapshot(database):
    if not database.exists():
        return {}
    with closing(sqlite3.connect('file:' + quote(str(database)) + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        return {table: [dict(row) for row in db.execute('SELECT * FROM ' + table)]
                for table in ('members', 'own_tasks', 'tasks', 'contributions', 'decisions')}


def wait_for(check, label, timeout):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError('Timed out: ' + label)


def run_fixture(workspace, log):
    result = subprocess.run(['python3', '-I', 'test_gate.py'], cwd=workspace,
                            text=True, capture_output=True, timeout=30)
    log.write_text(result.stdout + result.stderr)
    return result.returncode


def completed_owner(state, member, revision):
    return (any(row['member'] == member and row['owner_revision'] == revision
                and row['owner_state'] == 'idle' for row in state.get('members', []))
            and any(row['member'] == member and row['revision'] == revision
                    and row['state'] == 'done' for row in state.get('own_tasks', [])))


def accepted_contribution(state, owner, helper):
    tasks = [row for row in state.get('tasks', []) if row['owner'] == owner]
    if len(tasks) != 1 or tasks[0]['state'] != 'accepted':
        return False
    task = tasks[0]
    attempts = [row for row in state.get('contributions', []) if row['task'] == task['task']]
    decisions = [row for row in state.get('decisions', []) if row['task'] == task['task']]
    if len(attempts) != 1 or len(decisions) != 1:
        return False
    contribution, decision = attempts[0], decisions[0]
    return (contribution['state'] == 'completed' and contribution['contributor'] == helper
            and bool(contribution['result']) and decision['contribution'] == contribution['contribution']
            and decision['owner'] == owner and decision['contributor'] == helper
            and decision['owner_revision'] == task['owner_revision'] == 2
            and decision['verdict'] == 'accept' and bool(decision['rationale']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-live', action='store_true', help='Authorize real model requests')
    parser.add_argument('--root', type=Path, help='New evidence directory; must not exist')
    parser.add_argument('--plugin', type=Path, default=PLUGIN)
    parser.add_argument('--model', default='haiku')
    parser.add_argument('--timeout', type=int, default=240)
    args = parser.parse_args()
    if not args.run_live:
        parser.error('Real model requests require --run-live')
    if args.root:
        root = args.root.resolve()
        root.mkdir(mode=0o700, parents=False, exist_ok=False)
    else:
        root = Path(tempfile.mkdtemp(prefix='apana-cooperation-coding-'))
    os.chmod(root, 0o700)
    print('Live coding artifacts:', root, flush=True)
    shared = runpy.run_path(str(HERE / 'live_check.py'))
    Session = shared['Session']
    global_settings = Path.home() / '.claude/settings.json'
    before = digest(global_settings)
    report = {'root': str(root), 'checks': [], 'status': 'failed',
              'fixture_combinations': {'kind': 'calculated', 'n': 8, 'strength': 3}}
    sessions = []
    db = root / 'registry.sqlite3'
    try:
        owner = Session(root, 'owner', db, plugin=args.plugin, model=args.model,
                        tools='Read,Edit,Bash',
                        allowed_tools=[TOOL, 'Read', 'Edit', 'Bash(python3 -I test_gate.py)'])
        sessions.append(owner)
        helper = Session(root, 'helper', db, plugin=args.plugin, model=args.model)
        sessions.append(helper)
        workspace = Path(owner.cwd)
        (workspace / 'gate.py').write_text(BROKEN_GATE)
        (workspace / 'test_gate.py').write_text(GATE_TEST)
        test_hash = digest(workspace / 'test_gate.py')
        assert run_fixture(workspace, root / 'before-test.log') != 0, 'Fixture must be RED'
        report['checks'].append('fixture_red_before_model_edits')
        cursors = []
        for session, marker in ((owner, 'CODING_OWNER_READY'), (helper, 'CODING_HELPER_READY')):
            cursor = session.send(f'Complete this setup task: call {TOOL} action finish, '
                                  f'then reply exactly {marker}.')
            cursors.append((session, marker, cursor))
        for session, marker, cursor in cursors:
            session.wait_result(marker, after=cursor, timeout=args.timeout)
        wait_for(lambda: all(completed_owner(snapshot(db), session.member, 1)
                             for session in sessions), 'completed setup tasks', args.timeout)
        report['checks'].append('real_sessions_ready_with_completed_owner_ledgers')
        instructions = (
            'Independently review this Python function and propose the minimal corrected function. '
            'A result is acceptable exactly when its revision equals the current owner revision '
            'AND it has not been cancelled. Compare the existing OR condition with the correct '
            'condition and explain why stale or cancelled results must be rejected. '
            'Cover owner revisions {7,8}, result revisions {7,8}, cancelled {False,True}. '
            'You have no tools; provide a code proposal and reasoning, not claims of executed tests.\n'
            + BROKEN_GATE)
        prompt = (
            'Fix gate.py in your current workspace by collaborating with the available peer. '
            'The immutable regression is test_gate.py; do not edit it. First call '
            f'{TOOL} action publish with title "result revision gate review" and instructions '
            + json.dumps(instructions) + '. Publish exactly one delegation. '
            'Do not edit gate.py before the peer result arrives. After publishing, end your turn '
            'briefly saying you await the result; do not finish your task yet. '
            'When notified automatically, call status, inspect the attributed proposal, verify its '
            'reasoning, apply the correction to gate.py using Edit, and execute exactly '
            '`python3 -I test_gate.py` with Bash. If the tests pass, call decide with decision accept '
            'for that contribution and a rationale explaining your verification, then call finish '
            'and reply exactly COLLABORATIVE_CODE_VERIFIED. Do not ask the human to continue. '
            'Keep all edits within gate.py; keep the regression unchanged.')
        cursor = owner.send(prompt)
        wait_for(lambda: any(row['owner'] == owner.member for row in snapshot(db).get('tasks', [])),
                 'owner publishes coding delegation', args.timeout)
        report['checks'].append('coding_delegation_published')
        owner.wait_result('COLLABORATIVE_CODE_VERIFIED', after=cursor, timeout=args.timeout)
        state = snapshot(db)
        assert accepted_contribution(state, owner.member, helper.member), 'Exact peer attribution/decision missing'
        assert completed_owner(state, owner.member, 2), 'Coding task not explicitly completed'
        tool_calls = shared['tool_calls']
        assert tool_calls(owner.records, 'Edit', after=cursor), 'Owner did not call Edit'
        assert any(call.get('command') == 'python3 -I test_gate.py'
                   for call in tool_calls(owner.records, 'Bash', after=cursor)), 'Owner did not execute regression'
        assert digest(workspace / 'test_gate.py') == test_hash, 'Regression was modified'
        assert (workspace / 'gate.py').read_text() != BROKEN_GATE, 'Owner did not apply a fix'
        assert run_fixture(workspace, root / 'after-test.log') == 0, 'Fixture must be GREEN'
        report['checks'].extend(['single_attributed_peer_contribution_accepted',
                                 'owner_completed_coding_revision', 'regression_unchanged',
                                 'fixture_green_after_model_edits'])
        report['status'] = 'passed'
    except Exception as exc:
        report['error'] = repr(exc)
    finally:
        try:
            report['snapshot'] = snapshot(db)
        except Exception as exc:
            report['snapshot_error'] = repr(exc)
            report['status'] = 'failed'
        for session in reversed(sessions):
            try:
                session.stop()
            except Exception as exc:
                report.setdefault('cleanup_errors', []).append(repr(exc))
                report['status'] = 'failed'
        report['global_settings_unchanged'] = digest(global_settings) == before
        if not report['global_settings_unchanged']:
            report['status'] = 'failed'
            report['settings_error'] = 'Global settings changed; not restored automatically'
        (root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ('root', 'status', 'checks')}, indent=2), flush=True)
        if 'error' in report:
            print(report['error'], file=sys.stderr)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
