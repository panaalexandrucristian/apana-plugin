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

    def run_claude_with(self, td, source_text, user_args, inherited=None):
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
        with patch.object(mod.os, 'environ', dict({'PATH': '/unit'}, **(inherited or {}))), \
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

    def test_cooperation_inherits_openai_routing_across_real_wrapper_handoff(self):
        import subprocess
        import sys
        import textwrap
        wrapper = ROOT.parent.parent / 'install-claude-auto/assets/claude-auto'
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            home = Path(td)
            database = str(home / 'registry.sqlite3')
            inherited = {'PATH': os.environ['PATH'], 'HOME': td,
                         'CLAUDE_AUTO_COOPERATE': '1', 'CLAUDE_AUTO_COOP_DB': database,
                         'CLAUDE_AUTO_BOOTSTRAP': '0', 'CLAUDE_AUTO_RULE': 'off',
                         'CLAUDE_AUTO_DIR': str(home / 'handoffs'),
                         'CLAUDE_AUTO_POLL': '0.02', 'CLAUDE_AUTO_GRACE': '0.02'}
            # Exercise the actual proxy_session lifetime around a real wrapper handoff,
            # not a settings file obtained after a mocked session already ended.
            plugin = home / 'cooperation'
            (plugin / '.claude-plugin').mkdir(parents=True)
            (plugin / '.claude-plugin/plugin.json').write_text('{"name":"cooperation"}')
            (plugin / 'scripts').mkdir()
            (plugin / 'scripts/registry.py').write_text('')
            (plugin / 'hooks').mkdir()
            (plugin / 'hooks/hooks.json').write_text('{}')
            (plugin / 'hooks/register.ts').write_text('')
            (plugin / 'types').mkdir()
            (plugin / 'types/index.d.ts').write_text('')
            calls_file = home / 'calls.jsonl'
            fake = home / 'fake-claude'
            fake.write_text('#!' + sys.executable + '\n' + textwrap.dedent('''
                import json, os, pathlib, sys, time
                calls = pathlib.Path(os.environ['HOME']) / 'calls.jsonl'
                first = not calls.exists()
                settings = json.loads(pathlib.Path(sys.argv[sys.argv.index('--settings') + 1]).read_text())
                snapshot = pathlib.Path(os.environ['CATALOG_SNAPSHOT_TEST'])
                assert snapshot.is_file(), 'snapshot must outlive the first Claude child'
                with calls.open('a') as output:
                    output.write(json.dumps({'argv': sys.argv[1:], 'env': dict(os.environ), 'settings': settings,
                                             'snapshot': snapshot.read_text()}) + '\\n')
                if first:
                    signal = pathlib.Path(os.environ['CLAUDE_AUTO_RUN']) / 'signal.json'
                    signal.write_text(json.dumps({'handoff': str(calls.parent / 'HANDOFF.md'), 'session_id': 'first'}))
                    time.sleep(60)
            '''))
            fake.chmod(0o755)
            import io
            from types import SimpleNamespace
            from unittest.mock import patch, MagicMock
            mod = self.module()
            state = mod.configure(home, sys.executable)
            before = (state / 'proxy.json').read_bytes()
            process = MagicMock()
            process.poll.return_value = None
            sources, directories = [], []
            def opened(req, **kw):
                if '/v1/models' in req.full_url:
                    return io.BytesIO(b'{"data":[{"id":"gpt-6-astra"},{"id":"gpt-image-2"}]}')
                sources.append(req.full_url)
                response = io.BytesIO(json.dumps(catalog_fixture()).encode())
                response.status, response.headers = 200, {}
                return response
            opener = MagicMock()
            opener.open.side_effect = opened
            def spawn(command, **kw):
                if '_catalog-worker' in command:
                    return inline_catalog_worker(mod, command)
                directories.append(Path(kw['cwd']))
                return process
            def invoke(command, **kw):
                if '--help' in command:
                    return subprocess.CompletedProcess(command, 0,
                        'CLIProxyAPI Version: 8.0.40, Commit: Homebrew, BuiltAt: fixture\n', '')
                runtime = json.loads((directories[0] / 'proxy.json').read_text())
                kw['env']['CATALOG_SNAPSHOT_TEST'] = runtime['models']['catalog']
                return subprocess.run(command, timeout=30, **kw)
            with patch.object(mod, 'subprocess', SimpleNamespace(run=invoke, Popen=spawn,
                              TimeoutExpired=subprocess.TimeoutExpired, PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL)), \
                 patch.object(mod.shutil, 'which', side_effect=lambda n: {
                     'claude': str(fake), 'cliproxyapi': '/mock/cliproxyapi', 'claude-auto': str(wrapper)}.get(n)), \
                 patch.object(mod.urllib.request, 'build_opener', return_value=opener), \
                 patch.object(mod, 'login'), patch.dict(os.environ, inherited, clear=True):
                result = mod.run_claude(state, ['task'], capture=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(sources), 1, 'handoff must not fetch a second catalog')
            self.assertEqual((state / 'proxy.json').read_bytes(), before)
            process.terminate.assert_called_once()
            self.assertFalse(directories[0].exists())
            calls = [json.loads(line) for line in calls_file.read_text().splitlines()]
            self.assertEqual(len(calls), 2)
            member = calls[0]['env']['CLAUDE_AUTO_COOP_MEMBER']
            for generation, child in enumerate(calls, 1):
                self.assertEqual(child['env']['CLAUDE_AUTO_COOP_MEMBER'], member)
                self.assertEqual(child['env']['CLAUDE_AUTO_COOP_GENERATION'], str(generation))
                self.assertEqual(child['env']['CLAUDE_AUTO_COOP_DB'], database)
                self.assertEqual(child['env'].get('CLAUDE_AUTO_COOP_CONTINUATION'), '1' if generation > 1 else None)
                self.assertTrue(child['env']['ANTHROPIC_BASE_URL'].startswith('http://127.0.0.1:'))
                self.assertEqual(child['env']['ANTHROPIC_BASE_URL'], calls[0]['env']['ANTHROPIC_BASE_URL'])
                self.assertEqual(child['env']['ANTHROPIC_MODEL'], 'gpt-6-astra')
                self.assertEqual(child['env']['ANTHROPIC_AUTH_TOKEN'], calls[0]['env']['ANTHROPIC_AUTH_TOKEN'])
                self.assertEqual(child['snapshot'], calls[0]['snapshot'])
                self.assertEqual(json.loads(child['snapshot']), catalog_fixture())
                self.assertEqual(child['settings']['env']['ANTHROPIC_MODEL'], 'gpt-6-astra')
                self.assertIn('--plugin-dir', child['argv'])
                self.assertIn('gpt-6-astra', child['argv'])
            self.assertEqual(calls[0]['env']['CLAUDE_AUTO_RUN'], calls[1]['env']['CLAUDE_AUTO_RUN'])

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
        sandbox = shutil.which('sandbox-exec')
        if not sandbox:
            self.fail('Installed CLIProxyAPI lifecycle needs an available loopback-only sandbox; refusing metadata egress')
        import subprocess
        from types import SimpleNamespace
        from unittest.mock import patch
        profile = ('(version 1)(allow default)(deny network*)'
                   '(allow network-inbound (local ip "localhost:*"))'
                   '(allow network-outbound (remote ip "localhost:*"))')
        def isolated_run(command, **kw):
            return subprocess.run([sandbox, '-p', profile] + command, **kw)
        def isolated_spawn(command, **kw):
            return subprocess.Popen([sandbox, '-p', profile] + command, **kw)
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            state = mod.configure(Path(td), '/usr/bin/python3')
            # Only the actual proxy children need network isolation. Sandboxing the
            # whole suite prevents macOS's ps from running in the fake-Claude handoff.
            with patch.object(mod, 'subprocess', SimpleNamespace(run=isolated_run, Popen=isolated_spawn,
                              TimeoutExpired=subprocess.TimeoutExpired)), \
                 patch.dict(mod.os.environ, {'HOME': td, 'PATH': os.environ['PATH']}, clear=True), \
                 patch.object(mod, 'fetch_catalog', return_value=catalog_fixture()), mod.proxy_session(state) as session:
                url, key, models, run_dir, process = session
                self.assertTrue(url.startswith('http://127.0.0.1:'))
                self.assertGreaterEqual(len(key), 32)
                self.assertEqual(models, [])
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(url + '/v1/models')
                with error.exception:
                    self.assertEqual(error.exception.code, 401)
                self.assertTrue(error.exception.closed)
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

    def assert_runtime_image_policy(self, multimedia, expected):
        from unittest.mock import patch, MagicMock
        import io
        mod = self.module()
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            state = Path(td)
            config = {'config-version': 8, 'server': {'host': '127.0.0.1', 'port': 18317},
                      'access': {'api-keys': ['source-only-key']},
                      'observability': {'logs': {'request-log': True}}}
            if multimedia is not None:
                config['multimedia'] = multimedia
            source = state / 'proxy.json'
            source.write_text(json.dumps(config, indent=2) + '\n')
            original = source.read_bytes()
            opener = MagicMock()
            opener.open.return_value = io.StringIO('{"data": [{"id": "gpt-test"}]}')
            process = MagicMock()
            process.poll.return_value = None
            with patch.object(mod.shutil, 'which', return_value='/mock/cliproxyapi'), \
                 patch.object(mod.socket, 'socket') as socket, \
                 patch.object(mod, 'catalog_adapter_supported', return_value=False), \
                 patch.object(mod.urllib.request, 'build_opener', return_value=opener), \
                 patch.object(mod.subprocess, 'Popen', return_value=process):
                socket.return_value.__enter__.return_value.getsockname.return_value = ('127.0.0.1', 23456)
                with mod.proxy_session(state) as (_, key, _, run_dir, _):
                    runtime = json.loads((run_dir / 'proxy.json').read_text())
                    self.assertEqual(source.read_bytes(), original)
                    self.assertEqual(runtime.get('multimedia', {}).get('disable-image-generation'), expected)
                    expected_config = json.loads(original)
                    expected_config['server']['port'] = 23456
                    expected_config['access']['api-keys'] = [key]
                    expected_config.setdefault('multimedia', {})['disable-image-generation'] = expected
                    self.assertEqual(runtime, expected_config)
                self.assertEqual(source.read_bytes(), original)
                self.assertFalse(run_dir.exists())
                process.terminate.assert_called_once()

    def test_runtime_defaults_image_generation_to_passthrough_without_persisting(self):
        for multimedia in (None, {}, {'gpt-image-2-base-model': 'gpt-test'}):
            with self.subTest(multimedia=multimedia):
                self.assert_runtime_image_policy(multimedia, 'passthrough')

    def test_runtime_preserves_explicit_image_generation_policy_without_persisting(self):
        for value in (False, True, 'chat', 'passthrough'):
            with self.subTest(value=value):
                self.assert_runtime_image_policy(
                    {'disable-image-generation': value, 'gpt-image-2-base-model': 'gpt-test'}, value)

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
                 patch.object(mod, 'catalog_adapter_supported', return_value=False), \
                 patch.object(mod.urllib.request, 'build_opener', return_value=opener), \
                 patch.object(mod.subprocess, 'Popen', return_value=process), \
                 patch.object(mod.time, 'sleep'):
                with mod.proxy_session(state) as session:
                    self.assertEqual(session[2], [{'id': 'gpt-6-astra'}])
                self.assertEqual(opener.open.call_count, 2)
                process.terminate.assert_called_once()

# Authentic RAW Codex sections, frozen from the two general catalogs on 2026-10-31.
# Source: CLIProxyAPI v8.0.40/internal/registry/models/models.json (d946c4f);
# full-file SHA256 202d50ff901832d8ed915db9a4f852e957ea5c2370b5f8bbfac7db226ba8b7d9.
# Public: https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json;
# full-file SHA256 32f663de911083339cf5347be74b0b4cbf1471bc1968362897cc94ebf021c306.
# Reproduce: select codex-free/team/plus/pro without modifying their records, json.dumps
# (sort_keys=True, separators=(',', ':'), ensure_ascii=True), zlib.compress, base64.b64encode.
# This is test data, not a maintained runtime model list or getter/API output.
CATALOG_FIXTURES = ('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')


def catalog_fixture(index=0):
    import base64
    import zlib
    return json.loads(zlib.decompress(base64.b64decode(CATALOG_FIXTURES[index])))


def inline_catalog_worker(mod, command):
    """Mock only process transport; execute the real worker/download code under mocked HTTP."""
    from unittest.mock import MagicMock
    process = MagicMock()
    process.poll.return_value = None
    def communicate(data, timeout):
        try:
            mod.catalog_worker(Path(command[-1]), json.loads(data))
            process.returncode = 0
        except (ValueError, OSError, RecursionError):
            process.returncode = 1
        process.poll.return_value = process.returncode
        return None, None
    process.communicate.side_effect = communicate
    return process


class CatalogTests(unittest.TestCase):
    module = InstallerTests.module

    def exercise(self, catalog, *, event=True, publish=True, version='8.0.40',
                 inventory=None, args=(), requested=None, dead=False, api_bad=False,
                 wrapper=None, child_error=False, config_extra=None):
        """Real orchestration/HTTP-read/readiness; only external boundaries are mocked.

        Batch lines below are source-derived fixtures, NOT captured live events.
        The fake sidecar starts with embedded inventory; publishes only AFTER a poll.
        """
        import io
        from contextlib import ExitStack
        from unittest.mock import patch, MagicMock
        mod = self.module()
        calls, snapshots, settings, directories, runtimes = [], [], [], [], []
        clock = [0.0]
        old = catalog_fixture()
        baseline_rows = old['codex-plus'] + [{'id': 'gpt-image-2'}]
        current_rows = (catalog or old).get('codex-plus', []) + [{'id': 'gpt-image-2'}]
        process = MagicMock()
        process.poll.return_value = 1 if dead else None
        with tempfile.TemporaryDirectory(dir=ROOT) as td, ExitStack() as stack:
            state = mod.configure(Path(td), '/usr/bin/python3')
            global_settings = Path(td) / '.claude/settings.json'
            global_settings.parent.mkdir()
            global_settings.write_text('{"permissions":{"defaultMode":"manual"},"hooks":{}}')
            if config_extra:
                config = json.loads((state / 'proxy.json').read_text())
                config.update(config_extra)
                (state / 'proxy.json').write_text(json.dumps(config))
            persistent = {p: p.read_bytes() for p in (state / 'proxy.json', Path(td) / '.zshrc', global_settings)}
            (state / 'auth/test.json').write_text('{"type":"codex","access_token":"fake-oauth"}')
            def spawn(command, **kw):
                if '_catalog-worker' in command:
                    self.assertEqual(command[1], '-I')
                    self.assertNotIn('fake-oauth', ' '.join(command))
                    self.assertNotIn('ANTHROPIC_AUTH_TOKEN', kw['env'])
                    self.assertNotIn('OPENAI_API_KEY', kw['env'])
                    return inline_catalog_worker(mod, command)
                run_dir = Path(kw['cwd'])
                directories.append(run_dir)
                runtime = json.loads((run_dir / 'proxy.json').read_text())
                runtimes.append(runtime)
                if config_extra and 'oauth-model-alias' in config_extra:
                    self.assertEqual(runtime['oauth-model-alias'], config_extra['oauth-model-alias'])
                source = runtime.get('models', {}).get('catalog')
                if source and Path(source).is_absolute():
                    path = Path(source)
                    self.assertTrue(path.is_absolute())
                    self.assertEqual(path.parent.parent, run_dir)
                    self.assertEqual(list(path.parent.iterdir()), [path])
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
                    snapshots.append(json.loads(path.read_text()))
                self.assertEqual(command[-1], '-local-model')
                self.assertTrue(runtime['server']['commercial-mode'])
                self.assertFalse(runtime['plugins']['enabled'])
                return process
            api_reads = [0]
            def opened(req, **kw):
                url = req.full_url
                calls.append((url, dict(req.header_items()), kw))
                if '/v1/models' not in url:
                    if catalog is None:
                        raise mod.urllib.error.URLError('offline fixture failure')
                    response = io.BytesIO(json.dumps(catalog).encode())
                    response.status = 200
                    response.headers = {}
                    return response
                api_reads[0] += 1
                if api_reads[0] == 1 and event:
                    providers = 'codex' if event is True else event
                    with (directories[0] / 'proxy.log').open('a') as log:
                        log.write('[2026-10-31 12:00:00] [--------] [info ] [service_plugins.go:406] '
                                  're-registered models for 2 auth(s) due to model catalog changes: [' + providers + ']\n')
                rows = inventory if inventory is not None else (
                    current_rows if api_reads[0] > 1 and publish else baseline_rows)
                # Duplicate API rows are legal; only the generated menu deduplicates.
                payload = {'data': rows + rows[:1]} if isinstance(rows, list) else rows
                return io.BytesIO(b'broken' if api_bad else json.dumps(payload).encode())
            opener = MagicMock()
            opener.open.side_effect = opened
            def run(command, **kw):
                if '--help' in command:
                    return mod.subprocess.CompletedProcess(command, 0,
                        'CLIProxyAPI Version: ' + version + ', Commit: Homebrew, BuiltAt: 2026-10-23T00:09:28Z\n', '')
                self.assertTrue(directories[0].exists())
                selected = json.loads(Path(command[command.index('--settings') + 1]).read_text())
                settings.append((command, selected, kw['env']))
                if child_error:
                    raise OSError('fixture child failed')
                return mod.subprocess.CompletedProcess(command, 0)
            stderr = io.StringIO()
            stack.enter_context(patch.object(mod.shutil, 'which', side_effect=lambda n: '/mock/' + n))
            stack.enter_context(patch.object(mod, 'claude_auto_wrapper', return_value=wrapper))
            stack.enter_context(patch.object(mod.subprocess, 'Popen', side_effect=spawn))
            stack.enter_context(patch.object(mod.subprocess, 'run', side_effect=run))
            stack.enter_context(patch.object(mod.urllib.request, 'build_opener', return_value=opener))
            stack.enter_context(patch.object(mod.time, 'monotonic', side_effect=lambda: clock[0]))
            stack.enter_context(patch.object(mod.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0] + n)))
            stack.enter_context(patch.object(mod.sys, 'stderr', stderr))
            stack.enter_context(patch.dict(os.environ, {'CLAUDE_OPENAI_MODEL': requested or ''}))
            failure = None
            try:
                mod.run_claude(state, list(args))
            except (RuntimeError, OSError) as error:
                failure = error
            for path, content in persistent.items():
                self.assertEqual(path.read_bytes(), content)
            self.assertTrue(all(not d.exists() for d in directories))
            if not dead:
                process.terminate.assert_called_once()
            return dict(calls=calls, snapshots=snapshots, settings=settings, stderr=stderr.getvalue(),
                        reads=api_reads[0], elapsed=clock[0], failure=failure, runtimes=runtimes)

    def test_consecutive_launches_download_real_snapshots_and_refresh_picker(self):
        results = [self.exercise(catalog_fixture(i), publish=True) for i in (0, 1, 1)]
        for i, result in enumerate(results):
            self.assertIsNone(result['failure'])
            self.assertEqual(result['snapshots'], [catalog_fixture(0 if i == 0 else 1)])
            public = [c for c in result['calls'] if '/v1/models' not in c[0]]
            self.assertEqual(len(public), 1)
            self.assertNotIn('Authorization', public[0][1])
            self.assertNotIn('Cookie', public[0][1])
            picker = result['settings'][0][1]['modelPicker']
            rows = [r['model'] for r in picker['options']]
            self.assertTrue(picker['replaceBuiltInOptions'])
            self.assertEqual(rows[0], 'gpt-6-astra')
            self.assertEqual(len(rows), len(set(rows)))
            self.assertIn('gpt-image-2', rows)
            self.assertIn('codex-auto-review', rows)
            self.assertEqual('gpt-5.5' in rows, i == 0)
            self.assertEqual('gpt-6.1-terra' in rows, i > 0)
            if i:
                self.assertGreater(result['reads'], 1)
                self.assertIn('batch observed', result['stderr'])
                self.assertIn('per-credential', result['stderr'])

    def test_explicit_sources_flow_through_runtime_without_public_fallback(self):
        for scheme in ('http', 'https'):
            source = scheme + '://unit.invalid/custom-models.json'
            extra = {'models': {'catalog': source, 'codex-catalog': '/separate/catalog.json',
                                'devin-catalog': '/separate/devin.json'}}
            for data in (catalog_fixture(1), None):
                result = self.exercise(data, config_extra=extra)
                self.assertIsNone(result['failure'])
                public = [c[0] for c in result['calls'] if '/v1/models' not in c[0]]
                self.assertEqual(public, [source])
                self.assertEqual(bool(result['snapshots']), data is not None)
                runtime = result['runtimes'][0]['models']
                self.assertEqual(runtime['codex-catalog'], extra['models']['codex-catalog'])
                self.assertEqual(runtime['devin-catalog'], extra['models']['devin-catalog'])
                if data is None:
                    self.assertNotIn('catalog', runtime, 'sidecar must not re-fetch the rejected source outside our limits')
                    self.assertIn('embedded', result['stderr'])
                    self.assertNotIn(source, result['stderr'])
            unknown = self.exercise(None, version='8.1.0', config_extra=extra)
            self.assertEqual(unknown['runtimes'][0]['models'], extra['models'])
            self.assertFalse([c for c in unknown['calls'] if '/v1/models' not in c[0]])
        absent = self.exercise(None, config_extra=extra, args=['--model=gpt-6.1-terra'])
        self.assertIn('not available', str(absent['failure']))
        self.assertFalse(absent['settings'])

    def test_raw_fingerprints_reproduce_tag_and_preserve_order_and_fields(self):
        mod = self.module()
        baseline = catalog_fixture()
        self.assertEqual(mod.catalog_fingerprints(baseline), mod.CODEX_BASELINE)
        for kind in ('reorder', 'unknown', 'false'):
            changed = catalog_fixture()
            if kind == 'reorder':
                changed['codex-plus'].reverse()
            else:
                # Go ignores unknown fields and decodes absent/false identically.
                changed['codex-plus'][0]['unknown_fixture_field' if kind == 'unknown'
                                         else 'support_configuration_update'] = False
            with self.subTest(kind=kind):
                self.assertNotEqual(mod.catalog_fingerprints(changed), mod.CODEX_BASELINE)
                # Upstream alias collision is order-sensitive: do not replace its policy
                # with an ID-set comparison or attempt to implement it in the launcher.
                aliases = {'oauth-model-alias': {'codex': [{'name': 'gpt-5.5', 'alias': 'gpt-6-astra'}]}}
                result = self.exercise(changed, event=False, config_extra=aliases)
                self.assertIsNone(result['failure'])
                self.assertGreaterEqual(result['elapsed'], 30)
                self.assertIn('unconfirmed', result['stderr'])
                self.assertNotIn('application failed', result['stderr'])
        self.assertLess(self.exercise(baseline, event=False)['elapsed'], 1)

    def test_aggregate_event_is_not_per_credential_publication_proof(self):
        # Simulates skipped/changed auth and helper success without publication.
        for event in (False, 'claude', 'codex-extra', 'claude codex', 'codex'):
            with self.subTest(event=event):
                result = self.exercise(catalog_fixture(1), event=event, publish=False)
                self.assertIsNone(result['failure'])
                self.assertIn('unconfirmed', result['stderr'])
                rows = result['settings'][0][1]['modelPicker']['options']
                self.assertIn('gpt-5.5', [r['model'] for r in rows])
                self.assertNotIn('gpt-6.1-terra', [r['model'] for r in rows])
                self.assertEqual('batch observed' in result['stderr'], event in ('codex', 'claude codex'))

    def test_sync_degrades_but_launch_errors_and_selection_are_preserved(self):
        for overrides in ({'catalog': None}, {'catalog': catalog_fixture(1), 'version': '8.1.0'},
                          {'catalog': {}, 'event': False}):
            result = self.exercise(**overrides)
            self.assertIsNone(result['failure'])
            self.assertIn('warning', result['stderr'])
            self.assertIn('unconfirmed', result['stderr'])
            self.assertEqual(result['snapshots'], [])
        for kw, message in (({'dead': True}, 'exited'), ({'api_bad': True}, 'ready'),
                            ({'inventory': [{'id': 'codex-auto-review'}]}, 'No GPT'),
                            ({'args': ['--model', 'gpt-5.5']}, 'not available')):
            result = self.exercise(catalog_fixture(1), **kw)
            self.assertIsNotNone(result['failure'])
            self.assertIn(message, str(result['failure']))
            self.assertFalse(result['settings'])
        image = self.exercise(catalog_fixture(1), inventory=[{'id': 'gpt-image-2'}])
        self.assertIsNone(image['failure'])
        self.assertEqual(image['settings'][0][1]['model'], 'gpt-image-2')
        for wrapper in (None, Path('/mock/claude-auto')):
            result = self.exercise(catalog_fixture(1), requested='gpt-5.5',
                                   args=['--model=gpt-6-astra', '--permission-mode', 'manual'], wrapper=wrapper)
            self.assertIsNone(result['failure'])
            command, settings, env = result['settings'][0]
            self.assertIn('manual', command)
            self.assertEqual(settings['model'], 'gpt-6-astra')
            self.assertEqual(env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'], '400000')
            self.assertNotIn('hooks', settings)
            self.assertNotIn('permissions', settings)
        self.assertIsNotNone(self.exercise(catalog_fixture(1), child_error=True)['failure'])

    def test_catalog_structure_and_inventory_validation(self):
        mod = self.module()
        good = catalog_fixture()
        for tier in good:
            empty = dict(good, **{tier: []})
            self.assertEqual(mod.validate_catalog(json.dumps(empty).encode()), empty)
        bad = [b'{}', b'{', b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}']
        for tier in good:
            missing = dict(good)
            missing.pop(tier)
            bad.append(json.dumps(missing).encode())
        for rows in (None, {}, [{'id': ''}], [{'id': 2}], [{'id': ' spaced '}],
                     [{'id': 'same'}, {'id': 'same'}], [None]):
            bad.append(json.dumps(dict(good, **{'codex-plus': rows})).encode())
        for data in bad:
            with self.subTest(data=data[:70]), self.assertRaises(ValueError):
                mod.validate_catalog(data)
        for payload in ({}, [], {'data': {}}, {'data': [None]}, {'data': [{'id': ''}]}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                mod.validate_inventory(payload)
        self.assertEqual(mod.validate_inventory({'data': [{'id': 'gpt-image-2'}]}), [{'id': 'gpt-image-2'}])

    def test_log_and_version_matchers_use_exact_source_tokens(self):
        mod = self.module()
        # Source-derived formatting, not live captures. Real --help banner was captured separately.
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            log = Path(td) / 'proxy.log'
            # Authentic installed 8.0.40/Homebrew capture, 2026-10-31. New isolated
            # HOME/config, fictitious credential, OS sandbox allowed loopback only.
            # This is batch evidence, NOT provider/inference or real-account evidence.
            log.write_text('[2026-10-31 19:51:16] [--------] [info ] [service_plugins.go:406] '
                           're-registered models for 1 auth(s) due to model catalog changes: '
                           '[codex kimi kimi-ai kimi.ai kimi.com xai]\n')
            self.assertTrue(mod.catalog_batch_observed(log))
            for count, providers, expected in ((2, 'codex', True), (1, 'claude codex', True),
                                              (0, 'codex', False), (1, 'codex-extra', False),
                                              (1, 'claude', False), (1, 'codex,claude', False)):
                for prefix in ('', '[2026-10-31 12:00:00] [--------] [info ] ',
                               '[2026-10-31 12:00:00] [--------] [info ] [service_plugins.go:406] '):
                    log.write_text(prefix + 're-registered models for ' + str(count)
                                   + ' auth(s) due to model catalog changes: [' + providers + ']\n')
                    self.assertEqual(mod.catalog_batch_observed(log), expected)

    def test_version_detection_is_exact_and_bounded(self):
        from unittest.mock import patch
        mod = self.module()
        for version, supported in (('8.0.40', True), ('8.0.400', False), ('8.0.40-dev', False), ('unknown', False)):
            output = 'CLIProxyAPI Version: ' + version + ', Commit: Homebrew, BuiltAt: 2026-10-23T00:09:28Z\n'
            with patch.object(mod.subprocess, 'run', return_value=mod.subprocess.CompletedProcess([], 0, output, '')) as run:
                self.assertEqual(mod.catalog_adapter_supported('/mock/proxy', {}, ROOT), supported)
                self.assertEqual(run.call_args.kwargs['timeout'], 3)
                self.assertEqual(run.call_args.args[0], ['/mock/proxy', '--help'])
        with patch.object(mod.subprocess, 'run', side_effect=mod.subprocess.TimeoutExpired('help', 3)):
            self.assertFalse(mod.catalog_adapter_supported('/mock/proxy', {}, ROOT))

    def test_download_sources_redirects_limits_and_no_auth(self):
        import io
        from unittest.mock import patch, MagicMock
        mod = self.module()
        raw = json.dumps(catalog_fixture()).encode()
        def response(body=raw, status=200):
            value = io.BytesIO(body)
            value.status, value.headers = status, {}
            return value
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            local = Path(td) / 'catalog.json'
            local.write_bytes(raw)
            opener = MagicMock()
            with patch.object(mod.urllib.request, 'build_opener', return_value=opener), \
                 patch.object(mod.subprocess, 'Popen', side_effect=lambda command, **kw: inline_catalog_worker(mod, command)):
                self.assertEqual(mod.fetch_catalog(str(local)), catalog_fixture())
                opener.open.assert_not_called()
                for source in ('embed', 'disabled', 'relative.json', 'file:///tmp/catalog.json'):
                    with self.subTest(source=source), self.assertRaises(ValueError):
                        mod.fetch_catalog(source)
                for source in ('http://unit.invalid/catalog', 'https://unit.invalid/catalog'):
                    opener.open.return_value = response()
                    self.assertEqual(mod.fetch_catalog(source), catalog_fixture())
                    req = opener.open.call_args.args[0]
                    self.assertEqual(req.full_url, source)
                    self.assertFalse(any(k.lower() in ('authorization', 'cookie', 'proxy-authorization')
                                         for k, _ in req.header_items()))
                opener.open.reset_mock()
                opener.open.side_effect = mod.urllib.error.URLError('explicit failure')
                with self.assertRaises(ValueError):
                    mod.fetch_catalog('https://unit.invalid/catalog')
                self.assertEqual(opener.open.call_count, 1)
                opener.open.reset_mock()
                with self.assertRaises(ValueError):
                    mod.fetch_catalog()
                self.assertEqual([c.args[0].full_url for c in opener.open.call_args_list], list(mod.CATALOG_URLS))
                opener.open.side_effect = None
                for size, valid in ((len(raw), True), (len(raw)-1, False)):
                    reader = response()
                    opener.open.return_value = reader
                    with patch.object(mod, 'CATALOG_MAX_BYTES', size):
                        if valid:
                            self.assertEqual(mod.fetch_catalog(), catalog_fixture())
                        else:
                            with self.assertRaises(ValueError):
                                mod.fetch_catalog('https://unit.invalid/catalog')
                            self.assertTrue(reader.closed)
                for target, allowed in (('https://other.invalid/catalog', True),
                                        ('http://other.invalid/catalog', False), ('file:///tmp/x', False)):
                    opener.open.side_effect = [mod.urllib.error.HTTPError(
                        'https://unit.invalid/catalog', 302, 'Found', {'Location': target}, io.BytesIO()), response()]
                    if allowed:
                        self.assertEqual(mod.fetch_catalog('https://unit.invalid/catalog'), catalog_fixture())
                    else:
                        with self.assertRaises(ValueError):
                            mod.fetch_catalog('https://unit.invalid/catalog')
                opener.open.side_effect = None
                opener.open.return_value = response(status=500)
                with self.assertRaises(ValueError):
                    mod.fetch_catalog('https://unit.invalid/catalog')

    def test_worker_deadline_kills_blocked_process_and_leaves_existing_alarm(self):
        import signal
        import subprocess
        import time
        from unittest.mock import patch
        mod = self.module()
        children = []
        actual_popen = subprocess.Popen
        def blocked(command, **kw):
            child = actual_popen([mod.sys.executable, '-I', '-c',
                                  'import sys,time; sys.stdin.buffer.read(); time.sleep(60)'], **kw)
            children.append(child)
            return child
        previous = signal.getsignal(signal.SIGALRM)
        signal.setitimer(signal.ITIMER_REAL, 10, 10)
        try:
            before = signal.getitimer(signal.ITIMER_REAL)
            with patch.object(mod.subprocess, 'Popen', side_effect=blocked), \
                 patch.object(mod.urllib.request, 'build_opener', side_effect=AssertionError('download escaped worker')), \
                 patch.object(mod, 'CATALOG_TOTAL_SECONDS', 0.2):
                start = time.monotonic()
                with self.assertRaises(ValueError):
                    mod.fetch_catalog('https://unit.invalid/catalog')
                elapsed = time.monotonic() - start
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].poll())
            self.assertLess(elapsed, 2)
            self.assertGreaterEqual(elapsed, 0.15)
            after = signal.getitimer(signal.ITIMER_REAL)
            self.assertLessEqual(after[0], before[0])
            self.assertGreater(after[0], 8)
            self.assertEqual(after[1], 10)
            self.assertIs(signal.getsignal(signal.SIGALRM), previous)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.wait()

    def test_total_deadline_kills_in_progress_trickle_without_resetting_budget(self):
        import subprocess
        import textwrap
        import time
        from unittest.mock import patch
        mod = self.module()
        actual_popen = subprocess.Popen
        children = []
        # Trusted test driver, not fetched code; real worker transport with mocked
        # network. Its read progresses continuously but never returns to Python's loop.
        driver = textwrap.dedent('''
            import importlib.util,json,pathlib,sys,time
            from unittest.mock import MagicMock
            spec=importlib.util.spec_from_file_location('bridge',sys.argv[1])
            mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
            response=MagicMock(); response.status=200; response.__enter__.return_value=response
            def trickle(size):
                with pathlib.Path(sys.argv[3]).open('ab', buffering=0) as progress:
                    while True:
                        progress.write(b'x'); time.sleep(.005)
            response.read.side_effect=trickle
            opener=MagicMock(); opener.open.return_value=response
            mod.urllib.request.build_opener=lambda *args: opener
            mod.catalog_worker(pathlib.Path(sys.argv[2]),json.loads(sys.stdin.buffer.read()))
        ''')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            progress = Path(td) / 'progress'
            def spawn(command, **kw):
                child = actual_popen([mod.sys.executable, '-I', '-c', driver,
                                      str(ROOT / 'claude_openai.py'), command[-1], str(progress)], **kw)
                children.append(child)
                return child
            with patch.object(mod.subprocess, 'Popen', side_effect=spawn), \
                 patch.object(mod, 'CATALOG_TOTAL_SECONDS', 0.4):
                start = time.monotonic()
                with self.assertRaises(ValueError):
                    mod.fetch_catalog('https://unit.invalid/catalog', td)
                self.assertLess(time.monotonic() - start, 2)
            self.assertGreater(len(progress.read_bytes()), 1)
            self.assertIsNotNone(children[0].poll())
            self.assertEqual(list(Path(td).iterdir()), [progress])

    def test_bad_http_transport_and_unreadable_version_degrade(self):
        import http.client
        from unittest.mock import patch, MagicMock
        mod = self.module()
        opener = MagicMock()
        opener.open.side_effect = http.client.BadStatusLine('malformed fixture status')
        with patch.object(mod.urllib.request, 'build_opener', return_value=opener), \
             patch.object(mod.subprocess, 'Popen', side_effect=lambda command, **kw: inline_catalog_worker(mod, command)):
            with self.assertRaises(ValueError):
                mod.fetch_catalog('https://unit.invalid/catalog')
        bad_encoding = UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'fixture')
        with patch.object(mod.subprocess, 'run', side_effect=bad_encoding):
            self.assertFalse(mod.catalog_adapter_supported('/mock/proxy', {}, ROOT))

    def test_worker_ipc_is_bounded_private_and_cleans_up_on_cancellation(self):
        from unittest.mock import patch, MagicMock
        mod = self.module()
        for error in (KeyboardInterrupt(), OSError('fixture worker failure')):
            with tempfile.TemporaryDirectory(dir=ROOT) as td:
                process = MagicMock()
                process.poll.return_value = None
                process.communicate.side_effect = error
                clock = iter((0.0, 0.6))
                def spawned(command, **kw):
                    self.assertEqual(command[1:4], ['-I', str(ROOT / 'claude_openai.py'), '_catalog-worker'])
                    self.assertNotIn('private-query-secret', ' '.join(command))
                    self.assertEqual(Path(kw['cwd']).stat().st_mode & 0o777, 0o700)
                    self.assertEqual(kw['env'], {'HTTPS_PROXY': 'http://proxy.invalid:8080', 'SSL_CERT_FILE': '/test/ca.pem'})
                    self.assertEqual(kw['stdout'], mod.subprocess.DEVNULL)
                    self.assertEqual(kw['stderr'], mod.subprocess.DEVNULL)
                    return process
                with patch.object(mod.subprocess, 'Popen', side_effect=spawned), \
                     patch.object(mod.time, 'monotonic', side_effect=lambda: next(clock)), \
                     patch.object(mod, 'CATALOG_TOTAL_SECONDS', 1), \
                     patch.dict(os.environ, {'OPENAI_API_KEY': 'secret', 'ANTHROPIC_AUTH_TOKEN': 'secret',
                        'HTTPS_PROXY': 'http://proxy.invalid:8080', 'SSL_CERT_FILE': '/test/ca.pem',
                        'PYTHONPATH': '/untrusted', 'HOME': '/private'}, clear=True):
                    with self.assertRaises(KeyboardInterrupt if isinstance(error, KeyboardInterrupt) else ValueError):
                        mod.fetch_catalog('https://unit.invalid/?private-query-secret', td)
                self.assertAlmostEqual(process.communicate.call_args.kwargs['timeout'], 0.4)
                self.assertLessEqual(len(process.communicate.call_args.args[0]), 65536)
                process.kill.assert_called_once()
                process.wait.assert_called_once()
                self.assertEqual(list(Path(td).iterdir()), [])
        with patch.object(mod.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'IPC limit'):
                mod.fetch_catalog('https://unit.invalid/' + 'x' * 65536)
            spawn.assert_not_called()

    def test_real_worker_reads_private_file_from_a_thread_without_network(self):
        from concurrent.futures import ThreadPoolExecutor
        mod = self.module()
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            source = Path(td) / 'source.json'
            source.write_text(json.dumps(catalog_fixture()))
            with ThreadPoolExecutor(max_workers=1) as executor:
                result = executor.submit(mod.fetch_catalog, str(source), td).result(timeout=3)
            self.assertEqual(result, catalog_fixture())
            self.assertEqual(list(Path(td).iterdir()), [source])

    def test_redirects_and_default_fallback_share_deadline(self):
        import io
        from unittest.mock import patch, MagicMock
        mod = self.module()
        clock, calls = [0.0], []
        def open_request(req, **kw):
            calls.append((req.full_url, kw['timeout']))
            clock[0] += 0.6
            if len(calls) == 1:
                raise mod.urllib.error.HTTPError(req.full_url, 302, 'Found',
                    {'Location': 'https://other.invalid/catalog'}, io.BytesIO())
            raise mod.urllib.error.URLError('fixture unavailable')
        opener = MagicMock()
        opener.open.side_effect = open_request
        with patch.object(mod.urllib.request, 'build_opener', return_value=opener), \
             patch.object(mod.subprocess, 'Popen', side_effect=lambda command, **kw: inline_catalog_worker(mod, command)), \
             patch.object(mod.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(mod, 'CATALOG_TOTAL_SECONDS', 1.0):
            with self.assertRaises(ValueError):
                mod.fetch_catalog()
        self.assertEqual(len(calls), 2)
        self.assertLessEqual(calls[1][1], 0.4)
        self.assertNotIn(mod.CATALOG_URLS[1], [c[0] for c in calls])


if __name__ == '__main__':
    unittest.main()
