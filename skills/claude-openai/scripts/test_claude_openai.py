import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).parent

class InstallerTests(unittest.TestCase):
    def module(self):
        script = ROOT / 'claude_openai.py'
        self.assertTrue(script.exists(), 'The bundled installer has not been implemented')
        spec = importlib.util.spec_from_file_location('claude_openai', script)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_configure_is_private_idempotent_and_preserves_shell(self):
        mod = self.module()
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            home = Path(td)
            rc = home / '.zshrc'
            original = '# existing configuration\nalias claude=claude-auto\n'
            rc.write_text(original)
            state = mod.configure(home, '/usr/bin/python3')
            config = json.loads((state / 'proxy.json').read_text())
            self.assertEqual(config['server']['host'], '127.0.0.1')
            self.assertGreaterEqual(len(config['access']['api-keys'][0]), 32)
            self.assertEqual(config['management']['secret-key'], '')
            self.assertTrue(config['management']['disable-control-panel'])
            self.assertEqual(config['oauth']['auth-dir'], str(state / 'auth'))
            self.assertFalse(config['observability']['logs']['request-log'])
            self.assertEqual((state / 'proxy.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual((state / 'auth').stat().st_mode & 0o777, 0o700)
            first = rc.read_text()
            self.assertTrue(first.startswith(original))
            self.assertIn('alias claude-openai=', first)
            self.assertNotIn('ANTHROPIC_', first)
            mod.configure(home, '/usr/bin/python3')
            self.assertEqual(rc.read_text(), first)
            self.assertTrue((home / '.local/bin/claude-openai').is_file())
            self.assertEqual((state / 'claude_openai.py').read_bytes(), (ROOT / 'claude_openai.py').read_bytes())

    def test_login_runs_codex_oauth_and_requires_written_credentials(self):
        from unittest.mock import patch
        mod = self.module()
        self.assertTrue(hasattr(mod, 'login'), 'OAuth login is not implemented')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            state = mod.configure(Path(td), '/usr/bin/python3')
            with patch.object(mod.shutil, 'which', return_value='/opt/bin/cliproxyapi'), \
                 patch.object(mod.subprocess, 'run') as run:
                run.return_value.returncode = 0
                with self.assertRaisesRegex(RuntimeError, 'credential'):
                    mod.login(state)
                self.assertEqual(run.call_args.args[0], ['/opt/bin/cliproxyapi', '-config', str(state / 'proxy.json'), '-local-model', '-codex-login'])
                def complete(*args, **kwargs):
                    (state / 'auth/test.json').write_text(json.dumps({'type': 'codex', 'access_token': 'unit-test-not-a-token'}))
                    return type('Result', (), {'returncode': 0})()
                run.side_effect = complete
                mod.login(state)
                self.assertEqual((state / 'auth/test.json').stat().st_mode & 0o777, 0o600)
                count = run.call_count
                mod.login(state)
                self.assertEqual(run.call_count, count, 'Valid existing auth is reused unless forced')

    def test_launch_spec_routes_main_and_helper_models_without_disabling_safety(self):
        mod = self.module()
        self.assertTrue(hasattr(mod, 'launch_spec'), 'Session routing is not implemented')
        env, settings = mod.launch_spec({'OPENAI_API_KEY': 'paid-test-key', 'ANTHROPIC_API_KEY': 'other',
            'ANTHROPIC_BASE_URL': 'https://wrong.invalid', 'CLAUDE_CODE_OAUTH_TOKEN': 'other',
            'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB': '1'}, 'http://127.0.0.1:12345', 'local-test-key', 'gpt-6-astra')
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('CLAUDE_CODE_OAUTH_TOKEN', env)
        self.assertNotIn('ANTHROPIC_API_KEY', env)
        self.assertEqual(env['ANTHROPIC_AUTH_TOKEN'], 'local-test-key')
        self.assertEqual(env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'], '1')
        self.assertEqual(env['ANTHROPIC_BASE_URL'], 'http://127.0.0.1:12345')
        for key in ('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'):
            self.assertEqual(env[key], 'gpt-6-astra')
        self.assertNotIn('permissions', settings)
        self.assertNotIn('hooks', settings)
        self.assertNotIn('CLAUDE_CODE_SIMPLE', env)
        self.assertEqual(settings['env']['ANTHROPIC_AUTH_TOKEN'], 'local-test-key')
        self.assertEqual(settings['model'], 'gpt-6-astra')

    def test_installed_context_limit_is_local_on_fresh_install_and_upgrade(self):
        import runpy
        from unittest.mock import patch
        mod = self.module()
        name = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'
        for upgrade in (False, True):
            for previous in (None, '200000', '800000'):
                with self.subTest(upgrade=upgrade, inherited=previous), \
                     tempfile.TemporaryDirectory(dir=ROOT) as td:
                    home = Path(td)
                    rc = home / '.zshrc'
                    rc.write_text('# keep shell configuration\n')
                    global_settings = home / '.claude/settings.json'
                    global_settings.parent.mkdir()
                    global_settings.write_text('{"env":{"KEEP":"yes"}}\n')
                    if upgrade:
                        state = mod.configure(home, '/usr/bin/python3')
                        installed = state / 'claude_openai.py'
                        installed.write_text('# previous installed version\n')
                        auth = state / 'auth/test.json'
                        auth.write_text('unit-test-credential-placeholder')
                        config = state / 'proxy.json'
                        custom = json.loads(config.read_text())
                        custom['routing']['retry']['request-retry'] = 4
                        config.write_text(json.dumps(custom))
                        preserved = {path: path.read_bytes() for path in (rc, auth, config)}
                    state = mod.configure(home, '/usr/bin/python3')
                    installed = runpy.run_path(str(state / 'claude_openai.py'), run_name='installed_test')
                    inherited = {'PATH': '/unit'}
                    if previous is not None:
                        inherited[name] = previous
                    with patch.dict(os.environ, inherited, clear=True):
                        before = dict(os.environ)
                        env, settings = installed['launch_spec'](
                            os.environ, 'http://127.0.0.1:12345', 'local-test-key', 'gpt-6-astra')
                        self.assertEqual(dict(os.environ), before)
                    self.assertEqual(env.get(name), '400000')
                    self.assertEqual(settings['env'].get(name), '400000')
                    self.assertNotIn(name, rc.read_text())
                    self.assertEqual(global_settings.read_text(), '{"env":{"KEEP":"yes"}}\n')
                    if upgrade:
                        for path, content in preserved.items():
                            self.assertEqual(path.read_bytes(), content)

    def test_context_limit_reaches_direct_and_wrapped_launches(self):
        name = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'
        for wrapper in (None, self.WRAPPER):
            for args in (['task'], ['-p', 'hello']):
                with self.subTest(wrapper=wrapper is not None, args=args), \
                     tempfile.TemporaryDirectory(dir=ROOT) as td:
                    _, state, _, call = self.run_claude_with(td, wrapper, args)
                    self.assertEqual(call.kwargs['env'].get(name), '400000')
                    settings = json.loads((state / 'claude-settings.json').read_text())
                    self.assertEqual(settings['env'].get(name), '400000')

    def test_launch_spec_replaces_duplicate_family_rows_with_gateway_model(self):
        mod = self.module()
        env, settings = mod.launch_spec({}, 'http://127.0.0.1:12345',
                                        'local-test-key', 'gpt-6-astra')
        self.assertEqual(settings.get('modelPicker'), {
            'replaceBuiltInOptions': True,
            'options': [{'model': 'gpt-6-astra', 'label': 'gpt-6-astra',
                         'description': 'Codex OAuth'}],
        })
        for family in ('OPUS', 'FABLE', 'SONNET', 'HAIKU'):
            self.assertEqual(env['ANTHROPIC_DEFAULT_' + family + '_MODEL'], 'gpt-6-astra')
        self.assertNotIn('availableModels', settings, 'Picker cleanup must not change model permissions')

    def test_claude_auto_wrapper_comes_from_the_live_source_and_is_not_started_by_the_check(self):
        from unittest.mock import patch
        mod = self.module()
        self.assertTrue(hasattr(mod, 'claude_auto_wrapper'), 'Wrapper lookup is missing')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            source = Path(td) / 'claude-auto'
            fixture = ("def passthrough(args):\n    return '--version' in args\n"
                       "def wrapper(args):\n    return 0\n"
                       "if __name__ == '__main__':\n    raise RuntimeError('wrapper must not run')\n")
            source.write_text(fixture)
            with patch.object(mod.shutil, 'which', return_value=str(source)):
                self.assertEqual(mod.claude_auto_wrapper(['task']), source)
                self.assertIsNone(mod.claude_auto_wrapper(['--version']))
                source.write_text('def passthrough(args):\n    return False\n')
                with self.assertRaisesRegex(RuntimeError, 'claude-auto wrapper'):
                    mod.claude_auto_wrapper(['task'])
            with patch.object(mod.shutil, 'which', return_value=None), \
                 patch.object(mod.Path, 'home', return_value=Path(td)):
                self.assertIsNone(mod.claude_auto_wrapper(['task']))
                installed = Path(td) / '.claude/claude-auto/claude-auto'
                installed.parent.mkdir(parents=True)
                installed.write_text(fixture)
                self.assertEqual(mod.claude_auto_wrapper(['task']), installed)

    def run_claude_with(self, td, source_text, user_args):
        from contextlib import contextmanager
        from unittest.mock import patch
        mod = self.module()
        state = mod.configure(Path(td), '/usr/bin/python3')
        source = Path(td) / 'claude-auto'
        if source_text is not None:
            source.write_text(source_text)
        @contextmanager
        def sidecar(_):
            yield 'http://127.0.0.1:12345', 'local-test-key', [{'id': 'gpt-6-astra'}], state, None
        with patch.object(mod.os, 'environ', {'PATH': '/unit'}), \
             patch.object(mod, 'proxy_session', sidecar), patch.object(mod, 'login'), \
             patch.object(mod.shutil, 'which', side_effect=lambda name: {
                 'claude': '/opt/bin/claude',
                 'claude-auto': str(source) if source_text is not None else None}.get(name)), \
             patch.object(mod.Path, 'home', return_value=Path(td)), \
             patch.object(mod.subprocess, 'run') as run:
            run.return_value.returncode = 0
            mod.run_claude(state, user_args)
        self.assertEqual(run.call_count, 1)
        return mod, state, source, run.call_args

    WRAPPER = ("def passthrough(args):\n    return '-p' in args\n"
               "def wrapper(args):\n    return 0\n"
               "if __name__ == '__main__':\n    raise RuntimeError('not started by the unit test')\n")

    def test_run_starts_claude_under_the_claude_auto_wrapper_with_routing_in_settings(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            user_args = ['--permission-mode', 'manual', '--', 'do this task']
            mod, state, source, call = self.run_claude_with(td, self.WRAPPER, user_args)
            self.assertEqual(call.args[0], [
                mod.sys.executable, str(source), '--settings', str(state / 'claude-settings.json'),
                '--model', 'gpt-6-astra'] + user_args)
            env = call.kwargs['env']
            self.assertEqual(env['CLAUDE_AUTO_CLAUDE'], '/opt/bin/claude')
            self.assertEqual(env['ANTHROPIC_MODEL'], 'gpt-6-astra')
            self.assertEqual(env['ANTHROPIC_BASE_URL'], 'http://127.0.0.1:12345')
            settings = json.loads((state / 'claude-settings.json').read_text())
            self.assertEqual(settings['model'], 'gpt-6-astra')
            self.assertEqual(settings['env']['ANTHROPIC_MODEL'], 'gpt-6-astra')
            self.assertTrue(settings['modelPicker']['replaceBuiltInOptions'])
            self.assertNotIn('hooks', settings, 'The wrapper merges its hooks into this file')
            self.assertNotIn('permissions', settings)
            self.assertNotIn('--append-system-prompt', call.args[0], 'The wrapper appends the rule itself')

    def test_run_starts_claude_directly_for_print_mode_and_when_claude_auto_is_absent(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            mod, state, _, call = self.run_claude_with(td, self.WRAPPER, ['-p', 'hello'])
            self.assertEqual(call.args[0], ['/opt/bin/claude', '--settings', str(state / 'claude-settings.json'),
                                            '--model', 'gpt-6-astra', '-p', 'hello'])
            self.assertNotIn('CLAUDE_AUTO_CLAUDE', call.kwargs['env'])
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            mod, state, _, call = self.run_claude_with(td, None, ['task'])
            self.assertEqual(call.args[0], ['/opt/bin/claude', '--settings', str(state / 'claude-settings.json'),
                                            '--model', 'gpt-6-astra', 'task'])

    def test_sidecar_requires_local_key_and_is_stopped_on_exit(self):
        import shutil
        import urllib.request
        import urllib.error
        mod = self.module()
        self.assertTrue(hasattr(mod, 'proxy_session'), 'Proxy lifecycle is not implemented')
        if not shutil.which('cliproxyapi'):
            self.skipTest('CLIProxyAPI integration dependency missing')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            state = mod.configure(Path(td), '/usr/bin/python3')
            with mod.proxy_session(state) as session:
                url, key, models, run_dir, process = session
                self.assertTrue(url.startswith('http://127.0.0.1:'))
                self.assertGreaterEqual(len(key), 32)
                self.assertEqual(models, [])
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(url + '/v1/models')
                self.assertEqual(error.exception.code, 401)
                self.assertIsNone(process.poll())
            self.assertIsNotNone(process.poll())
            self.assertFalse(run_dir.exists())

    def test_run_uses_selected_available_model_and_propagates_exit(self):
        from unittest.mock import patch
        from contextlib import contextmanager
        mod = self.module()
        self.assertTrue(hasattr(mod, 'run_claude'), 'Claude execution is not implemented')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            state = mod.configure(Path(td), '/usr/bin/python3')
            @contextmanager
            def sidecar(_):
                catalog = [{'id': name} for name in ('gpt-6-luna', 'gpt-6-astra',
                           'gpt-image-2', 'codex-auto-review', 'gpt-6-astra')]
                yield 'http://127.0.0.1:12345', 'local-test-key', catalog, state, None
            with patch.object(mod, 'proxy_session', sidecar), patch.object(mod, 'login'), \
                 patch.object(mod.shutil, 'which', return_value='/opt/bin/claude'), \
                 patch.object(mod.subprocess, 'run') as run:
                run.return_value.returncode = 7
                result = mod.run_claude(state, ['-p', 'hello'], capture=True)
                self.assertEqual(result.returncode, 7)
                self.assertEqual(run.call_args.args[0], ['/opt/bin/claude', '--settings', str(state / 'claude-settings.json'), '--model', 'gpt-6-astra', '-p', 'hello'])
                self.assertTrue(run.call_args.kwargs['capture_output'])
                settings = json.loads((state / 'claude-settings.json').read_text())
                picker = settings['modelPicker']
                self.assertTrue(picker['replaceBuiltInOptions'])
                self.assertEqual([row['model'] for row in picker['options']],
                                 ['gpt-6-astra', 'codex-auto-review', 'gpt-6-luna', 'gpt-image-2'])
                self.assertTrue(all(row['label'] == row['model'] for row in picker['options']))
                with self.assertRaisesRegex(RuntimeError, 'not available'):
                    mod.run_claude(state, ['--model', 'unknown-model', '-p', 'hello'])

    def test_uninstall_is_owned_repeatable_and_preserves_login(self):
        mod = self.module()
        self.assertTrue(hasattr(mod, 'uninstall'), 'Uninstall is not implemented')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            home = Path(td)
            rc = home / '.zshrc'
            rc.write_text('# keep this\n')
            state = mod.configure(home, '/usr/bin/python3')
            auth = state / 'auth/test.json'
            auth.write_text('unit-test-credential-placeholder')
            mod.uninstall(home, dry_run=True)
            self.assertTrue((home / '.local/bin/claude-openai').exists())
            mod.uninstall(home)
            self.assertFalse((home / '.local/bin/claude-openai').exists())
            self.assertNotIn(mod.BEGIN, rc.read_text())
            self.assertTrue(rc.read_text().startswith('# keep this\n'))
            self.assertEqual(auth.read_text(), 'unit-test-credential-placeholder')
            mod.uninstall(home)
            mod.configure(home, '/usr/bin/python3')
            self.assertEqual(rc.read_text().count(mod.BEGIN), 1)
            launcher = home / '.local/bin/claude-openai'
            launcher.write_text('# foreign executable\n')
            with self.assertRaisesRegex(RuntimeError, 'owned'):
                mod.uninstall(home)
            self.assertTrue(launcher.exists())

    def test_verify_requires_real_success_envelope_and_openai_model(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        mod = self.module()
        self.assertTrue(hasattr(mod, 'verify'), 'Live verification is not implemented')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            state = Path(td)
            valid = {'is_error': False, 'subtype': 'success', 'result': 'CLAUDE_OPENAI_OK',
                     'session_id': 'unit-test-session', 'modelUsage': {'gpt-6-astra': {'inputTokens': 1}}}
            with patch.object(mod, 'run_claude', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(valid), stderr='')) as run:
                report = mod.verify(state)
                self.assertEqual(report['session_id'], 'unit-test-session')
                self.assertEqual(report['models'], ['gpt-6-astra'])
                self.assertEqual(run.call_args.args[1], ['-p', 'Reply with exactly CLAUDE_OPENAI_OK and nothing else. Do not use any tools.', '--tools', '', '--max-turns', '2', '--output-format', 'json'])
                valid['is_error'] = True
                run.return_value.stdout = json.dumps(valid)
                with self.assertRaises(RuntimeError):
                    mod.verify(state)

    def test_install_command_includes_oauth_and_live_verification(self):
        from unittest.mock import patch
        mod = self.module()
        self.assertTrue(hasattr(mod, 'main'), 'Command dispatch is not implemented')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            home = Path(td)
            with patch.object(mod.Path, 'home', return_value=home), \
                 patch.object(mod.shutil, 'which', return_value='/existing/tool'), \
                 patch.object(mod, 'login') as login, \
                 patch.object(mod, 'verify', return_value={'verified': True}) as verify:
                self.assertEqual(mod.main(['install']), 0)
                state = home / '.local/share/claude-openai'
                login.assert_called_once_with(state)
                verify.assert_called_once_with(state)
                self.assertTrue((home / '.local/bin/claude-openai').exists())

    def test_configure_disables_error_payload_capture_on_reinstall(self):
        mod = self.module()
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            home = Path(td)
            state = mod.configure(home, '/usr/bin/python3')
            path = state / 'proxy.json'
            config = json.loads(path.read_text())
            self.assertTrue(config['server'].get('commercial-mode'), 'request-log=false alone still logs error bodies')
            config['server']['commercial-mode'] = False
            path.write_text(json.dumps(config))
            mod.configure(home, '/usr/bin/python3')
            self.assertTrue(json.loads(path.read_text())['server']['commercial-mode'])

    def test_proxy_environment_cannot_select_remote_credential_storage(self):
        mod = self.module()
        self.assertTrue(hasattr(mod, 'proxy_environment'), 'Dedicated proxy environment is missing')
        inherited = {'PATH': '/bin', 'HOME': '/safe/home', 'HOME_JWT': 'test-secret', 'home_jwt': 'test-secret',
                     'PGSTORE_DSN': 'test-secret', 'gitstore_git_url': 'https://example.invalid',
                     'OBJECTSTORE_ENDPOINT': 'https://example.invalid', 'MANAGEMENT_PASSWORD': 'test-secret',
                     'OPENAI_API_KEY': 'test-paid-key', 'ANTHROPIC_API_KEY': 'test-paid-key', 'DEPLOY': 'cloud'}
        env = mod.proxy_environment(inherited, Path('/private/run'))
        self.assertEqual(env, {'PATH': '/bin', 'HOME': '/safe/home', 'TMPDIR': '/private/run'})

    def test_proxy_waits_for_async_model_registration(self):
        from unittest.mock import patch, MagicMock
        import io
        mod = self.module()
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            state = mod.configure(Path(td), '/usr/bin/python3')
            (state / 'auth/test.json').write_text(json.dumps({'type': 'codex', 'access_token': 'unit-test-placeholder'}))
            opener = MagicMock()
            opener.open.side_effect = [io.StringIO('{"data": []}'), io.StringIO('{"data": [{"id":"gpt-6-astra"}]}')]
            process = MagicMock()
            process.poll.return_value = None
            with patch.object(mod.shutil, 'which', return_value='/mock/cliproxyapi'), \
                 patch.object(mod.urllib.request, 'build_opener', return_value=opener), \
                 patch.object(mod.subprocess, 'Popen', return_value=process), \
                 patch.object(mod.time, 'sleep'):
                with mod.proxy_session(state) as session:
                    self.assertEqual(session[2], [{'id': 'gpt-6-astra'}])
                self.assertEqual(opener.open.call_count, 2)
                process.terminate.assert_called_once()

if __name__ == '__main__':
    unittest.main()
