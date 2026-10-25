#!/usr/bin/env python3
"""Claude Code via a private CLIProxyAPI sidecar and Codex subscription OAuth."""
import json
import os
from pathlib import Path
import runpy
import secrets
import shlex
import shutil
import subprocess
import sys
import socket
import tempfile
import time
import urllib.request
import urllib.error
from contextlib import contextmanager

BEGIN = '# >>> claude-openai (managed) >>>'
END = '# <<< claude-openai (managed) <<<'
OWNER = 'claude-openai-skill-v1'


def private_write(path, text, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise RuntimeError('Refusing symlink: ' + str(path))
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, 'w') as handle:
        handle.write(text)


def configure(home, python):
    home = Path(home)
    state = home / '.local/share/claude-openai'
    launcher = home / '.local/bin/claude-openai'
    rc = home / '.zshrc'
    old = rc.read_text() if rc.exists() else ''
    if (BEGIN in old) != (END in old) or old.count(BEGIN) > 1 or old.count(END) > 1:
        raise RuntimeError('Malformed managed shell block; leaving files unchanged')
    if BEGIN in old and old.index(END) < old.index(BEGIN):
        raise RuntimeError('Malformed managed shell block order')
    if state.exists() and (not (state / 'owner').exists() or (state / 'owner').read_text() != OWNER):
        raise RuntimeError('State directory is not owned by this installer')
    if launcher.exists() and OWNER not in launcher.read_text():
        raise RuntimeError('Existing launcher is not owned by this installer')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    auth = state / 'auth'
    auth.mkdir(exist_ok=True, mode=0o700)
    auth.chmod(0o700)
    private_write(state / 'owner', OWNER)
    config_path = state / 'proxy.json'
    if not config_path.exists():
        config = {
            'config-version': 8,
            'server': {'host': '127.0.0.1', 'port': 18317, 'discovery': {'enabled': False}},
            'management': {'allow-remote': False, 'secret-key': '', 'disable-control-panel': True,
                           'disable-auto-update-panel': True},
            'access': {'api-keys': [secrets.token_urlsafe(32)]},
            'oauth': {'auth-dir': str(auth)},
            'routing': {'retry': {'request-retry': 1, 'max-retry-credentials': 1, 'max-retry-interval': 3}},
            'observability': {'logs': {'debug': False, 'logging-to-file': False, 'request-log': False},
                              'usage': {'usage-statistics-enabled': False}, 'pprof': {'enable': False}},
            'plugins': {'enabled': False},
        }
        private_write(config_path, json.dumps(config, indent=2) + '\n')
    config = json.loads(config_path.read_text())
    if not config['server'].get('commercial-mode'):
        config['server']['commercial-mode'] = True
        private_write(config_path, json.dumps(config, indent=2) + '\n')
    source = Path(__file__).resolve()
    target = state / 'claude_openai.py'
    if source != target.resolve():
        private_write(target, source.read_text(), 0o700)
    launcher.parent.mkdir(parents=True, exist_ok=True)
    private_write(launcher, '#!/bin/sh\n# ' + OWNER + '\nexec ' + shlex.quote(python) + ' ' +
                  shlex.quote(str(target)) + ' run "$@"\n', 0o700)
    block = BEGIN + '\nalias claude-openai=' + shlex.quote(str(launcher)) + '\n' + END
    if BEGIN in old:
        first = old.index(BEGIN)
        last = old.index(END) + len(END)
        new = old[:first] + block + old[last:]
    else:
        new = old + ('\n' if old and not old.endswith('\n') else '') + '\n' + block + '\n'
    if new != old:
        if not (state / 'zshrc.before').exists():
            private_write(state / 'zshrc.before', old)
        private_write(rc, new, (rc.stat().st_mode & 0o777) if rc.exists() else 0o600)
    return state


def codex_credentials(state):
    files = []
    for path in (state / 'auth').glob('*.json'):
        if path.is_symlink():
            raise RuntimeError('Refusing symlinked OAuth credential')
        try:
            record = json.loads(path.read_text())
        except (ValueError, OSError):
            continue
        if record.get('type') == 'codex' and record.get('access_token'):
            path.chmod(0o600)
            files.append(path)
    return files


def launch_spec(inherited, url, key, model, models=()):
    env = dict(inherited)
    for name in ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
                 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'):
        env.pop(name, None)
    routing = {'ANTHROPIC_BASE_URL': url, 'ANTHROPIC_AUTH_TOKEN': key,
               'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
               'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY': '1'}
    for name in ('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
                 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'):
        routing[name] = model
    env.update(routing)
    picker_models = sorted(set(models) | {model}, key=lambda name: (name != model, name))
    return env, {'model': model, 'env': routing,
                 'modelPicker': {'replaceBuiltInOptions': True,
                                 'options': [{'model': name, 'label': name,
                                              'description': 'Codex OAuth'}
                                             for name in picker_models]}}


def claude_auto_instructions(args):
    """Reuse the installed wrapper's rule policy, without starting its handoff loop."""
    source = Path(shutil.which('claude-auto') or Path.home() / '.claude/claude-auto/claude-auto')
    if not source.is_file():
        return []
    try:
        shared = runpy.run_path(str(source), run_name='claude_auto_instructions')
        if shared['passthrough'](args):
            return []
        return shared['rule_args'](args)
    except Exception as error:
        raise RuntimeError('Cannot load claude-auto instructions from ' + str(source) + ': ' + str(error)) from error


def proxy_environment(inherited, directory):
    env = dict(inherited, TMPDIR=str(directory))
    for key in list(env):
        name = key.upper()
        if name in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MANAGEMENT_PASSWORD', 'HOME_JWT', 'DEPLOY') or name.startswith(('PGSTORE_', 'OBJECTSTORE_', 'GITSTORE_')):
            env.pop(key, None)
    return env


@contextmanager
def proxy_session(state):
    proxy = shutil.which('cliproxyapi')
    if not proxy:
        raise RuntimeError('Install CLIProxyAPI first: brew install cliproxyapi')
    with tempfile.TemporaryDirectory(prefix='session-', dir=state) as directory:
        run_dir = Path(directory)
        config = json.loads((state / 'proxy.json').read_text())
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        key = secrets.token_urlsafe(32)
        config['server']['port'] = port
        config['server']['host'] = '127.0.0.1'
        config['access']['api-keys'] = [key]
        private_write(run_dir / 'proxy.json', json.dumps(config))
        url = 'http://127.0.0.1:' + str(port)
        # No provider API keys from the shell can become an alternate upstream.
        proxy_env = proxy_environment(os.environ, run_dir)
        with (run_dir / 'proxy.log').open('w') as log:
            os.chmod(run_dir / 'proxy.log', 0o600)
            process = subprocess.Popen([proxy, '-config', str(run_dir / 'proxy.json'), '-local-model'],
                                       cwd=run_dir, env=proxy_env, stdout=log, stderr=log,
                                       start_new_session=True)
            try:
                deadline = time.monotonic() + 30
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                while True:
                    if process.poll() is not None:
                        raise RuntimeError('CLIProxyAPI exited during startup (check config and installed version)')
                    try:
                        req = urllib.request.Request(url + '/v1/models', headers={'Authorization': 'Bearer ' + key})
                        with opener.open(req, timeout=2) as response:
                            models = json.load(response).get('data', [])
                        if models or not codex_credentials(state):
                            break
                        if time.monotonic() >= deadline:
                            raise RuntimeError('Codex model registration did not finish within 30 seconds')
                        time.sleep(0.2)
                    except (urllib.error.URLError, OSError):
                        if time.monotonic() >= deadline:
                            raise RuntimeError('CLIProxyAPI did not become ready in 30 seconds')
                        time.sleep(0.2)
                yield url, key, models, run_dir, process
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


def run_claude(state, args, capture=False):
    claude = shutil.which('claude')
    if not claude:
        raise RuntimeError('Claude Code is missing; install the official CLI first')
    instructions = claude_auto_instructions(args)
    login(state)
    with proxy_session(state) as (url, key, models, run_dir, process):
        available = [m['id'] for m in models if m.get('id', '').startswith('gpt-')]
        requested = os.environ.get('CLAUDE_OPENAI_MODEL')
        for i, arg in enumerate(args):
            if arg == '--model' and i + 1 < len(args):
                requested = args[i + 1]
            elif arg.startswith('--model='):
                requested = arg.split('=', 1)[1]
        if requested and requested not in available:
            raise RuntimeError('Requested model not available on this Codex route: ' + requested)
        if not available:
            raise RuntimeError('No GPT models available. Run the login command and check subscription access')
        model = requested or ('gpt-6-astra' if 'gpt-6-astra' in available else available[0])
        env, settings = launch_spec(os.environ, url, key, model, [m['id'] for m in models])
        settings_file = run_dir / 'claude-settings.json'
        private_write(settings_file, json.dumps(settings))
        print('claude-openai: Codex OAuth -> ' + model + ' (private localhost proxy)', file=sys.stderr)
        return subprocess.run([claude, '--settings', str(settings_file), '--model', model] + instructions + args,
                              env=env, capture_output=capture, text=True)


def uninstall(home, dry_run=False):
    home = Path(home)
    launcher = home / '.local/bin/claude-openai'
    rc = home / '.zshrc'
    old = rc.read_text() if rc.exists() else ''
    if launcher.exists() and OWNER not in launcher.read_text():
        raise RuntimeError('Launcher is not owned by this skill; leaving it unchanged')
    if (BEGIN in old) != (END in old) or old.count(BEGIN) > 1 or old.count(END) > 1:
        raise RuntimeError('Malformed shell block; no files removed')
    new = old
    if BEGIN in old:
        start, stop = old.index(BEGIN), old.index(END) + len(END)
        if stop < start:
            raise RuntimeError('Malformed shell block order')
        new = old[:start] + old[stop:]
    if dry_run:
        print('Would remove owned launcher and shell alias; preserve OAuth credentials, state and CLIProxyAPI')
        return
    if new != old:
        private_write(rc, new, rc.stat().st_mode & 0o777)
    if launcher.exists():
        launcher.unlink()


def verify(state):
    result = run_claude(state, ['-p', 'Reply with exactly CLAUDE_OPENAI_OK and nothing else. Do not use any tools.',
                               '--tools', '', '--max-turns', '2', '--output-format', 'json'], capture=True)
    try:
        data = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError('Claude did not return JSON (exit ' + str(result.returncode) + ')')
    if result.returncode or data.get('is_error') or data.get('subtype') != 'success':
        message = str(data.get('result', data.get('subtype', 'unknown error')))
        raise RuntimeError('Claude request failed: ' + message[:1000])
    models = list(data.get('modelUsage', {}))
    if data.get('result', '').strip() != 'CLAUDE_OPENAI_OK' or not models or not all(m.startswith('gpt-') for m in models):
        raise RuntimeError('Verification failed: expected marker and GPT model usage were not both present')
    report = {'verified': True, 'session_id': data.get('session_id'), 'models': models,
              'result': data['result'], 'duration_ms': data.get('duration_ms'), 'usage': data.get('usage')}
    private_write(state / 'verification.json', json.dumps(report, indent=2) + '\n')
    return report


def login(state, force=False):
    if codex_credentials(state) and not force:
        return
    proxy = shutil.which('cliproxyapi')
    if not proxy:
        raise RuntimeError('CLIProxyAPI missing; install with brew install cliproxyapi')
    result = subprocess.run([proxy, '-config', str(state / 'proxy.json'), '-local-model', '-codex-login'],
                            cwd=state, env=proxy_environment(os.environ, state))
    if result.returncode or not codex_credentials(state):
        raise RuntimeError('OpenAI login did not produce a usable Codex credential; complete browser login and retry')


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    command = args.pop(0) if args else 'help'
    home = Path.home()
    state = home / '.local/share/claude-openai'
    if command == 'install':
        for binary in ('claude', 'cliproxyapi'):
            if not shutil.which(binary):
                raise RuntimeError('Missing ' + binary + '; install the documented prerequisite, then rerun install')
        state = configure(home, sys.executable)
        login(state)
        print(json.dumps(verify(state), indent=2))
        print('Installed and verified. Open a new zsh terminal and run: claude-openai')
        return 0
    if command == 'uninstall':
        uninstall(home, dry_run='--dry-run' in args)
        return 0
    if command in ('help', '-h', '--help'):
        print('Usage: python3 claude_openai.py install|login|verify|models|run [Claude args]|uninstall [--dry-run]')
        print('install: private configuration + zsh alias + OpenAI browser OAuth + real Claude smoke test')
        print('login: repeat OpenAI browser OAuth; run: starts and stops a private per-session proxy')
        return 0
    if not (state / 'owner').exists() or (state / 'owner').read_text() != OWNER:
        raise RuntimeError('Run the install command first')
    if command == 'login':
        login(state, force=True)
        print('OpenAI Codex credential saved locally; no API key configured')
        return 0
    if command == 'verify':
        print(json.dumps(verify(state), indent=2))
        return 0
    if command == 'models':
        login(state)
        with proxy_session(state) as (_, _, models, _, _):
            print('\n'.join(m['id'] for m in models if m.get('id', '').startswith('gpt-')))
        return 0
    if command == 'run':
        return run_claude(state, args).returncode
    raise RuntimeError('Unknown command: ' + command)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (RuntimeError, OSError) as error:
        print('claude-openai: ' + str(error), file=sys.stderr)
        sys.exit(1)
