#!/usr/bin/env python3
"""Standalone Copilot subscription launcher. No provider keys or native code bundled."""
import argparse
from collections import Counter
from contextlib import contextmanager
import copy
import datetime
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re
import runpy
import secrets
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

BEGIN = '# >>> claude-copilot (managed) >>>'
END = '# <<< claude-copilot (managed) <<<'
OWNER = 'claude-copilot-skill-v1'
DEFAULT_MODEL = 'copilot/gemini-4-argon'
HOST_VERSION = '8.0.40'
MIN_CLIENT = (2, 1, 316)  # Tested hook, gateway-header and context contracts.
NATIVE_VERSION = '0.1.1'
SOURCE_COMMIT = '596e599671ae66fafa4d5f132de6073edc6da164'
ARCHIVE_URL = 'https://github.com/syepes/CLIProxyAPI-plugin-github-copilot/releases/download/v0.1.1/github-copilot_0.1.1_darwin_arm64.zip'
ARCHIVE_SHA256 = '976c5e3398bf8ed99d19f93ddb4094d3fbb17a5fbec39b730ee1f5e74fde3b4b'
LIBRARY_SHA256 = 'f02b3dfa604c941832b00176c9c6621a24b662d3e24997d5343ce787178f7c27'
MAX_BODY = 8 * 1024 * 1024


def fail(message):
    raise RuntimeError(message)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('Duplicate JSON key')
        result[key] = value
    return result


def json_object(raw):
    try:
        value = json.loads(raw, object_pairs_hook=no_duplicates)
    except (ValueError, TypeError):
        fail('Invalid JSON object')
    if not isinstance(value, dict):
        fail('Expected JSON object')
    return value


def safe_path(path):
    path = Path(path).absolute()
    # Reject links, including a missing leaf below a symlinked parent.
    for item in (path, *path.parents):
        if item.is_symlink():
            fail('Refusing symlink: ' + str(item))
    if path.exists() and not (path.is_file() or path.is_dir()):
        fail('Refusing special file: ' + str(path))
    return path


def private_write(path, text, mode=0o600):
    path = safe_path(path)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as handle:
        os.fchmod(handle.fileno(), mode)
        handle.write(text)


def layout(home):
    home = Path(home)
    return home / '.local/share/claude-copilot', home / '.local/bin/claude-copilot', home / '.zshrc'


def shell_block(launcher):
    # Quote once for alias expansion, then again for the alias assignment.
    return BEGIN + '\nalias claude-copilot=' + shlex.quote(shlex.quote(str(launcher))) + '\n' + END


def preflight(home):
    state, launcher, rc = layout(home)
    for path in (state, launcher, rc):
        safe_path(path)
    if state.exists():
        if not state.is_dir():
            fail('State is not a directory')
        for path in state.rglob('*'):
            safe_path(path)
        if not (state / 'owner').is_file() or (state / 'owner').read_text() != OWNER:
            fail('State is not owned by this installer')
    if launcher.exists():
        text = launcher.read_text()
        prefix = '#!/bin/sh\n# ' + OWNER + '\n'
        try:
            command = shlex.split(text[len(prefix):])
        except ValueError:
            command = []
        if (not text.startswith(prefix) or len(command) != 6 or command[0] != 'exec'
                or not Path(command[1]).is_absolute()
                or command[2:] != ['-I', str(state / 'claude_copilot.py'), 'run', '$@']):
            fail('Launcher is not owned by this installer')
    old = rc.read_text() if rc.exists() else ''
    if old.count(BEGIN) != old.count(END) or old.count(BEGIN) > 1:
        fail('Malformed managed shell block')
    if BEGIN in old:
        start, end = old.index(BEGIN), old.index(END) + len(END)
        # Recognize only the exact previous installer spelling as well, so its
        # owned aliases can be repaired or removed without accepting foreign code.
        previous = BEGIN + '\nalias claude-copilot=' + shlex.quote(str(launcher)) + '\n' + END
        if old[start:end] not in (shell_block(launcher), previous):
            fail('Foreign or malformed managed shell block')
    return state, launcher, rc, old


def configure(home, python):
    state, launcher, rc, old = preflight(home)
    # Validate retained config before making any changes.
    if (state / 'config.json').exists():
        read_config(state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    (state / 'auth').mkdir(exist_ok=True, mode=0o700)
    (state / 'auth').chmod(0o700)
    private_write(state / 'owner', OWNER)
    target = state / 'claude_copilot.py'
    if Path(__file__).resolve() != target.resolve():
        private_write(target, Path(__file__).read_text(), 0o700)
    launcher.parent.mkdir(parents=True, exist_ok=True)
    private_write(launcher, '#!/bin/sh\n# ' + OWNER + '\nexec ' + shlex.quote(python) + ' -I ' +
                  shlex.quote(str(target)) + ' run "$@"\n', 0o700)
    block = shell_block(launcher)
    if BEGIN in old:
        new = old[:old.index(BEGIN)] + block + old[old.index(END) + len(END):]
    else:
        new = old + ('\n' if old and not old.endswith('\n') else '') + '\n' + block + '\n'
    if new != old:
        if not (state / 'zshrc.before').exists():
            private_write(state / 'zshrc.before', old)
        private_write(rc, new, stat.S_IMODE(rc.stat().st_mode) if rc.exists() else 0o600)
    return state


def uninstall(home, dry_run=False):
    state, launcher, rc, old = preflight(home)
    if dry_run:
        print('Would remove only owned launcher and managed alias; preserve state, credentials, backup, native plugin and dependencies. No sessions stopped.')
        return
    if BEGIN in old:
        new = old[:old.index(BEGIN)] + old[old.index(END) + len(END):]
        private_write(rc, new, stat.S_IMODE(rc.stat().st_mode))
    if launcher.exists():
        launcher.unlink()


def read_config(state):
    value = json_object(safe_path(state / 'config.json').read_text())
    if set(value) != {'schema', 'account'} or value['schema'] != 1 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}', str(value['account'])):
        fail('Incompatible account configuration; leaving it unchanged')
    return value


def checked_archive(path):
    """Validate every member before extraction; caller supplies a reviewed local ZIP."""
    raw = safe_path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != ARCHIVE_SHA256:
        fail('Native archive SHA-256 differs from reviewed pin')
    import io
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        names = set()
        for item in members:
            name = PurePosixPath(item.filename)
            kind = stat.S_IFMT(item.external_attr >> 16)
            if (name.is_absolute() or '..' in name.parts or '\\' in item.filename or item.filename in names
                    or kind not in (0, stat.S_IFREG, stat.S_IFDIR) or item.file_size > 100 * 1024 * 1024):
                fail('Unsafe native archive member')
            names.add(item.filename)
        if sum(x.file_size for x in members) > 150 * 1024 * 1024:
            fail('Native archive exceeds extraction bound')
        libraries = [x for x in members if PurePosixPath(x.filename).name == 'github-copilot.dylib']
        if len(libraries) != 1:
            fail('Native archive must contain exactly one library')
        library = archive.read(libraries[0])
        if hashlib.sha256(library).hexdigest() != LIBRARY_SHA256:
            fail('Native library SHA-256 differs from reviewed pin')
        # Preserve upstream notices without executing any archive content.
        notices = {x.filename: archive.read(x) for x in members if not x.is_dir() and
                   PurePosixPath(x.filename).name.lower().startswith(('license', 'notice', 'readme'))}
        return library, notices


def install_native(state, archive):
    library, notices = checked_archive(archive)
    destination = state / 'native'
    safe_path(destination)
    destination.mkdir(exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='extract-', dir=state) as directory:
        target = Path(directory) / 'github-copilot.dylib'
        target.write_bytes(library); target.chmod(0o600)
        os.replace(target, destination / target.name)
    for index, (name, data) in enumerate(notices.items()):
        target = safe_path(destination / ('notice-' + str(index) + '-' + PurePosixPath(name).name))
        target.write_bytes(data); target.chmod(0o600)
    private_write(destination / 'provenance.json', json.dumps({'url': ARCHIVE_URL, 'commit': SOURCE_COMMIT,
        'archive_sha256': ARCHIVE_SHA256, 'library_sha256': LIBRARY_SHA256,
        'assurance': 'Reviewed hash, not independent attestation or publisher signature; local use only.'}))


def prerequisites():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        fail('Only the reviewed macOS arm64 native artifact is supported; no automatic replacement')
    if sys.version_info < (3, 9) or not shutil.which('zsh'):
        fail('Python 3.9+ and zsh are required')
    for binary in ('claude', 'cliproxyapi'):
        if not shutil.which(binary):
            fail('Missing ' + binary + '; install the prerequisite separately')
    client = subprocess.run([shutil.which('claude'), '--version'], capture_output=True, text=True, timeout=15)
    version = re.search(r'\b(\d+)\.(\d+)\.(\d+)\b', client.stdout)
    if client.returncode or not version or tuple(map(int, version.groups())) < MIN_CLIENT:
        fail('Claude Code 2.1.316+ required for the verified guard/header/context contracts')
    host = subprocess.run([shutil.which('cliproxyapi'), '--help'], capture_output=True, text=True, timeout=15)
    if not re.search(r'\b' + re.escape(HOST_VERSION) + r'\b', host.stdout + host.stderr):
        fail('CLIProxyAPI must be the reviewed build ' + HOST_VERSION + '; no automatic upgrade')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        fail('Authenticated redirect refused')


def fetch(url, headers=None, timeout=30, limit=MAX_BODY):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(urllib.request.Request(url, headers=headers or {}), timeout=timeout) as response:
            raw = response.read(limit + 1)
            if len(raw) > limit:
                fail('HTTP response exceeds configured bound')
            if response.headers.get('Link') or response.headers.get('X-Next-Page'):
                fail('Upstream pagination contract changed; refusing partial catalog')
            return json_object(raw)
    except urllib.error.HTTPError as error:
        fail('HTTP ' + str(error.code) + ' at ' + urllib.parse.urlsplit(url).path + '; no stale fallback')
    except urllib.error.URLError:
        fail('HTTP transport failed; no stale fallback')


def credential(directory, account):
    files = list(safe_path(directory).iterdir())
    if len(files) != 1 or not files[0].is_file():
        fail('Expected exactly one private Copilot credential; run login explicitly')
    path = safe_path(files[0])
    if path.stat().st_mode & 0o077:
        fail('Credential permissions must be 0600')
    value = json_object(path.read_text())
    if (value.get('type') != 'copilot' or value.get('disabled') or value.get('github_base_url') != 'https://github.com'
            or str(value.get('github_login', '')).casefold() != account.casefold()
            or not isinstance(value.get('github_access_token'), str) or not value['github_access_token']):
        fail('Credential does not identify the intended Copilot account')
    return path, value


def github_headers(auth):
    return {'Accept': 'application/vnd.github+json', 'Authorization': 'token ' + auth['github_access_token'],
            'User-Agent': 'CLIProxyAPI-Copilot-Plugin/0.1.1', 'X-GitHub-Api-Version': '2022-11-28'}


def confirm_identity(auth, account):
    identity = fetch('https://api.github.com/user', github_headers(auth), limit=1024 * 1024)
    if str(identity.get('login', '')).casefold() != account.casefold() or type(identity.get('id')) is not int or identity['id'] <= 0:
        fail('Current GitHub token does not identify the intended account')


def fresh_catalog(auth_dir, account):
    _, auth = credential(auth_dir, account)
    confirm_identity(auth, account)
    token = fetch('https://api.github.com/copilot_internal/v2/token', github_headers(auth), limit=1024 * 1024)
    if not isinstance(token.get('token'), str) or not token['token'] or type(token.get('expires_at')) not in (int, float) or token['expires_at'] <= time.time():
        fail('Copilot token is absent or expired')
    base = token.get('endpoints', {}).get('api', '')
    origin = urllib.parse.urlsplit(base)
    if (origin.scheme != 'https' or origin.username or origin.password or origin.port is not None or origin.query or origin.fragment
            or origin.path not in ('', '/') or not origin.hostname
            or not (origin.hostname == 'api.githubcopilot.com' or origin.hostname.endswith('.githubcopilot.com'))):
        fail('Unexpected Copilot API origin; token not sent')
    request_id = secrets.token_hex(16)
    headers = {'Authorization': 'Bearer ' + token['token'], 'Accept': 'application/json',
               'Copilot-Integration-Id': 'vscode-chat', 'Editor-Plugin-Version': 'copilot-chat/0.67.0',
               'Editor-Version': 'vscode/1.139.1', 'OpenAI-Intent': 'model-access',
               'User-Agent': 'GitHubCopilotChat/0.67.0', 'X-Agent-Task-Id': request_id,
               'X-GitHub-Api-Version': '2026-08-01', 'X-Interaction-Type': 'model-access', 'X-Request-Id': request_id}
    # This is a new authenticated API call on every launch, never a registry/cache read.
    return fetch(base.rstrip('/') + '/models', headers)


def normalize_catalog(raw):
    if not isinstance(raw, dict) or set(raw) != {'data', 'object'} or raw['object'] != 'list' or not isinstance(raw['data'], list) or not raw['data']:
        fail('Empty, invalid or explicitly incomplete catalog; new pagination/schema requires review')
    entries = raw['data']
    if any(not isinstance(x, dict) or not isinstance(x.get('id'), str) for x in entries):
        fail('Invalid upstream model entry')
    counts = Counter(x['id'].strip().lower() for x in entries)
    models = {}
    context, output = 200000, 4096  # Configured upper bounds, further reduced by every eligible model.
    for item in entries:
        name = item['id'].strip()
        caps = item.get('capabilities') or {}
        policy = item.get('policy')
        if not isinstance(caps, dict) or (policy is not None and not isinstance(policy, dict)):
            fail('Malformed model capabilities or policy: ' + name)
        if not name or counts[name.lower()] != 1 or caps.get('type') != 'chat' or (policy is not None and policy.get('state') != 'enabled'):
            continue  # Exactly the pinned native plugin's normalization; no family filter.
        supports, limits = caps.get('supports', {}), caps.get('limits', {})
        endpoints = item.get('supported_endpoints')
        if (not isinstance(supports, dict) or not isinstance(limits, dict)
                or (endpoints is not None and (not isinstance(endpoints, list) or any(not isinstance(x, str) for x in endpoints)))):
            fail('Malformed capability metadata: ' + name)
        if endpoints and not set(endpoints).intersection(('/v1/messages', '/chat/completions', '/responses')):
            fail('No supported execution protocol for ' + name)
        if supports.get('tool_calls') is not True or supports.get('streaming') is not True:
            fail('Required tools/streaming capability unavailable: ' + name)
        fields = ('max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens')
        if any(type(limits.get(field)) is not int or limits[field] <= 0 for field in fields):
            fail('Context/output limits unavailable: ' + name)
        output = min(output, limits['max_output_tokens'])
        models['copilot/' + name] = copy.deepcopy(item)
    if not models:
        fail('No eligible Copilot chat models')
    for item in models.values():
        limits = item['capabilities']['limits']
        context = min(context, limits['max_prompt_tokens'], limits['max_context_window_tokens'] - output)
    if context <= output:
        fail('Catalog cannot provide a safe shared context/output envelope')
    return models, {'context': context, 'output': output, 'compact': context // 2}


def reconcile(models, registry):
    try:
        ids = [x['id'] for x in registry['data']]
    except (KeyError, TypeError):
        fail('Malformed native registry')
    if len(ids) != len(set(ids)) or set(ids) != set(models):
        fail('Fresh Copilot API catalog and cold native registry differ; client not launched')


def proxy_environment(inherited, directory):
    # Allowlist: no shell credentials, proxy interception, extra providers or stores.
    return {'PATH': inherited.get('PATH', '/usr/bin:/bin'), 'HOME': str(directory / 'home'),
            'TMPDIR': str(directory / 'tmp'), 'LANG': 'en_US.UTF-8'}


def supervisor_stop_timeout(inherited):
    # The wrapper can be in its handoff grace wait when termination arrives.
    # Conservatively cover grace, both kill waits, polling and descendant reaping;
    # the margin also covers close_cooperation's bounded finalization.
    waits = []
    for name, default in (('CLAUDE_AUTO_KILL_WAIT', 5.0), ('CLAUDE_AUTO_REAP_WAIT', 1.0),
                          ('CLAUDE_AUTO_POLL', 0.2), ('CLAUDE_AUTO_GRACE', 1.0)):
        try:
            value = float(inherited.get(name, default))
        except ValueError:
            value = default  # Same malformed-number default as the supervisor.
        if not math.isfinite(value) or value < 0:
            fail(name + ' must be a finite nonnegative wait')
        waits.append(value)
    timeout = 2 * waits[0] + waits[1] + waits[2] + waits[3] + 15
    if not math.isfinite(timeout): fail('Supervisor shutdown budget exceeds a finite timeout')
    return timeout


def stop_process(process, group=True, timeout=15):
    if process.poll() is None:
        if group: os.killpg(process.pid, signal.SIGTERM)
        else: process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if group: os.killpg(process.pid, signal.SIGKILL)
            else: process.kill()
            process.wait(timeout=5)


@contextmanager
def native_session(state, auth_dir, management=False):
    proxy = shutil.which('cliproxyapi')
    if not proxy:
        fail('CLIProxyAPI missing; install the reviewed prerequisite separately')
    library = safe_path(state / 'native/github-copilot.dylib').read_bytes()
    if hashlib.sha256(library).hexdigest() != LIBRARY_SHA256:
        fail('Native library changed; refusing to load it')
    with tempfile.TemporaryDirectory(prefix='native-', dir=state) as directory:
        run = Path(directory)
        for relative in ('home', 'tmp', 'plugins/darwin/arm64'):
            (run / relative).mkdir(parents=True, mode=0o700)
        target = run / 'plugins/darwin/arm64/github-copilot.dylib'
        target.write_bytes(library); target.chmod(0o600)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        key, management_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32) if management else ''
        config = {'config-version': 8,
            'server': {'host': '127.0.0.1', 'port': port, 'commercial-mode': True, 'discovery': {'enabled': False}},
            'management': {'allow-remote': False, 'secret-key': management_key, 'disable-control-panel': True, 'disable-auto-update-panel': True},
            'access': {'api-keys': [key]}, 'oauth': {'auth-dir': str(auth_dir)},
            'observability': {'logs': {'debug': False, 'logging-to-file': False, 'request-log': False},
                              'usage': {'usage-statistics-enabled': False}, 'pprof': {'enable': False}},
            'upstream': {'claude': {'disable-cloaking-model-list': True}},
            'plugins': {'enabled': True, 'dir': str(run / 'plugins'), 'configs': {'github-copilot': {
                'enabled': True, 'model_prefix': 'copilot', 'models': [], 'models_excluded': [],
                'model_picker_required': False, 'allow_raw_model_names': False, 'oauth_timeout_seconds': 900}}}}
        private_write(run / 'proxy.json', json.dumps(config))
        private_write(run / 'proxy.log', '')
        with (run / 'proxy.log').open('a') as log:
            process = subprocess.Popen([proxy, '-config', str(run / 'proxy.json'), '-local-model'],
                cwd=run, env=proxy_environment(os.environ, run), stdout=log, stderr=log, start_new_session=True)
        base = 'http://127.0.0.1:' + str(port)
        try:
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    fail('Native host exited during startup')
                try:
                    registry = fetch(base + '/v1/models', {'Authorization': 'Bearer ' + key}, timeout=2)
                    if registry.get('data') or management:
                        break
                except (RuntimeError, OSError):
                    pass
                if time.monotonic() >= deadline:
                    fail('Cold native registry readiness timed out')
                time.sleep(0.1)
            yield base, key, management_key, registry, run, process
        finally:
            stop_process(process)


@contextmanager
def proxy_session(state):
    account = read_config(state)['account']
    raw = fresh_catalog(state / 'auth', account)
    models, limits = normalize_catalog(raw)
    # Native refresh may rewrite tokens: isolate each run from active credentials and concurrent sessions.
    with tempfile.TemporaryDirectory(prefix='session-', dir=state) as directory:
        run = Path(directory); auth_dir = run / 'auth'; auth_dir.mkdir(mode=0o700)
        source, _ = credential(state / 'auth', account)
        private_write(auth_dir / source.name, source.read_text())
        with native_session(state, auth_dir) as (url, key, _, registry, _, process):
            reconcile(models, registry)
            yield url, key, models, limits, run, process


def poll_login(base, key, process, notify=print, clock=time.monotonic, sleep=time.sleep):
    headers = {'Authorization': 'Bearer ' + key}
    data = fetch(base + '/v0/management/copilot-auth-url', headers, timeout=60)
    attempt = data.get('state')
    if not isinstance(attempt, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,256}', attempt):
        fail('Device flow returned no valid attempt state')
    url = urllib.parse.urlsplit(data.get('url', ''))
    if url.scheme != 'https' or url.netloc != 'github.com' or url.path != '/login/device' or url.fragment:
        fail('Unexpected device authorization URL')
    metadata = data.get('metadata', {})
    codes = urllib.parse.parse_qs(url.query).get('user_code', [])
    code = metadata.get('user_code') or data.get('user_code') or (codes[0] if len(codes) == 1 else None)
    if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9-]{4,32}', code):
        fail('Invalid device user code')
    interval = metadata.get('interval', 5)
    if type(interval) not in (int, float) or not 5 <= interval <= 900:
        fail('Invalid device polling interval')
    duration = 900
    if data.get('expires_at'):
        try:
            expires = datetime.datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00'))
            duration = min(duration, (expires - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
        except (ValueError, TypeError):
            fail('Invalid device expiration')
    if duration <= 0:
        fail('Device authorization expired')
    notify('Open https://github.com/login/device and enter ' + code + '. Only this attempt will be followed.')
    deadline = clock() + duration
    while clock() < deadline:
        if process.poll() is not None:
            fail('Login host exited')
        sleep(min(interval, max(0, deadline - clock())))
        if clock() >= deadline:
            break
        result = fetch(base + '/v0/management/get-auth-status?' + urllib.parse.urlencode({'state': attempt}), headers, timeout=30)
        if result.get('state', attempt) != attempt:
            fail('Foreign authorization state')
        status = result.get('status')
        if status == 'ok':
            return attempt
        if status == 'wait':
            continue  # Pinned plugin handles GitHub pending/slow_down within PollLogin.
        reason = result.get('error')
        if reason == 'slow_down':
            interval += 5
            continue
        if reason in ('access_denied', 'expired_token', 'authorization_pending'):
            if reason == 'authorization_pending':
                continue
            fail('Device authorization ' + reason)
        fail('Device authorization failed; active credentials unchanged')
    fail('Device authorization timed out; active credentials unchanged')


def login(state):
    account = read_config(state)['account']
    if any((state / 'auth').iterdir()):
        credential(state / 'auth', account)
        fail('Active credentials already exist and are preserved. Removal/replacement requires a separate explicit decision.')
    with tempfile.TemporaryDirectory(prefix='login-', dir=state) as directory:
        auth_dir = Path(directory) / 'auth'; auth_dir.mkdir(mode=0o700)
        # On every exit, the host is stopped and waited BEFORE staging can be removed or promoted.
        with native_session(state, auth_dir, management=True) as (base, _, key, _, _, process):
            poll_login(base, key, process)
        source, auth = credential(auth_dir, account)
        confirm_identity(auth, account)
        if input('Confirm promotion for GitHub account ' + account + ' by typing the account name: ').strip() != account:
            fail('Credential promotion cancelled')
        target = state / 'auth' / source.name
        safe_path(target)
        # Exclusive creation also refuses a concurrent installation/login.
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(source.read_text())


def parse_args(args, inherited):
    remaining, requested, settings_arg = [], None, None
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == '--':
            remaining.extend(args[index:]); break
        flag, sep, value = arg.partition('=')
        if flag == '--fallback-model':
            fail('Fallback model arguments are not allowed on the guarded Copilot route')
        if flag in ('--model', '--settings'):
            if not sep:
                index += 1
                if index >= len(args) or args[index].startswith('--'):
                    fail('Missing value for ' + flag)
                value = args[index]
            if not value:
                fail('Empty value for ' + flag)
            if flag == '--model': requested = value
            else: settings_arg = value
        else:
            remaining.append(arg)
        index += 1
    settings = {}
    if settings_arg is not None:
        raw = settings_arg if settings_arg.lstrip().startswith(('{', '[')) else Path(settings_arg).read_text()
        settings = json_object(raw)
    model = requested if requested is not None else inherited.get('CLAUDE_COPILOT_MODEL', DEFAULT_MODEL)
    if not model:
        fail('Empty requested Copilot model')
    return remaining, model, settings


def clean_headers(value):
    result = []
    for line in value.splitlines():
        name, sep, content = line.partition(':')
        if not sep or not re.fullmatch(r'[A-Za-z0-9-]+', name.strip()):
            fail('Malformed custom header')
        name = name.strip()
        if name.lower() in ('authorization', 'x-api-key', 'host') or name.lower().startswith('x-claude-code-'):
            continue
        result.append(name + ':' + content)
    return '\n'.join(result)


def launch_spec(inherited, url, key, model, models, limits, extra=None):
    settings = copy.deepcopy(extra or {})
    for name in ('model', 'modelPicker', 'apiKeyHelper'):
        if name in settings:
            fail('Reserved session routing setting: ' + name)
    env = dict(inherited)
    routing = {'ANTHROPIC_BASE_URL': url, 'ANTHROPIC_AUTH_TOKEN': key, 'ANTHROPIC_API_KEY': '',
        'ANTHROPIC_CUSTOM_HEADERS': clean_headers(inherited.get('ANTHROPIC_CUSTOM_HEADERS', '')),
        'CLAUDE_CODE_OAUTH_TOKEN': '', 'CLAUDE_CODE_USE_BEDROCK': '0', 'CLAUDE_CODE_USE_VERTEX': '0', 'CLAUDE_CODE_USE_FOUNDRY': '0',
        'CLAUDE_CODE_MAX_CONTEXT_TOKENS': str(limits['context']), 'CLAUDE_CODE_MAX_OUTPUT_TOKENS': str(limits['output']),
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW': str(limits['compact']), 'CLAUDE_CODE_DISABLE_1M_CONTEXT': '1',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY': '1',
        'CLAUDE_CODE_GATEWAY_HINT_HEADERS': '1'}
    for name in ('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'):
        routing[name] = model
    supplied = settings.get('env', {})
    if not isinstance(supplied, dict):
        fail('Settings env must be an object')
    if any(name in routing or name.startswith('ANTHROPIC_') for name in supplied):
        fail('Reserved routing environment in --settings')
    for name in list(env):
        if name.startswith('ANTHROPIC_') or name in ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID'):
            env.pop(name, None)
    env.update(routing)
    settings.update(model=model, env=dict(supplied, **routing), apiKeyHelper='printf "%s" "$ANTHROPIC_AUTH_TOKEN"',
        modelPicker={'replaceBuiltInOptions': True, 'options': [{'model': x, 'label': x, 'description': 'GitHub Copilot'}
            for x in sorted(models, key=lambda x: (x != model, x))]})
    return env, settings


def claude_auto_wrapper(args):
    source = Path(shutil.which('claude-auto') or Path.home() / '.claude/claude-auto/claude-auto')
    if not source.exists():
        return None
    try:
        shared = runpy.run_path(str(source), run_name='claude_auto_wrapper')
        if not callable(shared['wrapper']) or not callable(shared['passthrough']):
            fail('Missing wrapper contract')
        return None if shared['passthrough'](args) else source
    except Exception:
        fail('Incompatible claude-auto source: ' + str(source))


class ModelGuard:
    """Only paired explicit hooks may change the main model. Helpers stay pinned."""
    def __init__(self, model, models):
        self.current = self.helper = model
        self.accepted = {model}  # Launch history, NOT an inference allowlist.
        self.models = set(models)
        self.sessions = {}
        self.pending = {}
        self.lock = threading.RLock()
        self.forwarded = []  # Model/path/status only, never prompts or credentials.

    def session(self, event):
        sid = event.get('session_id')
        try:
            valid = str(uuid.UUID(sid)) == sid
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid or event.get('hook_event_name') != 'SessionStart' or event.get('source') not in ('startup', 'resume', 'clear', 'compact'):
            fail('Invalid session registration')
        with self.lock:
            if len(self.sessions) >= 256 and sid not in self.sessions:
                fail('Session registration bound reached')
            self.sessions.setdefault(sid, self.current)
        return {}

    def switch(self, event):
        sid, kind, source = event.get('session_id'), event.get('hook_event_name'), event.get('source')
        intent = tuple(event.get(k) for k in ('session_id', 'source', 'from_model', 'to_model', 'requested_model'))
        with self.lock:
            explicit = (sid in self.sessions and source in ('command', 'picker', 'sdk')
                and event.get('requested_model') == event.get('to_model') and event.get('to_model') in self.models
                and event.get('from_model') == self.sessions.get(sid))
            if kind == 'PreModelSwitch':
                self.pending.pop(sid, None)
                if explicit:
                    self.pending[sid] = intent, time.monotonic()
                    return {}  # Never bypass the client's normal confirmation or another hook.
                return {'hookSpecificOutput': {'hookEventName': kind, 'permissionDecision': 'deny',
                    'permissionDecisionReason': 'Select an exact Copilot catalog ID; automatic substitution is refused.'}}
            if kind != 'PostModelSwitch':
                fail('Unknown model hook event')
            pending = self.pending.pop(sid, None)
            if explicit and pending and pending[0] == intent and time.monotonic() - pending[1] <= 30:
                self.sessions[sid] = self.current = event['to_model']
                self.accepted.add(self.current)
        return {}

    def launch_selection(self):
        with self.lock:
            return {'model': self.current, 'accepted': sorted(self.accepted)}

    def allowed(self, model, sid, request_class, agent_id):
        with self.lock:
            if sid not in self.sessions:
                return False
            if request_class == 'subagent' and not agent_id:
                return False
            expected = self.helper if request_class == 'subagent' else self.sessions[sid]
            return model == expected


class GuardServer(ThreadingHTTPServer):
    daemon_threads = False
    request_queue_size = 8

    def __init__(self, guard, backend, backend_key, limits):
        self.guard, self.backend, self.backend_key, self.limits = guard, backend, backend_key, limits
        self.key, self.control_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.slots = threading.BoundedSemaphore(8)
        self.sockets = set()
        self.socket_lock = threading.Lock()
        self.closing = False
        super().__init__(('127.0.0.1', 0), GuardHandler)
        self.url = 'http://127.0.0.1:' + str(self.server_address[1])

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request); return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release(); raise

    def track_socket(self, sock):
        with self.socket_lock:
            if self.closing:
                sock.close()
                raise OSError('Guard is closing')
            self.sockets.add(sock)

    def forget_socket(self, sock):
        with self.socket_lock:
            self.sockets.discard(sock)

    def close_connections(self):
        with self.socket_lock:
            self.closing = True
            for sock in self.sockets:
                try: sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                sock.close()

    def process_request_thread(self, request, address):
        try:
            self.track_socket(request)
            super().process_request_thread(request, address)
        finally:
            self.forget_socket(request)
            self.slots.release()

    def handle_error(self, request, address):
        pass  # Do not print request-related exceptions or secrets.


class GuardHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup(); self.connection.settimeout(8)

    def log_message(self, *args):
        pass

    def reply(self, status, value):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Connection', 'close')
        self.end_headers(); self.wfile.write(raw)

    def reject(self, reason, status=400):
        self.reply(status, {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'COPILOT_MODEL_GUARD: ' + reason}})

    def authenticated(self, control=False):
        key = self.server.control_key if control else self.server.key
        if self.headers.get_all('Host', []) != [self.server.url.removeprefix('http://')] or self.headers.get('Origin'):
            self.reject('unexpected origin'); return False
        auth, api = self.headers.get_all('Authorization', []), self.headers.get_all('x-api-key', [])
        if len(auth) != 1 or not secrets.compare_digest(auth[0], 'Bearer ' + key) or len(api) > 1 or (api and not secrets.compare_digest(api[0], key)):
            self.reject('local authentication required', 401); return False
        return True

    def do_GET(self):
        launch = self.path == '/guard/launch'
        if not self.authenticated(control=launch): return
        if launch:
            self.reply(200, self.server.guard.launch_selection()); return
        if self.path != '/v1/models':
            self.reject('unknown route', 404); return
        ids = sorted(self.server.guard.models)
        self.reply(200, {'data': [{'id': x, 'type': 'model', 'display_name': x, 'created_at': '2026-10-31T00:00:00Z'} for x in ids],
                         'has_more': False, 'first_id': ids[0], 'last_id': ids[-1]})

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        control = path in ('/guard/session', '/guard/switch')
        if not self.authenticated(control): return
        try:
            lengths = self.headers.get_all('Content-Length', [])
            if (len(lengths) != 1 or not lengths[0].isdigit() or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Encoding')
                    or not 0 < int(lengths[0]) <= (65536 if control else MAX_BODY)):
                fail('Invalid request framing/body bound')
            raw = self.rfile.read(int(lengths[0]))
            if len(raw) != int(lengths[0]): fail('Incomplete request body')
            data = json_object(raw)
            if path == '/guard/session':
                self.reply(200, self.server.guard.session(data)); return
            if path == '/guard/switch':
                self.reply(200, self.server.guard.switch(data)); return
            if path not in ('/v1/messages', '/v1/messages/count_tokens'):
                self.reject('unknown route', 404); return
            sessions = self.headers.get_all('x-claude-code-session-id', [])
            classes = self.headers.get_all('x-claude-code-request-class', [])
            agents = self.headers.get_all('x-claude-code-agent-id', [])
            if len(sessions) != 1 or len(classes) > 1 or len(agents) > 1 or data.get('fallbacks'):
                fail('Invalid session or server-side fallback')
            if not self.server.guard.allowed(data.get('model'), sessions[0], classes[0] if classes else None, agents[0] if agents else None):
                fail('Unaccepted model substitution or session')
            if path == '/v1/messages' and (type(data.get('max_tokens')) is not int or not 0 < data['max_tokens'] <= self.server.limits['output']):
                fail('Output limit exceeds catalog envelope')
        except (RuntimeError, ValueError, OSError, TypeError, KeyError) as error:
            self.reject(str(error) if isinstance(error, RuntimeError) else 'Invalid request shape'); return
        self.forward(data, path)

    def forward(self, data, path):
        origin = urllib.parse.urlsplit(self.server.backend)
        connection = http.client.HTTPConnection('127.0.0.1', origin.port, timeout=90)
        headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.server.backend_key}
        for name in ('anthropic-version', 'anthropic-beta', 'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-request-class'):
            if self.headers.get(name): headers[name] = self.headers[name]
        sent = False
        observation = {'model': data['model'], 'path': path, 'status': None}
        with self.server.guard.lock:
            self.server.guard.forwarded.append(observation)
        upstream_socket = None
        try:
            connection.connect()
            upstream_socket = connection.sock
            self.server.track_socket(upstream_socket)
            connection.request('POST', path, json.dumps(data).encode(), headers)
            response = connection.getresponse()
            observation['status'] = response.status
            if 300 <= response.status < 400:
                self.reject('native redirect refused', 502); return
            self.send_response(response.status)
            for name in ('Content-Type', 'Retry-After', 'x-github-request-id', 'x-request-id'):
                if response.getheader(name): self.send_header(name, response.getheader(name))
            self.send_header('Connection', 'close'); self.end_headers(); sent = True
            total, deadline = 0, time.monotonic() + 300
            while time.monotonic() < deadline:
                chunk = response.read1(65536)
                if not chunk: break
                total += len(chunk)
                if total > 16 * 1024 * 1024: break
                self.wfile.write(chunk); self.wfile.flush()
        except (OSError, http.client.HTTPException):
            if not sent: self.reject('native transport failed', 502)
        finally:
            connection.close()
            if upstream_socket is not None: self.server.forget_socket(upstream_socket)
            self.close_connection = True


@contextmanager
def guard_session(model, models, url, key, limits):
    origin = urllib.parse.urlsplit(url)
    if origin.scheme != 'http' or origin.hostname != '127.0.0.1' or not origin.port or origin.path or origin.query or origin.fragment or origin.username:
        fail('Guard backend must be a private loopback origin')
    server = GuardServer(ModelGuard(model, models), url, key, limits)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        yield server
    finally:
        server.shutdown(); server.close_connections(); server.server_close(); thread.join(timeout=5)


def read_control(control_path):
    path = safe_path(control_path)
    if path.stat().st_mode & 0o077: fail('Hook control file is not private')
    control = json_object(path.read_text())
    origin = urllib.parse.urlsplit(control['url'])
    if origin.scheme != 'http' or origin.hostname != '127.0.0.1' or not origin.port or origin.path or origin.query or origin.fragment or origin.username:
        fail('Hook control must be a private loopback origin')
    return control, origin


def guarded_settings(settings, required):
    """Validate the supervisor's effective settings and restore only our overlay."""
    settings = copy.deepcopy(settings)
    for name in ('model', 'modelPicker', 'apiKeyHelper'):
        if name in settings and settings[name] != required[name]:
            fail('Conflicting supervised routing setting: ' + name)
        settings[name] = copy.deepcopy(required[name])
    supplied = settings.setdefault('env', {})
    if not isinstance(supplied, dict): fail('Settings env must be an object')
    for name, value in supplied.items():
        if name in required['env'] or name.startswith('ANTHROPIC_'):
            if name not in required['env'] or value != required['env'][name]:
                fail('Conflicting supervised routing environment: ' + name)
    supplied.update(required['env'])
    hooks = settings.setdefault('hooks', {})
    if not isinstance(hooks, dict): fail('Settings hooks must be an object')
    for event, entries in required['hooks'].items():
        existing = hooks.setdefault(event, [])
        if not isinstance(existing, list): fail('Hook entries must be a list')
        for entry in entries:
            if entry not in existing: existing.append(copy.deepcopy(entry))
    return settings


def supervised_client(control_path, claude, args):
    control, _ = read_control(control_path)
    selection = fetch(control['url'] + '/guard/launch', {'Authorization': 'Bearer ' + control['key']}, timeout=4, limit=65536)
    model, accepted = selection.get('model'), selection.get('accepted')
    if not isinstance(model, str) or not isinstance(accepted, list) or model not in accepted:
        fail('Invalid accepted launch selection')
    # requestedModel can predate a confirmed switch. Launch with the current
    # accepted selection, not that historical model. History never grants inference.
    remaining, requested, settings = parse_args(args, {'CLAUDE_COPILOT_MODEL': model})
    if requested not in accepted:
        fail('Supervisor requested a model that was never explicitly accepted')
    directory = Path(control_path).parent
    required = json_object(safe_path(directory / 'guard-settings.json').read_text())
    settings = guarded_settings(settings, required)
    path = directory / 'child-settings.json'
    private_write(path, json.dumps(settings))
    # Helpers, policies, user hooks and literal prompts retain their original meaning.
    os.execv(claude, [claude, '--settings', str(path), '--model', model] + remaining)


def supervised_launcher(directory, claude):
    launcher = directory / 'guarded-client'
    command = [sys.executable, '-I', str(Path(__file__).resolve()), '_supervised-client',
               str(directory / 'guard-control.json'), claude]
    private_write(launcher, '#!/bin/sh\nexec ' + ' '.join(shlex.quote(x) for x in command) + ' "$@"\n', 0o700)
    return launcher


def session_hook(control_path):
    control, origin = read_control(control_path)
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536: fail('Hook body exceeds bound')
    data = json_object(raw)
    if data.get('hook_event_name') != 'SessionStart': fail('Unexpected command hook event')
    connection = http.client.HTTPConnection('127.0.0.1', origin.port, timeout=4)
    try:
        connection.request('POST', '/guard/session', json.dumps(data).encode(),
            {'Authorization': 'Bearer ' + control['key'], 'Content-Type': 'application/json'})
        response = connection.getresponse()
        if response.status != 200: fail('Session registration refused; inference remains blocked')
        response.read(65536)
    finally:
        connection.close()


def add_guard_hooks(settings, server, directory):
    hooks = settings.setdefault('hooks', {})
    if not isinstance(hooks, dict): fail('Settings hooks must be an object')
    control = directory / 'guard-control.json'
    private_write(control, json.dumps({'url': server.url, 'key': server.control_key}))
    entries = hooks.setdefault('SessionStart', [])
    if not isinstance(entries, list): fail('Hook entries must be a list')
    # SessionStart does not support HTTP handlers. The self-contained command
    # forwards only this event; keys stay in a private file, not argv or env.
    entries.append({'hooks': [{'type': 'command', 'command': sys.executable,
        'args': ['-I', str(Path(__file__).resolve()), '_session-hook', str(control)], 'timeout': 5}]})
    for event in ('PreModelSwitch', 'PostModelSwitch'):
        entries = hooks.setdefault(event, [])
        if not isinstance(entries, list): fail('Hook entries must be a list')
        entries.append({'hooks': [{'type': 'http', 'url': server.url + '/guard/switch',
            'headers': {'Authorization': 'Bearer ' + server.control_key}, 'timeout': 5, 'onFailure': 'block'}]})


def run_claude(state, args, capture=False):
    prerequisites()
    claude = shutil.which('claude')
    args, model, extra = parse_args(args, os.environ)
    wrapper = claude_auto_wrapper(args)
    stop_timeout = supervisor_stop_timeout(os.environ) if wrapper else 15
    with proxy_session(state) as (url, key, models, limits, directory, process):
        if model not in models:
            fail('Requested model unavailable on fresh Copilot route: ' + model + '; no fallback')
        with guard_session(model, models, url, key, limits) as server:
            env, required = launch_spec(os.environ, server.url, server.key, model, models, limits)
            add_guard_hooks(required, server, directory)
            _, settings = launch_spec(os.environ, server.url, server.key, model, models, limits, extra)
            settings = guarded_settings(settings, required)
            settings_path = directory / 'claude-settings.json'; private_write(settings_path, json.dumps(settings))
            command = [claude, '--settings', str(settings_path), '--model', model] + args
            if wrapper:
                private_write(directory / 'guard-settings.json', json.dumps(required))
                if 'CLAUDE_AUTO_NEXT_ARGS' in os.environ:
                    next_args, next_model, next_extra = parse_args(shlex.split(os.environ['CLAUDE_AUTO_NEXT_ARGS']),
                        {'CLAUDE_COPILOT_MODEL': model})
                    if next_model != model:
                        fail('NEXT_ARGS cannot preselect an unaccepted model; switch explicitly in the client')
                    _, next_settings = launch_spec(os.environ, server.url, server.key, model, models, limits, next_extra)
                    next_settings = guarded_settings(next_settings, required)
                    next_path = directory / 'claude-next-settings.json'; private_write(next_path, json.dumps(next_settings))
                    env['CLAUDE_AUTO_NEXT_ARGS'] = shlex.join(['--settings', str(next_path), '--model', model] + next_args)
                command = [sys.executable, str(wrapper)] + command[1:]
                env['CLAUDE_AUTO_CLAUDE'] = str(supervised_launcher(directory, claude))
            print('claude-copilot: ' + model + ' through private guard; context ceiling ' + str(limits['context']), file=sys.stderr)
            # Interactive Claude/supervisor must retain the controlling terminal and
            # receive Ctrl-C themselves. Only captured calls get a separate group.
            previous_sigint = signal.signal(signal.SIGINT, lambda *_: None) if not capture else None
            child = None
            try:
                child = subprocess.Popen(command, env=env, stdout=subprocess.PIPE if capture else None,
                                         stderr=subprocess.PIPE if capture else None, text=True, start_new_session=capture)
                stdout, stderr = child.communicate()
                result = subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
                result.route_model = model
                result.route_verified = any(x['path'] == '/v1/messages' and x['status'] == 200 and x['model'] == model for x in server.guard.forwarded)
                return result
            finally:
                if child is not None: stop_process(child, group=capture, timeout=stop_timeout)
                if previous_sigint is not None: signal.signal(signal.SIGINT, previous_sigint)


def verify(state):
    result = run_claude(state, ['-p', 'Reply exactly CLAUDE_COPILOT_OK. Do not use tools.', '--tools', '',
                               '--max-turns', '2', '--output-format', 'json'], capture=True)
    data = json_object(result.stdout)
    usage = data.get('modelUsage')
    if (result.returncode or data.get('subtype') != 'success' or data.get('is_error') is not False
            or data.get('result', '').strip() != 'CLAUDE_COPILOT_OK' or not isinstance(data.get('session_id'), str) or not data['session_id']
            or not isinstance(usage, dict) or set(usage) != {result.route_model} or not result.route_verified):
        fail('Verification failed: exit/envelope/sentinel/session/exact guarded model usage did not all match')
    report = {'verified': True, 'verified_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'session_id': data['session_id'], 'models': list(usage), 'result': 'CLAUDE_COPILOT_OK',
              'meaning': 'Past successful guarded request, not current health or independent upstream model attestation.'}
    private_write(state / 'verification.json', json.dumps(report, indent=2) + '\n')
    return report


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    command = args.pop(0) if args else 'help'
    home = Path.home(); state, _, _ = layout(home)
    if command == '_supervised-client':
        if len(args) < 2: fail('Missing private control path or client')
        supervised_client(args[0], args[1], args[2:]); return 0
    if command == '_session-hook':
        if len(args) != 1: fail('Missing private hook control path')
        session_hook(args[0]); return 0
    if command in ('help', '-h', '--help'):
        print('Usage: claude_copilot.py install --archive ZIP --account LOGIN --accept-native-code | login | models | run [Claude args] | verify | uninstall [--dry-run | --yes]')
        return 0
    if command == 'uninstall':
        if args not in (['--dry-run'], ['--yes']): fail('Use uninstall --dry-run first; removal requires --yes')
        uninstall(home, dry_run=args == ['--dry-run']); return 0
    if command == 'install':
        parser = argparse.ArgumentParser()
        parser.add_argument('--archive', type=Path); parser.add_argument('--account', required=True)
        parser.add_argument('--accept-native-code', action='store_true')
        options = parser.parse_args(args)
        if not options.accept_native_code: fail('Native code requires explicit --accept-native-code; see operations and licensing limits')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}', options.account): fail('Invalid account login')
        prerequisites(); preflight(home)
        if (state / 'config.json').exists() and read_config(state)['account'] != options.account:
            fail('Refusing to replace the configured account')
        if options.archive: checked_archive(options.archive)
        elif not (state / 'native/github-copilot.dylib').exists(): fail('Supply the reviewed local --archive ZIP')
        state = configure(home, sys.executable)
        try:
            if options.archive: install_native(state, options.archive)
            if not (state / 'config.json').exists(): private_write(state / 'config.json', json.dumps({'schema': 1, 'account': options.account}))
            if not any((state / 'auth').iterdir()): login(state)
            print(json.dumps(verify(state), indent=2))
        except BaseException:
            print('claude-copilot: partial installation; login/verification not completed. State retained for explicit retry.', file=sys.stderr)
            raise
        print('Installed and verified. Open a new zsh terminal and run claude-copilot.')
        return 0
    if not (state / 'owner').is_file() or (state / 'owner').read_text() != OWNER:
        fail('Run install first')
    if command == 'login':
        prerequisites(); login(state); return 0
    if command == 'models':
        prerequisites()
        with proxy_session(state) as (_, _, models, limits, _, _):
            print(json.dumps({'models': list(models), 'client_limits': limits}, indent=2))
        return 0
    if command == 'run': return run_claude(state, args).returncode
    if command == 'verify': print(json.dumps(verify(state), indent=2)); return 0
    fail('Unknown command: ' + command)


if __name__ == '__main__':
    os.umask(0o077)
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print('claude-copilot: ' + str(error), file=sys.stderr)
        sys.exit(1)
