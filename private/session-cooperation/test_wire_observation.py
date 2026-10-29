"""Credential-free regressions for the opt-in provider wire audit."""
import importlib.util
import json
import runpy
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('wire_observation', Path(__file__).with_name('wire_observation.py'))
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)


def body(task='task-1', secret='PEER_ONLY'):
    return {'model': 'fixture', 'instructions': 'You are an isolated collaborator.',
            'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': json.dumps({'task': task, 'instructions': secret})}]}],
            'tools': []}


def request(value, attempt=1):
    return f'=== API REQUEST {attempt} ===\nTimestamp: 2026-10-28T23:02:43.798658+02:00\nHeaders:\nAuthorization: Bearer SHOULD_NOT_SURVIVE\nBody:\n{json.dumps(value)}\n'


def response(completed=False, attempt=1, response_id='response-1'):
    events = [{'type': 'response.created', 'response': {'id': response_id}}, {'type': 'response.output_text.delta', 'delta': 'hello'}]
    if completed:
        events.append({'type': 'response.completed', 'response': {'id': response_id}})
    return f'=== API RESPONSE {attempt} ===\nStatus: 200\nHeaders:\nSecret: SHOULD_NOT_SURVIVE\n' + ''.join('data: ' + json.dumps(e) + '\n' for e in events)


class WireObservationTests(unittest.TestCase):
    def test_wire_logging_is_selected_when_creating_the_private_clone(self):
        harness = runpy.run_path(str(Path(__file__).with_name('live_pty_check.py')))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source'; source.mkdir()
            (source / 'auth').mkdir()
            (source / 'proxy.json').write_text('{"config-version":8}')
            (source / 'auth' / 'fake.json').write_text('{"type":"codex","access_token":"synthetic"}')
            before = (source / 'proxy.json').read_bytes()
            for enabled in (False, True):
                destination = root / str(enabled)
                harness['clone_openai_state'](source, destination, wire_audit=enabled)
                config = json.loads((destination / 'proxy.json').read_text())
                self.assertEqual(config['server']['commercial-mode'], not enabled)
                self.assertEqual(config['observability']['logs']['request-log'], enabled)
                self.assertEqual((source / 'proxy.json').read_bytes(), before)

    def test_only_upstream_json_and_event_metadata_survive(self):
        text = '=== REQUEST BODY ===\n{"private":"DOWNSTREAM_ONLY"}\n' + request(body()) + response()
        records = wire.parse_log(text)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['body'], body())
        self.assertEqual(records[0]['response_id'], 'response-1')
        self.assertNotIn('SHOULD_NOT_SURVIVE', json.dumps(records))
        self.assertNotIn('DOWNSTREAM_ONLY', json.dumps(records))

    def test_attempts_are_not_merged(self):
        records = wire.parse_log(request(body(), 1) + request(body(), 2) + response(False, 1) + response(True, 2, 'response-2'))
        self.assertNotIn('response.completed', records[0]['response_types'])
        self.assertIn('response.completed', records[1]['response_types'])
        self.assertEqual(records[1]['response_id'], 'response-2')

    def test_partial_body_waits_instead_of_accepting_truncated_json(self):
        self.assertEqual(wire.parse_log('=== API REQUEST 1 ===\nBody:\n{"input":', partial=True), [])
        with self.assertRaises(ValueError):
            wire.parse_log('=== API REQUEST 1 ===\nBody:\n{"input":')

    def test_downstream_and_error_sections_do_not_become_upstream_requests(self):
        self.assertEqual(wire.parse_log('=== API RESPONSE ===\nerror\n=== RESPONSE ===\ndata: {"type":"response.completed"}\n'), [])

    def test_active_barrier_requires_one_request_and_http_acknowledgement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            req = root / 'request-log-parts-api-request-fixture'; req.mkdir()
            res = root / 'request-log-parts-api-response-fixture'; res.mkdir()
            (req / 'part-a.tmp').write_text(request(body()))
            (res / 'part-a.tmp').write_text('=== API RESPONSE 1 ===\ndata: {"type":"response.created","response":{"id":"response-1"}}\n')
            self.assertIsNone(wire.active_request(root, 'task-1'))
            (res / 'part-a.tmp').write_text(response())
            found = wire.active_request(root, 'task-1')
            self.assertEqual(found['response_id'], 'response-1')
            (res / 'part-a.tmp').write_bytes(response().encode() + b'\xc3')
            self.assertIsNone(wire.active_request(root, 'task-1'))
            (res / 'part-a.tmp').write_text(response())
            self.assertIsNone(wire.active_request(root, 'other-task'))
            other = root / 'request-log-parts-api-request-other'; other.mkdir()
            (other / 'part-a.tmp').write_text(request(body('other-task')))
            self.assertIsNone(wire.active_request(root, 'task-1'))

    def test_nonstream_barrier_uses_upstream_acknowledgement_and_request_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            req = root / 'request-log-parts-api-request-fixture'; req.mkdir()
            res = root / 'request-log-parts-api-response-fixture'; res.mkdir()
            (req / 'part-a.tmp').write_text(request(body()))
            metadata = '=== API RESPONSE 1 ===\nTimestamp: 2026-10-28T23:02:44.6261+02:00\nStatus: 200\nHeaders:\n'
            (res / 'part-a.tmp').write_text(metadata)
            started = wire.active_request(root, 'task-1')
            self.assertIsNotNone(started)
            self.assertIsNone(started['response_id'])
            self.assertEqual(started['upstream_status'], 200)
            log = root / 'v1-messages-fixture.log'
            raw = request(body()) + metadata + '=== RESPONSE ===\n'
            log.write_text(raw.replace('23:02:43.798658', '23:02:45.798658'))
            self.assertIsNone(wire.cancelled_request(root, started))
            log.write_text(raw)
            self.assertIsNotNone(wire.cancelled_request(root, started))
            (res / 'part-a.tmp').write_text(metadata.replace('Status: 200', 'Status: 503'))
            self.assertIsNone(wire.active_request(root, 'task-1'))

    def test_finalized_cancel_requires_same_response_and_no_completion(self):
        started = wire.parse_log(request(body()) + response())[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / 'v1-messages-fixture.log'
            log.write_text(request(body()) + response(False, response_id='different') + '=== RESPONSE ===\n')
            self.assertIsNone(wire.cancelled_request(root, started))
            log.write_text(request(body()) + response())
            self.assertIsNone(wire.cancelled_request(root, started))
            log.write_text(request(body()) + response() + '=== RESPONSE ===\n')
            self.assertIsNotNone(wire.cancelled_request(root, started))
            log.write_text(request(body()) + response(True) + '=== RESPONSE ===\n')
            with self.assertRaisesRegex(AssertionError, 'completed'):
                wire.cancelled_request(root, started)

    def test_cancelled_log_accepts_proxy_error_appended_to_an_sse_event(self):
        for completed in (False, True):
            for separator in ('', '\n'):
                with self.subTest(completed=completed, separator=separator), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    started = wire.parse_log(request(body()) + response())[0]
                    raw = request(body()) + response(completed).rstrip('\n') + separator + 'Error: context canceled\n=== RESPONSE ===\n'
                    (root / 'cancelled.log').write_text(raw)
                    records = wire.finalized_requests(root)
                    self.assertEqual('response.completed' in records[0]['response_types'], completed)
                    if completed:
                        with self.assertRaisesRegex(AssertionError, 'completed'):
                            wire.cancelled_request(root, started)
                    else:
                        self.assertIsNotNone(wire.cancelled_request(root, started))

    def test_unrecognized_sse_suffix_is_not_silently_discarded(self):
        for suffix in ('unexpected junk', 'data: {"type":"response.completed"}'):
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                wire.parse_log(request(body()) + response().rstrip('\n') + suffix)

    def test_actual_payload_isolation_and_tool_free_contract(self):
        isolated = wire.parse_log(request(body()) + response())
        owner = {'body': {'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': 'HOST_ONLY Private owner context probe:'}]}]}, 'response_types': []}
        result = wire.audit(isolated + [owner], 'task-1', 'HOST_ONLY', 'PEER_ONLY')
        self.assertEqual(result['isolated_requests'], 1)
        self.assertEqual(result['owner_requests'], 1)
        for field, value in [('instructions', 'HOST_ONLY'), ('tools', [{'type': 'image_generation'}])]:
            with self.subTest(field=field):
                bad = json.loads(json.dumps(isolated)); bad[0]['body'][field] = value
                with self.assertRaises(AssertionError):
                    wire.audit(bad + [owner], 'task-1', 'HOST_ONLY', 'PEER_ONLY')
        owner['body']['input'][0]['content'][0]['text'] += ' PEER_ONLY'
        with self.assertRaises(AssertionError):
            wire.audit(isolated + [owner], 'task-1', 'HOST_ONLY', 'PEER_ONLY')

    def test_missing_controls_or_reverse_probe_cannot_pass(self):
        isolated = wire.parse_log(request(body()) + response())
        self.assertIsNone(wire.audit(isolated, 'task-1', 'HOST_ONLY', 'PEER_ONLY'))
        self.assertIsNone(wire.audit([], 'task-1', 'HOST_ONLY', 'PEER_ONLY'))


if __name__ == '__main__':
    unittest.main()
