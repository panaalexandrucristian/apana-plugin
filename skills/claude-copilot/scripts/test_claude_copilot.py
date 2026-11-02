"""Offline regression contracts; never uses provider credentials or downloads."""
import copy
import io
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import claude_copilot as c


def entry(name='gemini-4-argon', prompt=983040, context=1048576, output=65536):
    return {'id': name, 'capabilities': {'type': 'chat',
            'supports': {'streaming': True, 'tool_calls': True},
            'limits': {'max_prompt_tokens': prompt, 'max_context_window_tokens': context,
                       'max_output_tokens': output}}, 'supported_endpoints': ['/chat/completions']}


def catalog(*entries):
    return {'object': 'list', 'data': list(entries or [entry()])}


class CatalogTests(unittest.TestCase):
    def test_whole_api_not_family_filter_and_safe_common_context(self):
        raw = catalog(entry(), entry('gpt-3.5-turbo', 12288, 16384, 4096), entry('kimi-k3'))
        models, limits = c.normalize_catalog(raw)
        self.assertEqual(set(models), {c.DEFAULT_MODEL, 'copilot/gpt-3.5-turbo', 'copilot/kimi-k3'})
        self.assertEqual(limits, {'context': 12288, 'output': 4096, 'compact': 6144})
        self.assertEqual(raw['data'][0]['id'], 'gemini-4-argon')

    def test_pinned_normalization_policy_duplicates_nonchat(self):
        disabled = entry('disabled'); disabled['policy'] = {'state': 'disabled'}
        image = entry('image'); image['capabilities']['type'] = 'image'
        raw = catalog(entry(), disabled, image, entry('dup'), entry(' DUP '), entry(' spaced '))
        models, _ = c.normalize_catalog(raw)
        self.assertEqual(set(models), {c.DEFAULT_MODEL, 'copilot/spaced'})

    def test_invalid_refresh_never_uses_cached_catalog(self):
        for raw in ({}, catalog(), {'data': [], 'object': 'list'},
                    dict(catalog(), has_more=True), dict(catalog(), error='denied'),
                    dict(catalog(), next='page2')):
            if raw == catalog():
                continue
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                c.normalize_catalog(raw)

    def test_unknown_capabilities_block_not_silently_filter(self):
        for field in ('max_prompt_tokens', 'max_context_window_tokens', 'max_output_tokens'):
            bad = entry(); del bad['capabilities']['limits'][field]
            with self.assertRaises(RuntimeError): c.normalize_catalog(catalog(entry(), bad))
        bad = entry('bad'); bad['capabilities']['supports']['tool_calls'] = False
        with self.assertRaises(RuntimeError): c.normalize_catalog(catalog(entry(), bad))

    def test_malformed_metadata_is_diagnostic_not_partial_success(self):
        for key, value in (('capabilities', ['wrong']), ('policy', 'enabled'), ('supported_endpoints', ['/v1/messages', []])):
            bad = entry(); bad[key] = value
            with self.assertRaises(RuntimeError): c.normalize_catalog(catalog(bad))
        for key in ('supports', 'limits'):
            bad = entry(); bad['capabilities'][key] = []
            with self.assertRaises(RuntimeError): c.normalize_catalog(catalog(bad))
        with self.assertRaises(RuntimeError): c.normalize_catalog(dict(catalog(), object='error'))

    def test_registry_exact_reconciliation(self):
        models, _ = c.normalize_catalog(catalog())
        c.reconcile(models, {'data': [{'id': c.DEFAULT_MODEL}]})
        for ids in ([], ['gemini-4-argon'], [c.DEFAULT_MODEL, 'copilot/extra'], [c.DEFAULT_MODEL]*2):
            with self.assertRaises(RuntimeError): c.reconcile(models, {'data': [{'id': x} for x in ids]})


class ArgumentTests(unittest.TestCase):
    def test_priority_settings_last_and_literal_separator(self):
        args, model, settings = c.parse_args(['--model=explicit', '--settings', '{"ignored":true}',
            '--settings={"permissions":{"deny":["Bash"]}}', '--', '--model', 'literal'], {'CLAUDE_COPILOT_MODEL': 'env'})
        self.assertEqual(model, 'explicit')
        self.assertEqual(args, ['--', '--model', 'literal'])
        self.assertEqual(settings, {'permissions': {'deny': ['Bash']}})
        self.assertEqual(c.parse_args([], {'CLAUDE_COPILOT_MODEL': 'env'})[1], 'env')
        self.assertEqual(c.parse_args([], {})[1], c.DEFAULT_MODEL)
        for args in (['--model'], ['--model='], ['--settings', '[]'], ['--settings']):
            with self.assertRaises(RuntimeError): c.parse_args(args, {})

    def test_settings_preserve_hooks_permissions_and_reject_reserved(self):
        inherited = {'ANTHROPIC_API_KEY': 'secret', 'ANTHROPIC_AUTH_TOKEN': 'old',
                     'ANTHROPIC_CUSTOM_HEADERS': 'Authorization: secret\nx-extra: keep',
                     'CLAUDE_CODE_USE_VERTEX': '1', 'PATH': '/bin'}
        before = dict(inherited)
        extra = {'permissions': {'deny': ['Bash']}, 'hooks': {'Stop': [{'hooks': []}]}, 'theme': 'dark'}
        env, settings = c.launch_spec(inherited, 'http://127.0.0.1:1234', 'local', c.DEFAULT_MODEL,
            [c.DEFAULT_MODEL], {'context': 12288, 'output': 4096, 'compact': 6144}, extra)
        self.assertEqual(inherited, before)
        self.assertEqual(env['ANTHROPIC_API_KEY'], '')  # no interactive approval/default writes for a disposable key
        self.assertEqual(env['ANTHROPIC_AUTH_TOKEN'], 'local')
        self.assertEqual(env['CLAUDE_CODE_USE_VERTEX'], '0')
        self.assertEqual(env['ANTHROPIC_CUSTOM_HEADERS'], 'x-extra: keep')
        self.assertEqual(settings['permissions'], extra['permissions'])
        self.assertEqual(settings['hooks'], extra['hooks'])
        self.assertNotIn('behavesAs', settings['modelPicker']['options'][0])
        for extra in ({'model': 'other'}, {'apiKeyHelper': 'foreign'}, {'modelPicker': {}},
                      {'env': {'ANTHROPIC_BASE_URL': 'https://foreign'}}):
            with self.assertRaises(RuntimeError):
                c.launch_spec({}, 'http://127.0.0.1:1234', 'local', c.DEFAULT_MODEL,
                              [c.DEFAULT_MODEL], {'context': 12288, 'output': 4096, 'compact': 6144}, extra)


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()

    def test_idempotent_backup_modes_and_preservation(self):
        rc = self.home / '.zshrc'; rc.write_text('export KEEP=yes\n'); rc.chmod(0o640)
        state = c.configure(self.home, sys.executable)
        (state / 'auth' / 'credential.json').write_text('private')
        before = (state / 'zshrc.before').read_bytes()
        c.configure(self.home, sys.executable)
        self.assertEqual(before, b'export KEEP=yes\n')
        self.assertEqual((state / 'zshrc.before').read_bytes(), before)
        self.assertEqual(rc.stat().st_mode & 0o777, 0o640)
        self.assertEqual(rc.read_text().count(c.BEGIN), 1)
        snap = self.snapshot()
        c.uninstall(self.home, dry_run=True)
        self.assertEqual(self.snapshot(), snap)
        c.uninstall(self.home)
        self.assertEqual((state / 'auth' / 'credential.json').read_text(), 'private')
        self.assertIn('export KEEP=yes', rc.read_text())

    def snapshot(self):
        return {str(p.relative_to(self.home)): (p.read_bytes(), p.stat().st_mode) for p in self.home.rglob('*') if p.is_file()}

    def test_collisions_and_symlinks_refused_before_writes(self):
        rc = self.home / '.zshrc'
        for text in (c.BEGIN, c.END + '\n' + c.BEGIN, c.BEGIN + '\necho foreign\n' + c.END):
            rc.write_text(text); before = self.snapshot()
            with self.assertRaises(RuntimeError): c.configure(self.home, sys.executable)
            self.assertEqual(before, self.snapshot())
        rc.unlink(); target = self.home / 'foreign'; target.write_text('unchanged'); rc.symlink_to(target)
        with self.assertRaises(RuntimeError): c.configure(self.home, sys.executable)
        self.assertEqual(target.read_text(), 'unchanged')


class GuardTests(unittest.TestCase):
    def test_explicit_pair_only_and_helper_pinned(self):
        ids = [c.DEFAULT_MODEL, 'copilot/other']
        g = c.ModelGuard(c.DEFAULT_MODEL, ids)
        sid = '11111111-1111-4111-8111-111111111111'
        g.session({'hook_event_name': 'SessionStart', 'source': 'startup', 'session_id': sid})
        self.assertTrue(g.allowed(c.DEFAULT_MODEL, sid, 'main', None))
        self.assertFalse(g.allowed(ids[1], sid, 'main', None))
        # Exhaustive three factors: source x matching pair x destination.
        for source, matching, destination in itertools.product(('command', 'picker', 'sdk', 'auto', 'resume'), (True, False), ids):
            h = c.ModelGuard(c.DEFAULT_MODEL, ids); h.session({'hook_event_name': 'SessionStart', 'source': 'startup', 'session_id': sid})
            event = {'session_id': sid, 'source': source, 'from_model': c.DEFAULT_MODEL,
                     'to_model': destination, 'requested_model': destination}
            h.switch(dict(event, hook_event_name='PreModelSwitch'))
            h.switch(dict(event, hook_event_name='PostModelSwitch', requested_model=destination if matching else 'wrong'))
            expected = destination if source in ('command', 'picker', 'sdk') and matching else c.DEFAULT_MODEL
            self.assertTrue(h.allowed(expected, sid, 'main', None))
            self.assertFalse(h.allowed('copilot/unknown', sid, 'main', None))
            self.assertTrue(h.allowed(c.DEFAULT_MODEL, sid, 'subagent', 'agent'))
            self.assertFalse(h.allowed(ids[1], sid, 'subagent', 'agent'))
        self.assertFalse(g.allowed(c.DEFAULT_MODEL, 'foreign', 'main', None))


class HttpGuardTests(unittest.TestCase):
    def test_http_frontier_forwarding_auth_and_substitution(self):
        import http.client
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        seen = []
        class Backend(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                seen.append((dict(self.headers), body))
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                self.wfile.write(b'event: message_stop\ndata: {"type":"message_stop"}\n\n')
        backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        thread = threading.Thread(target=backend.serve_forever, daemon=True); thread.start()
        self.addCleanup(backend.server_close); self.addCleanup(backend.shutdown)
        sid = '11111111-1111-4111-8111-111111111111'
        limits = {'context': 12288, 'output': 4096, 'compact': 6144}
        with c.guard_session(c.DEFAULT_MODEL, [c.DEFAULT_MODEL, 'copilot/other'],
                             'http://127.0.0.1:' + str(backend.server_port), 'native-only', limits) as server:
            def call(path, data, control=False, header=None, raw=None):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                headers = {'Authorization': 'Bearer ' + (server.control_key if control else server.key),
                           'Content-Type': 'application/json', 'x-claude-code-session-id': sid}
                headers.update(header or {})
                conn.request('POST', path, json.dumps(data) if raw is None else raw, headers)
                result = conn.getresponse(); status, body = result.status, result.read(); conn.close()
                return status, body
            register = {'hook_event_name': 'SessionStart', 'source': 'startup', 'session_id': sid}
            self.assertEqual(call('/guard/session', register)[0], 401)
            self.assertEqual(call('/guard/session', register, True)[0], 200)
            body = {'model': c.DEFAULT_MODEL, 'max_tokens': 4096, 'messages': []}
            bad = [('model', 'copilot/other'), ('fallbacks', ['copilot/other']), ('max_tokens', 4097)]
            for field, value in bad:
                self.assertEqual(call('/v1/messages', dict(body, **{field: value}))[0], 400)
            for header in ({'Authorization': 'Bearer wrong'}, {'x-api-key': 'foreign'},
                           {'Origin': 'https://foreign'}, {'x-claude-code-session-id': 'foreign'},
                           {'Transfer-Encoding': 'chunked'}, {'Content-Encoding': 'gzip'}, {'Host': 'foreign'}):
                self.assertIn(call('/v1/messages', body, header=header)[0], (400, 401))
            self.assertEqual(call('/v1/messages', {}, raw='{"model":"a","model":"b"}')[0], 400)
            self.assertEqual(len(seen), 0)
            self.assertEqual(call('/v1/messages', body, header={'x-api-key': server.key})[0], 200)
            self.assertEqual(len(seen), 1)
            self.assertEqual(seen[0][0]['Authorization'], 'Bearer native-only')
            self.assertNotIn('x-api-key', {k.lower(): v for k, v in seen[0][0].items()})
        with self.assertRaises(OSError):
            import socket
            socket.create_connection(('127.0.0.1', server.server_port), timeout=1)

    def test_launch_selection_requires_control_auth_and_only_commits_accepted_switches(self):
        import http.client
        limits = {'context': 12288, 'output': 4096, 'compact': 6144}
        a, b = c.DEFAULT_MODEL, 'copilot/other'
        sid = '11111111-1111-4111-8111-111111111111'
        with c.guard_session(a, [a, b], 'http://127.0.0.1:1234', 'native', limits) as server:
            def selection(headers):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                conn.request('GET', '/guard/launch', headers=headers)
                response = conn.getresponse(); status, body = response.status, json.loads(response.read())
                conn.close(); return status, body
            control = {'Authorization': 'Bearer ' + server.control_key}
            for headers in ({}, {'Authorization': 'Bearer ' + server.key},
                            dict(control, Origin='https://foreign'), dict(control, Host='foreign')):
                with self.subTest(headers=list(headers)):
                    self.assertIn(selection(headers)[0], (400, 401))
            guard = server.guard
            guard.session(dict(hook_event_name='SessionStart', source='startup', session_id=sid))
            event = dict(session_id=sid, source='command', from_model=a, to_model=b, requested_model=b)
            guard.switch(dict(event, hook_event_name='PostModelSwitch'))
            self.assertEqual(selection(control), (200, {'model': a, 'accepted': [a]}))
            guard.switch(dict(event, hook_event_name='PreModelSwitch'))
            self.assertEqual(selection(control), (200, {'model': a, 'accepted': [a]}))
            self.assertFalse(guard.allowed(b, sid, 'main', None))
            guard.switch(dict(event, hook_event_name='PostModelSwitch', requested_model='rejected'))
            self.assertEqual(selection(control), (200, {'model': a, 'accepted': [a]}))
            guard.switch(dict(event, hook_event_name='PreModelSwitch'))
            guard.switch(dict(event, hook_event_name='PostModelSwitch'))
            self.assertEqual(selection(control), (200, {'model': b, 'accepted': sorted([a, b])}))
            new_sid = '22222222-2222-4222-8222-222222222222'
            guard.session(dict(hook_event_name='SessionStart', source='startup', session_id=new_sid))
            for active in (sid, new_sid):
                self.assertTrue(guard.allowed(b, active, 'main', None))
                self.assertFalse(guard.allowed(a, active, 'main', None), 'History is not inference authorization')
                self.assertTrue(guard.allowed(a, active, 'subagent', 'helper'))

    def test_each_supervised_child_validates_settings_and_restores_overlay(self):
        limits = {'context': 12288, 'output': 4096, 'compact': 6144}
        a, b = c.DEFAULT_MODEL, 'copilot/other'
        with tempfile.TemporaryDirectory() as temporary, c.guard_session(a, [a, b], 'http://127.0.0.1:1234', 'native', limits) as server:
            directory = Path(temporary).resolve()
            _, required = c.launch_spec({}, server.url, server.key, a, [a, b], limits)
            c.add_guard_hooks(required, server, directory)
            c.private_write(directory / 'guard-settings.json', json.dumps(required))
            control = directory / 'guard-control.json'
            user = {'theme': 'dark', 'permissions': {'deny': ['Bash(rm:*)']}, 'env': {'KEEP': 'yes'},
                    'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'true'}]}]}}
            with patch.object(c.os, 'execv') as execute:
                c.supervised_client(control, '/fake/claude', ['--settings', json.dumps(user), '--permission-mode', 'default', '--', '--model=literal'])
                argv = execute.call_args.args[1]
                actual = json.loads(Path(argv[argv.index('--settings') + 1]).read_text())
                self.assertEqual(actual['permissions'], user['permissions'])
                self.assertEqual(actual['hooks']['Stop'], user['hooks']['Stop'])
                self.assertEqual(actual['env']['KEEP'], 'yes')
                self.assertIn('SessionStart', actual['hooks'])
                self.assertEqual(argv[-2:], ['--', '--model=literal'])
                for extra in ({'apiKeyHelper': 'foreign'}, {'model': b}, {'modelPicker': {}},
                              {'env': {'ANTHROPIC_BASE_URL': 'http://127.0.0.1:1'}},
                              {'env': {'CLAUDE_CODE_SUBAGENT_MODEL': b}}, {'hooks': []}):
                    execute.reset_mock()
                    with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                        c.supervised_client(control, '/fake/claude', ['--settings', json.dumps(extra)])
                    execute.assert_not_called()
                execute.reset_mock()
                with self.assertRaises(RuntimeError):
                    c.supervised_client(control, '/fake/claude', ['--fallback-model=' + b])
                execute.assert_not_called()
                # Accepted history permits correcting stale argv, never stale inference.
                sid = '11111111-1111-4111-8111-111111111111'
                server.guard.session(dict(hook_event_name='SessionStart', source='startup', session_id=sid))
                for old, new in ((a, b), (b, a)):
                    event = dict(session_id=sid, source='command', from_model=old, to_model=new, requested_model=new)
                    for kind in ('PreModelSwitch', 'PostModelSwitch'):
                        server.guard.switch(dict(event, hook_event_name=kind))
                    c.supervised_client(control, '/fake/claude', ['--model', old])
                    argv = execute.call_args.args[1]
                    self.assertEqual(argv[argv.index('--model') + 1], new)
                    self.assertFalse(server.guard.allowed(old, sid, 'main', None))

    def test_concurrent_guards_keys_sessions_and_stale_pair(self):
        limits = {'context': 12288, 'output': 4096, 'compact': 6144}
        with c.guard_session(c.DEFAULT_MODEL, [c.DEFAULT_MODEL], 'http://127.0.0.1:1234', 'n', limits) as first:
            with c.guard_session(c.DEFAULT_MODEL, [c.DEFAULT_MODEL], 'http://127.0.0.1:1234', 'n', limits) as second:
                self.assertNotEqual(first.url, second.url)
                self.assertEqual(len({first.key, second.key, first.control_key, second.control_key}), 4)
                self.assertIsNot(first.guard.sessions, second.guard.sessions)
        g = c.ModelGuard(c.DEFAULT_MODEL, [c.DEFAULT_MODEL, 'copilot/other'])
        sid = '11111111-1111-4111-8111-111111111111'
        g.session({'hook_event_name': 'SessionStart', 'source': 'startup', 'session_id': sid})
        event = dict(session_id=sid, source='command', from_model=c.DEFAULT_MODEL,
                     to_model='copilot/other', requested_model='copilot/other')
        with patch.object(c.time, 'monotonic', side_effect=[1, 32]):
            g.switch(dict(event, hook_event_name='PreModelSwitch'))
            g.switch(dict(event, hook_event_name='PostModelSwitch'))
        self.assertTrue(g.allowed(c.DEFAULT_MODEL, sid, 'main', None))


class AuthTests(unittest.TestCase):
    def test_poll_states_deadline_and_transport(self):
        from unittest.mock import Mock
        start = {'state': 'own-state', 'url': 'https://github.com/login/device', 'metadata': {'user_code': 'TEST-CODE', 'interval': 5}}
        for outcomes, expected in (([{'status': 'wait'}, {'status': 'ok'}], True),
                                   ([{'status': 'error', 'error': 'slow_down'}, {'status': 'ok'}], True),
                                   ([{'status': 'error', 'error': 'access_denied'}], False),
                                   ([{'status': 'error', 'error': 'expired_token'}], False),
                                   ([{'status': 'ok', 'state': 'foreign'}], False), ([RuntimeError('transport')], False)):
            now = [0]; waits = []
            def sleep(seconds): waits.append(seconds); now[0] += seconds
            with patch.object(c, 'fetch', side_effect=[start] + outcomes) as fetch:
                if expected: self.assertEqual(c.poll_login('http://127.0.0.1:1', 'key', Mock(poll=lambda: None), lambda _: None, lambda: now[0], sleep), 'own-state')
                else:
                    with self.assertRaises(RuntimeError): c.poll_login('http://127.0.0.1:1', 'key', Mock(poll=lambda: None), lambda _: None, lambda: now[0], sleep)
                for call in fetch.call_args_list[1:]: self.assertIn('state=own-state', call.args[0])
                if outcomes[0].get('error') == 'slow_down' if isinstance(outcomes[0], dict) else False:
                    self.assertEqual(waits, [5, 10])
        for invalid in ({'status': 'ok'}, dict(start, state=''), dict(start, state='foreign&state=x'), dict(start, url='https://evil/login/device')):
            with patch.object(c, 'fetch', return_value=invalid), self.assertRaises(RuntimeError):
                c.poll_login('http://127.0.0.1:1', 'key', Mock(), lambda _: None)
        now = [0]
        def expire(seconds): now[0] += 901
        with patch.object(c, 'fetch', return_value=start), self.assertRaisesRegex(RuntimeError, 'timed out'):
            c.poll_login('http://127.0.0.1:1', 'key', Mock(poll=lambda: None), lambda _: None, lambda: now[0], expire)

    def test_cancelled_login_reaps_before_staging_cleanup_and_never_promotes(self):
        from contextlib import contextmanager
        events = []
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); state = c.configure(home, sys.executable)
            c.private_write(state / 'config.json', json.dumps({'schema': 1, 'account': 'account'}))
            @contextmanager
            def native(state, auth_dir, management=False):
                try: yield ('url', 'data', 'control', {}, auth_dir, object())
                finally:
                    # Model a concurrent save just before host termination completes.
                    (auth_dir / 'late.json').write_text('unconfirmed')
                    events.append(('reaped', auth_dir.exists()))
            with patch.object(c, 'native_session', native), patch.object(c, 'poll_login', side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
                c.login(state)
            self.assertEqual(events, [('reaped', True)])
            self.assertEqual(list((state / 'auth').iterdir()), [])
            self.assertEqual(list(state.glob('login-*')), [])
            (state / 'auth' / 'existing.json').write_text('preexisting')
            with patch.object(c, 'native_session') as native, self.assertRaises(RuntimeError): c.login(state)
            native.assert_not_called()
            self.assertEqual((state / 'auth' / 'existing.json').read_text(), 'preexisting')

    def test_fresh_catalog_always_fetches_identity_token_and_api(self):
        auth = {'github_access_token': 'fake'}
        token = {'token': 'fake-copilot', 'expires_at': c.time.time() + 3600, 'endpoints': {'api': 'https://api.githubcopilot.com'}}
        for bad in (False, True):
            replies = [{'login': 'account', 'id': 1}, token, catalog(), {'login': 'account', 'id': 1}, token,
                       RuntimeError('account refresh failed') if bad else catalog(entry('new-model'))]
            with patch.object(c, 'credential', return_value=(None, auth)), patch.object(c, 'fetch', side_effect=replies) as fetch:
                self.assertEqual(c.fresh_catalog(Path('unused'), 'account'), catalog())
                if bad:
                    with self.assertRaises(RuntimeError): c.fresh_catalog(Path('unused'), 'account')
                else: self.assertEqual(c.fresh_catalog(Path('unused'), 'account'), catalog(entry('new-model')))
                self.assertEqual(fetch.call_count, 6)
                self.assertTrue(fetch.call_args_list[-1].args[0].endswith('/models'))
                self.assertEqual(fetch.call_args_list[0].args[1]['X-GitHub-Api-Version'], '2022-11-28')


class ArchiveTests(unittest.TestCase):
    def test_checksum_paths_links_and_valid_fixture(self):
        import hashlib
        import stat
        import zipfile
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary).resolve() / 'fixture.zip'
            for name, mode, valid in [('github-copilot.dylib', stat.S_IFREG, True),
                                      ('../outside', stat.S_IFREG, False), ('/absolute', stat.S_IFREG, False),
                                      ('github-copilot.dylib', stat.S_IFLNK, False), ('a\\b', stat.S_IFREG, False)]:
                with zipfile.ZipFile(path, 'w') as z:
                    item = zipfile.ZipInfo(name); item.external_attr = (mode | 0o600) << 16; z.writestr(item, b'fixture')
                with self.assertRaises(RuntimeError): c.checked_archive(path)
                with patch.object(c, 'ARCHIVE_SHA256', hashlib.sha256(path.read_bytes()).hexdigest()), patch.object(c, 'LIBRARY_SHA256', hashlib.sha256(b'fixture').hexdigest()):
                    if valid: self.assertEqual(c.checked_archive(path)[0], b'fixture')
                    else:
                        with self.assertRaises(RuntimeError): c.checked_archive(path)
                self.assertFalse((path.parent.parent / 'outside').exists())


class VerifyTests(unittest.TestCase):
    def test_complete_success_only_writes_report(self):
        good = {'subtype': 'success', 'is_error': False, 'result': 'CLAUDE_COPILOT_OK', 'session_id': 'session', 'modelUsage': {c.DEFAULT_MODEL: {}}}
        variants = [(0, good, True)]
        for key, value in (('subtype', 'error'), ('is_error', True), ('result', 'wrong'), ('session_id', ''), ('modelUsage', {}), ('modelUsage', {'gemini-4-argon': {}})):
            variants.append((0, dict(good, **{key: value}), False))
        variants += [(1, good, False), (0, 'invalid JSON', False)]
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary).resolve()
            for code, data, valid in variants:
                result = subprocess.CompletedProcess([], code, json.dumps(data) if isinstance(data, dict) else data)
                result.route_model = c.DEFAULT_MODEL; result.route_verified = True
                before = (state / 'verification.json').read_bytes() if (state / 'verification.json').exists() else None
                with patch.object(c, 'run_claude', return_value=result):
                    if valid: self.assertTrue(c.verify(state)['verified'])
                    else:
                        with self.assertRaises(RuntimeError): c.verify(state)
                        self.assertEqual((state / 'verification.json').read_bytes(), before)


class LaunchMatrixTests(unittest.TestCase):
    def test_model_mode_wrapper_exhaustive(self):
        from contextlib import contextmanager
        from unittest.mock import Mock
        # t=3 INFERENCE: each factor affects launch choice. Literal -- is a distinct mode.
        modes = {'interactive': [], 'print': ['-p', 'hi'], 'passthrough': ['--version'], 'literal': ['--', '--model=literal']}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            for model_state, (mode, argv), wrapper_state in itertools.product(('eligible', 'invalid', 'empty'), modes.items(), ('absent', 'compatible', 'incompatible')):
                with self.subTest(model=model_state, mode=mode, wrapper=wrapper_state):
                    order = []
                    @contextmanager
                    def proxy(state):
                        order.append('fresh')
                        if model_state == 'empty': raise RuntimeError('empty catalog')
                        yield ('http://127.0.0.1:1234', 'native', {c.DEFAULT_MODEL: entry()}, {'context': 12288, 'output': 4096, 'compact': 6144}, directory, None)
                    def wrapper(args):
                        if wrapper_state == 'incompatible': raise RuntimeError('incompatible wrapper')
                        return directory / 'wrapper' if wrapper_state == 'compatible' and mode in ('interactive', 'literal') else None
                    child = Mock(); child.communicate.return_value = (None, None); child.returncode = 7; child.poll.return_value = 7
                    args = (['--model=invalid'] if model_state == 'invalid' else []) + argv
                    with patch.object(c, 'prerequisites'), patch.object(c.shutil, 'which', return_value='/fake/claude'), patch.object(c, 'proxy_session', proxy), patch.object(c, 'claude_auto_wrapper', wrapper), patch.object(c.subprocess, 'Popen', return_value=child) as popen, patch.dict(os.environ, {}, clear=True):
                        valid = model_state == 'eligible' and wrapper_state != 'incompatible'
                        if valid:
                            self.assertEqual(c.run_claude(directory, args).returncode, 7)
                            self.assertEqual(order, ['fresh'])
                            command = popen.call_args.args[0]
                            self.assertEqual(command[-len(argv):] if argv else [], argv)
                            self.assertEqual(command[0] == sys.executable, wrapper_state == 'compatible' and mode in ('interactive', 'literal'))
                            settings = json.loads((directory / 'claude-settings.json').read_text())
                            self.assertIn('SessionStart', settings['hooks'])
                            # SessionStart supports command, not HTTP: otherwise real clients never register.
                            self.assertEqual(settings['hooks']['SessionStart'][-1]['hooks'][0]['type'], 'command')
                            self.assertEqual(settings['env']['CLAUDE_CODE_MAX_CONTEXT_TOKENS'], '12288')
                        else:
                            with self.assertRaises(RuntimeError): c.run_claude(directory, args)
                            popen.assert_not_called()

    def test_real_wrapper_contract_and_opt_outs(self):
        source = Path(__file__).parents[2] / 'install-claude-auto/assets/claude-auto'
        with patch.object(c.shutil, 'which', return_value=str(source)):
            for args, expected in (([], source), (['-p', 'hi'], None), (['--version'], None), (['auth', 'status'], None), (['--', '-p'], source)):
                self.assertEqual(c.claude_auto_wrapper(args), expected)
        # The existing supervisor owns its prompt opt-outs; do not duplicate that logic.
        import runpy
        shared = runpy.run_path(str(source), run_name='copilot_test')
        with patch.dict(os.environ, {'CLAUDE_AUTO_RULE': 'off'}):
            self.assertEqual(shared['rule_args']([], []), [])


class LifecycleTests(unittest.TestCase):
    def test_supervisor_shutdown_budget_is_finite_and_preserves_configured_waits(self):
        names = ('CLAUDE_AUTO_KILL_WAIT', 'CLAUDE_AUTO_REAP_WAIT', 'CLAUDE_AUTO_POLL', 'CLAUDE_AUTO_GRACE')
        # t=4 INFERENCE: all finite wait factors share the budget; the bounded matrix is small.
        for kill, reap, poll, grace in itertools.product((0, 30), (0, 2), (0, 0.5), (0, 30)):
            with self.subTest(kill=kill, reap=reap, poll=poll, grace=grace):
                env = dict(zip(names, map(str, (kill, reap, poll, grace))))
                self.assertEqual(c.supervisor_stop_timeout(env), 2 * kill + reap + poll + grace + 15)
        self.assertEqual(c.supervisor_stop_timeout({}), 27.2)
        self.assertEqual(c.supervisor_stop_timeout(dict.fromkeys(names, 'malformed')), 27.2)
        self.assertEqual(c.supervisor_stop_timeout({names[0]: '1000000'}), 2000017.2)
        for name, invalid in itertools.product(names, ('nan', 'inf', '-inf', '-1')):
            with self.subTest(name=name, invalid=invalid), patch.dict(os.environ, {name: invalid}, clear=True), \
                    patch.object(c, 'prerequisites'), patch.object(c.shutil, 'which', return_value='/fake/claude'), \
                    patch.object(c, 'claude_auto_wrapper', return_value=Path('/fake/wrapper')), patch.object(c, 'proxy_session') as proxy:
                with self.assertRaisesRegex(RuntimeError, 'finite nonnegative'):
                    c.run_claude(Path('/fake/state'), [])
                proxy.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'finite timeout'):
            c.supervisor_stop_timeout({names[0]: '1e308'})

    def test_native_process_private_config_concurrency_and_cleanup(self):
        import hashlib
        import socket
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary).resolve()
            (state / 'native').mkdir(); (state / 'native/github-copilot.dylib').write_bytes(b'fixture')
            (state / 'auth').mkdir()
            fake = state / 'fake-host'
            fake.write_text('#!' + sys.executable + '\n' + '''import json,sys
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
config=json.loads(Path(sys.argv[sys.argv.index('-config')+1]).read_text())
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  valid=self.headers.get('Authorization')=='Bearer '+config['access']['api-keys'][0]
  self.send_response(200 if valid else 401); self.end_headers()
  self.wfile.write(json.dumps({'data':[{'id':'copilot/gemini-4-argon'}]}).encode())
HTTPServer(('127.0.0.1',config['server']['port']),Handler).serve_forever()
''')
            fake.chmod(0o700)
            with patch.object(c.shutil, 'which', return_value=str(fake)), patch.object(c, 'LIBRARY_SHA256', hashlib.sha256(b'fixture').hexdigest()):
                with c.native_session(state, state / 'auth') as first:
                    with c.native_session(state, state / 'auth') as second:
                        self.assertNotEqual(first[0], second[0]); self.assertNotEqual(first[1], second[1])
                        self.assertNotEqual(first[4], second[4]); self.assertEqual(first[2], '')
                        config = json.loads((first[4] / 'proxy.json').read_text())
                        self.assertTrue(config['server']['commercial-mode'])
                        self.assertEqual(config['management']['secret-key'], '')
                        self.assertFalse(config['management']['allow-remote'])
                        self.assertFalse(config['observability']['logs']['request-log'])
                        self.assertEqual(set(config['plugins']['configs']), {'github-copilot'})
                        self.assertEqual((first[4] / 'proxy.json').stat().st_mode & 0o777, 0o600)
                        self.assertEqual(config['plugins']['configs']['github-copilot']['models_excluded'], [])
                self.assertIsNotNone(first[-1].poll()); self.assertIsNotNone(second[-1].poll())
                self.assertFalse(first[4].exists()); self.assertFalse(second[4].exists())
                with self.assertRaises(RuntimeError):
                    with c.native_session(state, state / 'auth') as failed:
                        raise RuntimeError('child failure')
                self.assertIsNotNone(failed[-1].poll()); self.assertFalse(failed[4].exists())
            env = c.proxy_environment({'PATH': '/bin', 'ANTHROPIC_AUTH_TOKEN': 'secret', 'GITHUB_TOKEN': 'secret', 'HTTP_PROXY': 'foreign', 'PGSTORE_PASSWORD': 'secret'}, state)
            self.assertEqual(set(env), {'PATH', 'HOME', 'TMPDIR', 'LANG'})

    def test_sighup_reaps_separate_host_and_removes_session_credentials(self):
        import signal
        for supervised in (False, True):
            with self.subTest(supervised=supervised):
                self.run_signal_case(signal.SIGHUP, supervised)

    def test_term_and_ctrl_c_keep_child_process_group_and_cleanup(self):
        import signal
        # t=2 INFERENCE: terminal-group Ctrl-C differs from launcher-directed TERM/HUP.
        for signum, supervised in itertools.product((signal.SIGTERM, signal.SIGINT), (False, True)):
            with self.subTest(signal=signum, supervised=supervised):
                self.run_signal_case(signum, supervised)

    def test_sighup_waits_for_supervisor_escalation_of_uncooperative_child(self):
        import signal
        self.run_signal_case(signal.SIGHUP, supervised=True, ignore_term=True)

    def test_sighup_during_handoff_grace_reaps_uncooperative_child(self):
        import signal
        self.run_signal_case(signal.SIGHUP, supervised=True, ignore_term=True, handoff_grace=True)

    def run_signal_case(self, signum, supervised, ignore_term=False, handoff_grace=False):
        import signal
        import socket
        import time
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            state = home / '.local/share/claude-copilot'; (state / 'native').mkdir(parents=True)
            (state / 'auth').mkdir(); (state / 'owner').write_text(c.OWNER)
            (state / 'config.json').write_text(json.dumps({'schema': 1, 'account': 'fixture'}))
            auth = state / 'auth/copilot.json'
            auth.write_text(json.dumps({'type': 'copilot', 'github_base_url': 'https://github.com',
                'github_login': 'fixture', 'github_access_token': 'fake-no-network'})); auth.chmod(0o600)
            (state / 'native/github-copilot.dylib').write_bytes(b'fixture')
            fake = home / 'fake-host'
            fake.write_text('#!' + sys.executable + '\n' + '''import json,os,sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
config_path=Path(sys.argv[sys.argv.index('-config')+1]); config=json.loads(config_path.read_text())
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.send_response(200); self.end_headers(); self.wfile.write(b'{"data":[{"id":"copilot/gemini-4-argon"}]}')
server=HTTPServer(('127.0.0.1',config['server']['port']),Handler)
(Path(__file__).parent/'host-ready.json').write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp(),
 'port':server.server_port,'runtime':str(config_path.parent),'auth':config['oauth']['auth-dir']}))
server.serve_forever()
'''); fake.chmod(0o700)
            child = home / 'fake-child'
            child.write_text('#!' + sys.executable + '\n' + '''import json,os,signal,sys,time
from pathlib import Path
from urllib.parse import urlsplit
signal.signal(signal.SIGINT,lambda *_: sys.exit(130))
if os.environ.get('TEST_IGNORE_TERM')=='1': signal.signal(signal.SIGTERM,signal.SIG_IGN)
(Path(__file__).parent/'child-ready.json').write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp(),
 'port':urlsplit(os.environ['ANTHROPIC_BASE_URL']).port}))
if os.environ.get('TEST_HANDOFF_GRACE')=='1':
 note=Path(__file__).parent/'HANDOFF.md'; note.write_text('Fake lifecycle handoff.')
 (Path(os.environ['CLAUDE_AUTO_RUN'])/'signal.json').write_text(json.dumps({'handoff':str(note),'session_id':'11111111-1111-4111-8111-111111111111'}))
time.sleep(180)
'''); child.chmod(0o700)
            harness = home / 'launcher-fixture.py'
            # Execute the production entrypoint unchanged; replace only external prerequisites/catalog/native bytes.
            harness.write_text('''import ast,hashlib,os,sys
from pathlib import Path
source=Path(sys.argv[1]); tree=ast.parse(source.read_text()); entrypoint=tree.body.pop()
ns={'__name__':'fixture','__file__':str(source)}
exec(compile(tree,str(source),'exec'),ns)
ns['prerequisites']=lambda: None
ns['LIBRARY_SHA256']=hashlib.sha256(b'fixture').hexdigest()
ns['fresh_catalog']=lambda *args: ''' + repr(catalog()) + '''
home=Path(os.environ['HOME'])
ns['shutil'].which=lambda name: str(home/('fake-host' if name=='cliproxyapi' else 'fake-child')) if name in ('cliproxyapi','claude') else os.environ.get('TEST_WRAPPER') if name=='claude-auto' else None
ns['__name__']='__main__'; sys.argv=[str(source),'run']
exec(compile(ast.Module(body=[entrypoint],type_ignores=[]),str(source),'exec'),ns)
''')
            env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'CLAUDE_AUTO_BOOTSTRAP': '0',
                   'CLAUDE_AUTO_RULE': 'off', 'CLAUDE_AUTO_DIR': str(home / 'auto')}
            if supervised:
                env['TEST_WRAPPER'] = str(Path(__file__).parents[2] / 'install-claude-auto/assets/claude-auto')
            if ignore_term:
                env.update(TEST_IGNORE_TERM='1', CLAUDE_AUTO_KILL_WAIT='30', CLAUDE_AUTO_REAP_WAIT='0.02', CLAUDE_AUTO_POLL='0.02')
            if handoff_grace:
                # Observe entry into the real wrapper's grace wait; do not change its wait or signal behavior.
                observer = home / 'observe-wrapper.py'
                observer.write_text('''import os,runpy,subprocess,sys
from pathlib import Path
shared=runpy.run_path(''' + repr(env['TEST_WRAPPER']) + ''',run_name='supervisor_fixture')
wrapper,passthrough=shared['wrapper'],shared['passthrough']
if __name__=='__main__':
 original_wait=subprocess.Popen.wait
 def observed_wait(process,timeout=None):
  if timeout==float(os.environ['CLAUDE_AUTO_GRACE']):
   (Path(__file__).parent/'grace-ready').write_text('waiting')
  return original_wait(process,timeout=timeout)
 subprocess.Popen.wait=observed_wait
 sys.exit(wrapper(sys.argv[1:]))
''')
                env.update(TEST_HANDOFF_GRACE='1', CLAUDE_AUTO_GRACE='30', CLAUDE_AUTO_KILL_WAIT='0.02', TEST_WRAPPER=str(observer))
            process = subprocess.Popen([sys.executable, '-I', str(harness), str(Path(c.__file__).resolve())],
                env=env, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, start_new_session=True)
            records = []
            try:
                deadline = time.monotonic() + 10
                while not (home / 'child-ready.json').exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue((home / 'child-ready.json').exists(), 'launcher did not reach child readiness')
                host, child_info = [json.loads((home / name).read_text()) for name in ('host-ready.json', 'child-ready.json')]
                records = [(host, fake), (child_info, child)]
                self.assertEqual(host['pid'], host['pgid'])
                self.assertNotEqual(host['pgid'], process.pid)
                copied_auth = Path(host['auth'])
                self.assertEqual((copied_auth / auth.name).read_bytes(), auth.read_bytes())
                self.assertEqual(child_info['pgid'], process.pid, 'Interactive child must retain the launcher process group')
                if handoff_grace:
                    while not (home / 'grace-ready').exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue((home / 'grace-ready').exists(), 'Supervisor never entered the actual handoff grace wait')
                if signum == signal.SIGINT:
                    os.killpg(process.pid, signum)  # A terminal sends Ctrl-C to its foreground group.
                else:
                    process.send_signal(signum)
                process.wait(timeout=90 if ignore_term else 20)
                alive = []
                for info, executable in records:
                    command = subprocess.run(['ps', '-p', str(info['pid']), '-o', 'command='], capture_output=True, text=True).stdout
                    if str(executable) in command: alive.append(str(executable))
                self.assertEqual(alive, [], 'Signal orphaned owned host/client processes')
                stdout, stderr = process.communicate(timeout=5)
                for info, _ in records:
                    with socket.socket() as sock:
                        sock.settimeout(1)
                        self.assertNotEqual(sock.connect_ex(('127.0.0.1', info['port'])), 0)
                self.assertFalse(Path(host['runtime']).exists())
                self.assertFalse(copied_auth.parent.exists())
                self.assertEqual(list(state.glob('native-*')), [])
                self.assertEqual(list(state.glob('session-*')), [])
                self.assertTrue(auth.exists(), 'active credentials must be preserved')
                self.assertEqual(process.returncode, 130, stderr)
            finally:
                if process.poll() is None:
                    process.terminate(); process.communicate(timeout=20)
                # RED cleanup: kill only fixture PIDs whose command still identifies our unique target.
                for filename, executable in (('host-ready.json', fake), ('child-ready.json', child)):
                    path = home / filename
                    if path.exists():
                        pid = json.loads(path.read_text())['pid']
                        command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
                        if str(executable) in command:
                            os.kill(pid, signal.SIGKILL)
                process.communicate(timeout=5)

    def test_guard_closes_incomplete_request_and_command_hook_registers(self):
        import socket
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            limits = {'context': 12288, 'output': 4096, 'compact': 6144}
            with c.guard_session(c.DEFAULT_MODEL, [c.DEFAULT_MODEL], 'http://127.0.0.1:1234', 'native', limits) as server:
                settings = {}; c.add_guard_hooks(settings, server, directory)
                hook = settings['hooks']['SessionStart'][0]['hooks'][0]
                sid = '11111111-1111-4111-8111-111111111111'
                event = {'hook_event_name': 'SessionStart', 'source': 'startup', 'session_id': sid}
                result = subprocess.run([hook['command']] + hook['args'], input=json.dumps(event), capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(server.guard.allowed(c.DEFAULT_MODEL, sid, 'main', None))
                self.assertFalse(server.guard.allowed(c.DEFAULT_MODEL, sid, 'subagent', None))
                conn = socket.create_connection(('127.0.0.1', server.server_port), timeout=2)
                conn.sendall(b'POST /v1/messages HTTP/1.0\r\n')
            conn.close()
            self.assertEqual(server.sockets, set())


class WrapperHandoffTests(unittest.TestCase):
    def test_real_supervisor_keeps_guard_and_settings_for_both_children(self):
        self.run_handoff_case('none', 'missing')

    def test_switch_then_handoff_including_stale_transcript_model(self):
        # t=3 INFERENCE: hook acceptance x transcript model x child generation.
        # All 12 bounded hook/transcript combinations exercise the real wrapper;
        # unauthorized B must stop, never broaden guard authorization.
        for source, recorded in itertools.product(('none', 'preonly', 'command', 'auto'), ('A', 'B', 'missing')):
            with self.subTest(source=source, recorded=recorded):
                self.run_handoff_case(source, recorded)

    def test_next_args_preserve_guard_and_nonrouting_options(self):
        # t=2 INFERENCE: bootstrap can consume next argv before any handoff.
        for bootstrap, args in itertools.product((False, True), (
                [], ['--permission-mode', 'default'], ['--allowedTools', 'Bash', 'Read'],
                ['--model=' + c.DEFAULT_MODEL, '--', '--model=literal'])):
            with self.subTest(bootstrap=bootstrap, args=args):
                self.run_handoff_case('none', 'missing', next_args=args, bootstrap=bootstrap)

    def test_next_settings_preserved_for_handoff_and_plain_child(self):
        settings = {'permissions': {'deny': ['Bash(rm:*)']}, 'theme': 'dark', 'env': {'KEEP': 'yes'},
                    'hooks': {'SessionStart': [{'hooks': [{'type': 'command', 'command': 'true'}]}]}}
        for form, maximum in itertools.product(('file', 'json-equals', 'last'), ('0', '1')):
            with self.subTest(form=form, maximum=maximum):
                self.run_handoff_case('none', 'missing', next_args=['--permission-mode', 'default'],
                                      next_settings=settings, settings_form=form, maximum=maximum)

    def test_next_args_conflicts_stop_before_any_child_or_forwarding(self):
        for extra in ({'apiKeyHelper': 'foreign'}, {'model': 'other'}, {'modelPicker': {}},
                      {'env': {'ANTHROPIC_BASE_URL': 'http://127.0.0.1:1'}},
                      {'env': {'ANTHROPIC_AUTH_TOKEN': 'foreign'}},
                      {'env': {'CLAUDE_CODE_SUBAGENT_MODEL': 'foreign'}}):
            with self.subTest(settings=extra):
                self.run_handoff_case('none', 'missing', next_args=[], next_settings=extra, reject=True)
        for args in (['--model', 'raw'], ['--model=copilot/claude-sonnet-5.5'],
                     ['--fallback-model', 'raw'], ['--fallback-model=copilot/claude-sonnet-5.5'],
                     ['--settings', '[]'], ['--model'], "--model 'unterminated"):
            with self.subTest(args=args):
                self.run_handoff_case('none', 'missing', next_args=args, reject=True, bootstrap=True)

    def run_handoff_case(self, source, recorded, next_args=None, bootstrap=False,
                         next_settings=None, settings_form='file', maximum='0', reject=False):
        from contextlib import contextmanager
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        seen = []
        class Backend(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                seen.append(body['model'])
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
        backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        thread = threading.Thread(target=backend.serve_forever, daemon=True); thread.start()
        self.addCleanup(backend.server_close); self.addCleanup(backend.shutdown)
        wrapper = Path(__file__).parents[2] / 'install-claude-auto/assets/claude-auto'
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); fake = home / 'fake-claude'
            fake.write_text('#!' + sys.executable + '\n' + '''import json,os,sys,time,uuid,subprocess,urllib.request
from pathlib import Path
home=Path(os.environ['HOME']); calls=home/'calls.jsonl'; first=not calls.exists()
settings=json.loads(Path(sys.argv[sys.argv.index('--settings')+1]).read_text())
sid=str(uuid.uuid4())
for group in settings['hooks']['SessionStart']:
 for hook in group['hooks']:
  if '_session-hook' in hook.get('args',[]):
   subprocess.run([hook['command']]+hook['args'],input=json.dumps({'hook_event_name':'SessionStart','source':'startup','session_id':sid}),text=True,check=True)
if not first: assert (home/'HANDOFF.md').read_text()=='Continue through the same Copilot guard.'
# Match real client precedence: --model wins over session settings/env.
args=sys.argv[1:]; args=args[:args.index('--')] if '--' in args else args
model=args[args.index('--model')+1] if '--model' in args else settings.get('model',os.environ['ANTHROPIC_MODEL'])
body={'model':model,'max_tokens':4096,'messages':[]}
request=urllib.request.Request(os.environ['ANTHROPIC_BASE_URL']+'/v1/messages',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+os.environ['ANTHROPIC_AUTH_TOKEN'],'x-claude-code-session-id':sid})
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as response: assert response.status==200
with calls.open('a') as out: out.write(json.dumps({'argv':sys.argv[1:],'settings':settings,'model':model,'env_model':os.environ['ANTHROPIC_MODEL'],'sid':sid,'url':os.environ['ANTHROPIC_BASE_URL'],'key':os.environ['ANTHROPIC_AUTH_TOKEN']})+'\\n')
if first:
 source=os.environ['TEST_SWITCH']; other='copilot/claude-sonnet-5.5'
 if source!='none':
  for event in (['PreModelSwitch'] if source=='preonly' else ['PreModelSwitch','PostModelSwitch']):
   hook=settings['hooks'][event][-1]['hooks'][0]
   data={'hook_event_name':event,'session_id':sid,'source':'command' if source=='preonly' else source,'from_model':model,'to_model':other,'requested_model':other}
   request=urllib.request.Request(hook['url'],data=json.dumps(data).encode(),headers=hook['headers'])
   with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as response: assert response.status==200
 # Use the supervisor's actual transcript extractor, not an invented handoff schema.
 import runpy
 shared=runpy.run_path(os.environ['TEST_WRAPPER'],run_name='handoff_fixture')
 recorded=os.environ['TEST_RECORDED']; transcript=home/'fake-transcript.jsonl'
 row={'type':'assistant','message':{'usage':{'input_tokens':100}}}
 if recorded!='missing': row['requestedModel']=other if recorded=='B' else model
 transcript.write_text(json.dumps(row)+'\\n')
 (home/'HANDOFF.md').write_text('Continue through the same Copilot guard.')
 (Path(os.environ['CLAUDE_AUTO_RUN'])/'signal.json').write_text(json.dumps({'handoff':str(home/'HANDOFF.md'),'session_id':sid,**shared['session_flags'](str(transcript))}))
 time.sleep(60)
'''); fake.chmod(0o700)
            @contextmanager
            def proxy(state):
                yield ('http://127.0.0.1:' + str(backend.server_port), 'native',
                       {c.DEFAULT_MODEL: entry(), 'copilot/claude-sonnet-5.5': entry('claude-sonnet-5.5')},
                       {'context': 12288, 'output': 4096, 'compact': 6144}, home, None)
            def which(name): return str(fake if name == 'claude' else wrapper) if name in ('claude', 'claude-auto') else None
            inherited = {'PATH': os.environ['PATH'], 'HOME': str(home), 'CLAUDE_AUTO_BOOTSTRAP': str(int(bootstrap)), 'CLAUDE_AUTO_RULE': 'off',
                'CLAUDE_AUTO_DIR': str(home / 'auto'), 'CLAUDE_AUTO_POLL': '0.02', 'CLAUDE_AUTO_GRACE': '0.02',
                'CLAUDE_AUTO_MAX': maximum, 'TEST_SWITCH': source, 'TEST_RECORDED': recorded, 'TEST_WRAPPER': str(wrapper)}
            if next_args is not None:
                import shlex
                tokens = list(next_args) if isinstance(next_args, list) else None
                if next_settings is not None:
                    user_path = home / 'next user.json'; user_path.write_text(json.dumps(next_settings))
                    if settings_form == 'file': tokens += ['--settings', str(user_path)]
                    elif settings_form == 'json-equals': tokens += ['--settings=' + json.dumps(next_settings)]
                    else: tokens += ['--settings', '{"apiKeyHelper":"ignored-earlier"}', '--settings', str(user_path)]
                inherited['CLAUDE_AUTO_NEXT_ARGS'] = shlex.join(tokens) if tokens is not None else next_args
            with patch.dict(os.environ, inherited, clear=True), patch.object(c, 'prerequisites'), patch.object(c, 'proxy_session', proxy), patch.object(c.shutil, 'which', side_effect=which):
                if reject:
                    with self.assertRaises((RuntimeError, ValueError)):
                        c.run_claude(home, ['--model', c.DEFAULT_MODEL, 'task'], capture=True)
                    self.assertEqual(seen, [], 'Rejected next configuration must never reach backend')
                    self.assertFalse((home / 'calls.jsonl').exists(), 'Rejected configuration must not start a child')
                    return
                result = c.run_claude(home, ['--model', c.DEFAULT_MODEL, 'task'], capture=True)
            if source != 'command' and recorded == 'B':
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(seen, [c.DEFAULT_MODEL], 'Unaccepted B must never reach backend')
                return
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = [json.loads(line) for line in (home / 'calls.jsonl').read_text().splitlines()]
            self.assertEqual(len(calls), 2)
            self.assertNotEqual(calls[0]['sid'], calls[1]['sid'])
            self.assertEqual(calls[0]['url'], calls[1]['url']); self.assertEqual(calls[0]['key'], calls[1]['key'])
            for child in calls:
                self.assertEqual(child['settings']['model'], c.DEFAULT_MODEL)
                self.assertEqual(child['settings']['env']['CLAUDE_CODE_MAX_CONTEXT_TOKENS'], '12288')
                self.assertIn('PostModelSwitch', child['settings']['hooks'])
            if next_args is not None:
                for index in ((0, 1) if bootstrap else (1,)):
                    actual = calls[index]['argv']
                    # Explicit NEXT_ARGS replaces sticky flags; adapter adds only its routing overlay.
                    for option in ('--permission-mode', '--allowedTools'):
                        if option in next_args:
                            self.assertEqual(actual[actual.index(option) + 1], next_args[next_args.index(option) + 1])
                if next_settings is not None:
                    final = calls[1]['settings']
                    self.assertEqual(final['permissions'], next_settings['permissions'])
                    self.assertEqual(final['theme'], next_settings['theme'])
                    self.assertEqual(final['env']['KEEP'], 'yes')
                    self.assertEqual(final['hooks']['SessionStart'][0], next_settings['hooks']['SessionStart'][0])
            expected = 'copilot/claude-sonnet-5.5' if source == 'command' else c.DEFAULT_MODEL
            self.assertEqual(calls[0]['model'], c.DEFAULT_MODEL)
            self.assertEqual(calls[0]['env_model'], c.DEFAULT_MODEL)
            self.assertEqual(calls[1]['model'], expected)
            self.assertEqual(seen, [c.DEFAULT_MODEL, expected])


if __name__ == '__main__':
    unittest.main()
