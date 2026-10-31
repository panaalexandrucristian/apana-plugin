#!/usr/bin/env python3
"""Claude Code via a private CLIProxyAPI sidecar and Codex subscription OAuth."""
import hashlib
import http.client
import json
import math
import os
import re
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
               'CLAUDE_CODE_MAX_CONTEXT_TOKENS': '400000',
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


def claude_auto_wrapper(args):
    """The installed wrapper's source when this call should run under its rule and handoff loop; None when it is absent
    or the call passes through (print mode, help, subcommands). Loaded without starting it."""
    source = Path(shutil.which('claude-auto') or Path.home() / '.claude/claude-auto/claude-auto')
    if not source.is_file():
        return None
    try:
        shared = runpy.run_path(str(source), run_name='claude_auto_wrapper')
        shared['wrapper']
        return None if shared['passthrough'](args) else source
    except Exception as error:
        raise RuntimeError('Cannot load claude-auto wrapper from ' + str(source) + ': ' + str(error)) from error


def proxy_environment(inherited, directory):
    env = dict(inherited, TMPDIR=str(directory))
    for key in list(env):
        name = key.upper()
        if name in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MANAGEMENT_PASSWORD', 'HOME_JWT', 'DEPLOY') or name.startswith(('PGSTORE_', 'OBJECTSTORE_', 'GITSTORE_')):
            env.pop(key, None)
    return env


# Raw ordered tier fingerprints, NOT an API inventory or a parallel model list.
# CLIProxyAPI v8.0.40, d946c4f, internal/registry/models/models.json;
# full embedded file SHA256: 202d50ff901832d8ed915db9a4f852e957ea5c2370b5f8bbfac7db226ba8b7d9.
# Reproduction uses catalog_fingerprints() on that JSON; frozen raw fixtures test it.
CODEX_BASELINE = {
    'codex-free': 'd363cc9e06c3f399e67aacbbe0d945f0384895c36fd0138a4c1c0cb16a1e39eb',
    'codex-team': 'c7fe528c105bcbe07bc20e77209ce280dea7376364f505424882f583375bef78',
    'codex-plus': 'c7fe528c105bcbe07bc20e77209ce280dea7376364f505424882f583375bef78',
    'codex-pro': '37fd1793307b31ab319b11b1785dddef21725e34fdf1efb78f7df2768d30004d',
}
CATALOG_URLS = ('https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json',
                'https://models.router-for.me/models.json')
CATALOG_MAX_BYTES = 4 * 1024 * 1024
CATALOG_TOTAL_SECONDS = 10
CATALOG_OPERATION_SECONDS = 3


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('nonfinite JSON number')
        return number
    return json.loads(data, object_pairs_hook=pairs, parse_constant=finite, parse_float=finite)


def validate_inventory(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('data'), list):
        raise ValueError('missing model inventory')
    for row in payload['data']:
        name = row.get('id') if isinstance(row, dict) else None
        if not isinstance(name, str) or not name or name.strip() != name or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ValueError('invalid model ID')
    return payload['data']


def validate_catalog(data):
    catalog = strict_json(data)
    if not isinstance(catalog, dict) or any(tier not in catalog for tier in CODEX_BASELINE):
        raise ValueError('missing Codex tiers')
    for rows in catalog.values():
        validate_inventory({'data': rows})
        names = [row['id'] for row in rows]
        if len(names) != len(set(names)):
            raise ValueError('duplicate catalog model ID')
    return catalog


def catalog_fingerprints(catalog):
    # Sort object keys only. Array order, unknown fields and absent/false are significant.
    return {tier: hashlib.sha256(json.dumps(catalog[tier], sort_keys=True,
            separators=(',', ':'), ensure_ascii=True).encode()).hexdigest() for tier in CODEX_BASELINE}


def catalog_bytes(reader, limit):
    chunks, size = [], 0
    while True:
        chunk = reader.read(min(65536, limit + 1 - size))
        if not chunk:
            return b''.join(chunks)
        size += len(chunk)
        if size > limit:
            raise ValueError('catalog exceeds byte limit')
        chunks.append(chunk)


def catalog_url(source):
    parsed = urllib.parse.urlsplit(source)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('catalog requires HTTP(S) or an absolute file')
    return parsed


def download_catalog(source='', *, limit=None, seconds=None, operation=None):
    """Worker transport; the parent, not socket timeouts, enforces the hard deadline."""
    limit = CATALOG_MAX_BYTES if limit is None else limit
    seconds = CATALOG_TOTAL_SECONDS if seconds is None else seconds
    operation = CATALOG_OPERATION_SECONDS if operation is None else operation
    if not isinstance(source, str):
        raise ValueError('invalid catalog source')
    # No inherited global opener, cookie jar or authentication handlers. Preserve
    # legitimate network proxies. Redirects are handled explicitly before following.
    redirect = urllib.request.HTTPRedirectHandler()
    redirect.redirect_request = lambda *args, **kwargs: None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(), redirect)
    deadline = time.monotonic() + seconds
    for candidate in ((source,) if source else CATALOG_URLS):
        try:
            if time.monotonic() >= deadline:
                break
            if os.path.isabs(candidate):
                with open(candidate, 'rb') as reader:
                    data = catalog_bytes(reader, limit)
                validate_catalog(data)
                return data
            for _ in range(6):
                parsed = catalog_url(candidate)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('catalog total deadline')
                try:
                    request = urllib.request.Request(candidate, headers={'Accept': 'application/json'})
                    with opener.open(request, timeout=min(operation, remaining)) as response:
                        if response.status != 200:
                            raise ValueError('catalog HTTP status')
                        data = catalog_bytes(response, limit)
                    validate_catalog(data)
                    return data
                except urllib.error.HTTPError as error:
                    with error:
                        if error.code not in (301, 302, 303, 307, 308):
                            raise ValueError('catalog HTTP status') from None
                        target = urllib.parse.urljoin(candidate, error.headers.get('Location', ''))
                    following = catalog_url(target)
                    if parsed.scheme == 'https' and following.scheme != 'https':
                        raise ValueError('catalog HTTPS downgrade')
                    candidate = target
            raise ValueError('catalog redirect limit')
        except (ValueError, OSError, urllib.error.URLError, http.client.HTTPException, RecursionError):
            # Explicit sources never fall back to public defaults; the deadline is
            # shared across redirects/fallbacks and is not reset by progress.
            continue
    raise ValueError('no valid catalog snapshot within limits')


def catalog_worker(output, request):
    data = download_catalog(request['source'], limit=request['limit'],
                            seconds=request['seconds'], operation=request['operation'])
    # Data only, in a new private directory. UTF-8 output retains the read byte cap.
    private_write(output, data.decode('utf-8'))


def fetch_catalog(source='', directory=None):
    """Bound all download operations in a short-lived trusted-module worker.

    Parent timeout also covers a worker stuck in C/network code; no process-global
    signal handlers/timers change. This is not a real-time scheduler/spawn guarantee.
    """
    if not isinstance(source, str):
        raise ValueError('invalid catalog source')
    request = json.dumps({'source': source, 'limit': CATALOG_MAX_BYTES,
                          'seconds': CATALOG_TOTAL_SECONDS, 'operation': CATALOG_OPERATION_SECONDS}).encode()
    if len(request) > 65536:
        raise ValueError('catalog source exceeds IPC limit')
    # Deliberate allowlist: no provider tokens, sidecar key, cookies, HOME or Python
    # startup customizations. Keep standard network proxy/CA settings (including case).
    allowed = {'path', 'systemroot', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
               'ssl_cert_file', 'ssl_cert_dir', 'request_method'}
    env = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    with tempfile.TemporaryDirectory(prefix='catalog-read-', dir=directory) as temporary:
        output = Path(temporary) / 'models.json'
        process = None
        deadline = time.monotonic() + CATALOG_TOTAL_SECONDS
        try:
            process = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()),
                                        '_catalog-worker', str(output)],
                                       stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       cwd=temporary, env=env)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('catalog total deadline')
            process.communicate(request, timeout=remaining)
            if process.returncode:
                raise ValueError('catalog worker could not validate a snapshot')
            with output.open('rb') as reader:
                return validate_catalog(catalog_bytes(reader, CATALOG_MAX_BYTES))
        except (OSError, subprocess.TimeoutExpired, RecursionError) as error:
            raise ValueError('catalog download unconfirmed within limits') from error
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()


def catalog_adapter_supported(proxy, env, run_dir):
    try:
        help_result = subprocess.run([proxy, '--help'], capture_output=True, text=True,
                                     timeout=3, env=env, cwd=run_dir)
        return any(line.startswith('CLIProxyAPI Version: 8.0.40, Commit: ')
                   for line in (help_result.stdout + help_result.stderr).splitlines())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def catalog_batch_observed(path):
    # v8.0.40 Go %v uses space-separated exact provider tokens, not comma lists.
    # Real isolated capture: [codex kimi kimi-ai kimi.ai kimi.com xai], info padded
    # to five columns, caller service_plugins.go:406. No per-auth conclusion follows.
    with path.open() as log:
        text = log.read(1024 * 1024)
    for line in text.splitlines(keepends=True):
        if not line.endswith('\n'):
            continue
        match = re.search(r'(?:^|\] )re-registered models for ([0-9]+) auth\(s\) due to model catalog changes: \[([^\]\r\n]*)\]\s*$', line)
        if match and int(match[1]) > 0 and 'codex' in match[2].split():
            return True
    return False


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
        # Keep client tool declarations unchanged unless the user chose another policy.
        config.setdefault('multimedia', {}).setdefault('disable-image-generation', 'passthrough')
        url = 'http://127.0.0.1:' + str(port)
        # No provider API keys from the shell can become an alternate upstream.
        proxy_env = proxy_environment(os.environ, run_dir)
        wait_catalog = False
        if catalog_adapter_supported(proxy, proxy_env, run_dir):
            try:
                catalog = fetch_catalog(config.get('models', {}).get('catalog', ''), run_dir)
                snapshot_dir = run_dir / 'catalog'
                snapshot_dir.mkdir(mode=0o700)
                snapshot = snapshot_dir / 'models.json'
                private_write(snapshot, json.dumps(catalog, ensure_ascii=True))
                config.setdefault('models', {})['catalog'] = str(snapshot)
                wait_catalog = catalog_fingerprints(catalog) != CODEX_BASELINE
                print('claude-openai: catalog snapshot validated' +
                      ('' if wait_catalog else '; raw Codex input matches v8.0.40 embedded baseline (not per-credential or inference proof)'),
                      file=sys.stderr)
            except (ValueError, OSError, RecursionError):
                # Do not let the sidecar re-fetch a rejected explicit source outside
                # our deadline/redirect/validation rules. Only this launch falls back
                # to the embedded general catalog; other settings stay untouched.
                config.get('models', {}).pop('catalog', None)
                print('claude-openai: warning: catalog snapshot unavailable/invalid; freshness unconfirmed; using embedded general catalog and valid proxy inventory', file=sys.stderr)
        else:
            print('claude-openai: warning: unverified CLIProxyAPI version; catalog freshness unconfirmed; using existing proxy behavior (no upgrade)', file=sys.stderr)
        private_write(run_dir / 'proxy.json', json.dumps(config))
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
                    # Read the inventory AFTER observing the batch, never reuse a response
                    # from before it. A first nonempty inventory can still be embedded.
                    batch = wait_catalog and catalog_batch_observed(run_dir / 'proxy.log')
                    try:
                        req = urllib.request.Request(url + '/v1/models', headers={'Authorization': 'Bearer ' + key})
                        with opener.open(req, timeout=2) as response:
                            models = validate_inventory(strict_json(response.read(CATALOG_MAX_BYTES + 1)))
                        ready = bool(models) or not codex_credentials(state)
                        if ready and (not wait_catalog or batch or time.monotonic() >= deadline):
                            break
                        if time.monotonic() >= deadline:
                            raise RuntimeError('Codex model registration did not finish within 30 seconds')
                    except (urllib.error.URLError, OSError, ValueError, RecursionError, http.client.HTTPException):
                        if time.monotonic() >= deadline:
                            raise RuntimeError('CLIProxyAPI did not become ready with a valid inventory in 30 seconds') from None
                    time.sleep(0.2)
                if process.poll() is not None:
                    raise RuntimeError('CLIProxyAPI exited during startup (check config and installed version)')
                if wait_catalog:
                    evidence = 'Codex refresh batch observed' if batch else 'Codex refresh batch not observed within startup budget'
                    print('claude-openai: warning: ' + evidence +
                          '; per-credential catalog application/freshness unconfirmed; using final proxy inventory', file=sys.stderr)
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
    wrapper = claude_auto_wrapper(args)
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
        command = [claude, '--settings', str(settings_file), '--model', model] + args
        if wrapper:
            # claude-auto merges its hooks into --settings and appends the rule; its follow-up sessions keep this env and --model
            command = [sys.executable, str(wrapper)] + command[1:]
            env['CLAUDE_AUTO_CLAUDE'] = claude
        return subprocess.run(command, env=env, capture_output=capture, text=True)


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
    if command == '_catalog-worker':
        # Private parent/worker IPC, not a user-facing installation operation.
        try:
            data = sys.stdin.buffer.read(65537)
            if len(data) > 65536 or len(args) != 1:
                return 1
            catalog_worker(Path(args[0]), strict_json(data))
            return 0
        except (ValueError, OSError, KeyError, TypeError, RecursionError):
            return 1
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
