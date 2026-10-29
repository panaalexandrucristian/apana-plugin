import copy
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest import mock


coding = runpy.run_path(str(Path(__file__).with_name('live_coding_check.py')))


class CodingAcceptanceTests(unittest.TestCase):
    def test_fixture_detects_bug_and_accepts_correct_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gate = root / 'gate.py'
            gate.write_text(coding['BROKEN_GATE'])
            (root / 'test_gate.py').write_text(coding['GATE_TEST'])
            self.assertNotEqual(coding['run_fixture'](root, root / 'red.log'), 0)
            gate.write_text('def accepts_result(owner_revision, result_revision, cancelled):\n'
                            '    return owner_revision == result_revision and not cancelled\n')
            self.assertEqual(coding['run_fixture'](root, root / 'green.log'), 0)

    def test_acceptance_requires_exact_single_peer_contribution(self):
        state = {
            'tasks': [{'task': 'task', 'owner': 'owner', 'owner_revision': 2, 'state': 'accepted'}],
            'contributions': [{'contribution': 'result', 'task': 'task', 'contributor': 'helper',
                               'state': 'completed', 'result': 'proposal'}],
            'decisions': [{'task': 'task', 'contribution': 'result', 'owner': 'owner',
                           'owner_revision': 2, 'contributor': 'helper', 'verdict': 'accept',
                           'rationale': 'verified'}],
        }
        check = coding['accepted_contribution']
        self.assertTrue(check(state, 'owner', 'helper'))
        for table, key, value in (
                ('tasks', 'owner_revision', 3), ('tasks', 'state', 'completed'),
                ('contributions', 'contributor', 'unrelated'), ('contributions', 'state', 'cancelled'),
                ('decisions', 'contribution', 'wrong'), ('decisions', 'owner_revision', 1),
                ('decisions', 'rationale', ''), ('decisions', 'verdict', 'reject')):
            with self.subTest(table=table, key=key, value=value):
                changed = copy.deepcopy(state)
                changed[table][0][key] = value
                self.assertFalse(check(changed, 'owner', 'helper'))
        for table in state:
            with self.subTest(duplicate=table):
                changed = copy.deepcopy(state)
                changed[table].append(copy.deepcopy(changed[table][0]))
                self.assertFalse(check(changed, 'owner', 'helper'))

    def test_snapshot_closes_read_only_connection_on_failure(self):
        snapshot = coding['snapshot']
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        connection.execute.side_effect = RuntimeError('simulated read failure')
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'registry.sqlite3'
            database.touch()
            with mock.patch.object(snapshot.__globals__['sqlite3'], 'connect', return_value=connection):
                with self.assertRaisesRegex(RuntimeError, 'simulated read failure'):
                    snapshot(database)
        connection.close.assert_called_once_with()

    def test_cleanup_survives_corrupt_registry_after_partial_startup(self):
        stopped = []

        class FakeSession:
            def __init__(self, root, name, database, **kwargs):
                if name == 'helper':
                    raise RuntimeError('simulated startup failure')
                database.write_text('not a sqlite database')
                self.name = name

            def stop(self):
                stopped.append(self.name)

        main = coding['main']
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'new-run'
            with mock.patch.object(main.__globals__['runpy'], 'run_path', return_value={'Session': FakeSession}), \
                    mock.patch('sys.argv', ['live_coding_check.py', '--run-live', '--root', str(root)]), \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(main(), 1)
            report = json.loads((root / 'result.json').read_text())
            self.assertEqual(report['status'], 'failed')
            self.assertIn('snapshot_error', report)
            self.assertEqual(stopped, ['owner'])

    def test_idle_is_not_enough_without_completed_matching_revision(self):
        check = coding['completed_owner']
        state = {'members': [{'member': 'owner', 'owner_revision': 2, 'owner_state': 'idle'}],
                 'own_tasks': [{'member': 'owner', 'revision': 1, 'state': 'done'}]}
        self.assertFalse(check(state, 'owner', 2))
        state['own_tasks'][0]['revision'] = 2
        self.assertTrue(check(state, 'owner', 2))
        state['own_tasks'][0]['state'] = 'active'
        self.assertFalse(check(state, 'owner', 2))


if __name__ == '__main__':
    unittest.main()
