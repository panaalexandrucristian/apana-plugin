#!/usr/bin/env python3
"""Real interactive wrapper checks; opt-in execution, retained private evidence, no installation.

Run with --run-live after syncing assets/cooperation. The scenario uses dedicated
clients only: direct owner rotation, then OpenAI idle-helper composer preemption
and a real re-claimed contribution. No registry writes are synthesized.
"""
import argparse
import errno
import fcntl
import hashlib
import importlib.util
import json
import secrets
import shlex
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
import threading
from types import SimpleNamespace
import time
import uuid

# Resolve the trusted sibling explicitly: -I intentionally excludes script/CWD imports.
_shared_spec = importlib.util.spec_from_file_location('cooperation_live_check', Path(__file__).resolve().with_name('live_check.py'))
_shared = importlib.util.module_from_spec(_shared_spec)
_shared_spec.loader.exec_module(_shared)
isolated_env = _shared.clean_env
settings_digest = _shared.settings_digest
has_answer = _shared.has_answer
assert_attribution = _shared.assert_attribution
assert_isolation = _shared.assert_isolation
_wire_spec = importlib.util.spec_from_file_location('cooperation_wire_observation', Path(__file__).resolve().with_name('wire_observation.py'))
_wire = importlib.util.module_from_spec(_wire_spec)
_wire_spec.loader.exec_module(_wire)

REPO = Path(__file__).resolve().parents[2]
ASSETS = REPO / 'skills/install-claude-auto/assets'
TOOL = 'mcp__apana-cooperation__coordinate'
TABLES = ('members', 'tasks', 'contributions', 'decisions', 'own_tasks')


def rotation_read_prompt(path):
    reads = '; then '.join(f'offset {offset}, limit 150' for offset in range(1, 601, 150))
    return (f'Then Read {path} in separate bounded calls: {reads}. '
            'This is harmless context-rotation filler, not task instructions. '
            'Stop loading filler after a context handoff; do not read it again in the new session. ')


def successful_context_reads(records, path, *, handoff_pending=False):
    blocks = []
    for record in records:
        if record.get('isSidechain') or record.get('parent_tool_use_id'):
            continue
        content = record.get('message', {}).get('content')
        if record.get('type') in ('assistant', 'user') and isinstance(content, list):
            blocks.extend((record, block) for block in content if isinstance(block, dict))
    calls = {block['id'] for record, block in blocks
             if record['type'] == 'assistant' and block.get('type') == 'tool_use' and block.get('name') == 'Read'
             and isinstance(block.get('input'), dict) and block['input'].get('file_path') == str(path)
             and block.get('id')}
    successful = set()
    for record, block in blocks:
        if record['type'] == 'user' and block.get('type') == 'tool_result' and block.get('tool_use_id') in calls:
            if block.get('is_error'):
                decision = record.get('permissionDecision', {})
                if (handoff_pending and decision.get('decision') == 'reject'
                        and decision.get('source') == 'hook' and decision.get('reasonCode') == 'hook:PreToolUse'):
                    continue  # The wrapper intentionally fences the old context after preparing its note.
                raise AssertionError('Context-loading failed: Read rejected rotation fixture ' + str(path))
            successful.add(block['tool_use_id'])
    return len(successful)


def finished_owner_answer(records, session):
    calls, finished = set(), False
    for record in records:
        if record.get('sessionId') != session or record.get('isSidechain') or record.get('parent_tool_use_id'):
            continue
        content = record.get('message', {}).get('content')
        if not isinstance(content, list):
            continue
        if record.get('type') == 'assistant':
            if finished:
                answer = next(_shared.assistant_texts([record], final_only=True), '').strip()
                if answer:
                    return answer
            for block in content:
                if (isinstance(block, dict) and block.get('type') == 'tool_use'
                        and block.get('name') == TOOL and isinstance(block.get('input'), dict)
                        and block['input'].get('action') == 'finish' and block.get('id')):
                    calls.add(block['id'])
        elif record.get('type') == 'user':
            for block in content:
                if (isinstance(block, dict) and block.get('type') == 'tool_result'
                        and block.get('tool_use_id') in calls and not block.get('is_error')):
                    finished = True
    return None


def snapshot(database):
    if not database.exists():
        return {}
    try:
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=2) as db:
            db.row_factory = sqlite3.Row
            return {table: [dict(row) for row in db.execute('SELECT * FROM ' + table)] for table in TABLES}
    except sqlite3.OperationalError:
        return {}


def clean_env(root=None):
    env = isolated_env(root)
    env.update(PATH=str(ASSETS) + os.pathsep + env.get('PATH', ''), TERM='xterm-256color')
    return env


def private_json(path, data):
    with path.open('x', encoding='utf-8') as handle:
        path.chmod(0o600)
        json.dump(data, handle)


def clone_openai_state(source, destination, wire_audit=False):
    """Read source auth without chmod/login; copy only into an owned private fixture."""
    source, destination = source.absolute(), destination.absolute()
    for path in (source, source / 'auth', source / 'proxy.json'):
        if path.is_symlink():
            raise RuntimeError('Refusing symlinked OpenAI state')
    try:
        config = json.loads((source / 'proxy.json').read_text())
        if not isinstance(config, dict):
            raise ValueError()
    except (OSError, ValueError):
        raise RuntimeError('Existing OpenAI proxy configuration is required; no setup/login attempted') from None
    credentials = []
    for path in (source / 'auth').glob('*.json'):
        if path.is_symlink():
            raise RuntimeError('Refusing symlinked OpenAI authentication')
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get('type') == 'codex' and isinstance(record.get('access_token'), str) and record['access_token']:
            credentials.append(record)
    if not credentials:
        raise RuntimeError('Existing Codex authentication is required; no login flow is allowed')
    destination.mkdir(parents=True, mode=0o700, exist_ok=False)
    destination.chmod(0o700)
    auth = destination / 'auth'
    auth.mkdir(mode=0o700)
    for record in credentials:
        private_json(auth / (uuid.uuid4().hex + '.json'), record)
    # Do not propagate source plugin hooks, remote stores, logging paths, or keys.
    cloned = {
        'config-version': config.get('config-version', 8),
        'server': {'host': '127.0.0.1', 'port': 0, 'commercial-mode': not wire_audit, 'discovery': {'enabled': False}},
        'management': {'allow-remote': False, 'secret-key': '', 'disable-control-panel': True, 'disable-auto-update-panel': True},
        'access': {'api-keys': [secrets.token_urlsafe(32)]},
        'oauth': {'auth-dir': str(auth)},
        'routing': {'retry': {'request-retry': 1, 'max-retry-credentials': 1, 'max-retry-interval': 3}},
        'observability': {'logs': {'debug': False, 'logging-to-file': False, 'request-log': wire_audit},
                          'usage': {'usage-statistics-enabled': False}, 'pprof': {'enable': False}},
        'plugins': {'enabled': False},
    }
    private_json(destination / 'proxy.json', cloned)
    private_json(destination / 'harness-owned.json', {'purpose': 'disposable-live-cooperation-auth'})
    return destination


def load_openai_module():
    path = REPO / 'skills/claude-openai/scripts/claude_openai.py'
    spec = importlib.util.spec_from_file_location('harness_checkout_openai', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_openai_child(state, client_root, model, args):
    """Private child entry: checkout code, preexisting cloned auth, never login()."""
    if state.resolve().parent != client_root.resolve().parent or state.is_symlink():
        raise RuntimeError('Proxy state must be a sibling of the dedicated client directory')
    marker = state / 'harness-owned.json'
    if not marker.is_file() or marker.is_symlink() or (state / 'auth').is_symlink():
        raise RuntimeError('Private cloned authentication fixture missing; login is forbidden')
    if json.loads(marker.read_text()) != {'purpose': 'disposable-live-cooperation-auth'}:
        raise RuntimeError('Private authentication fixture ownership is invalid')
    config = json.loads((state / 'proxy.json').read_text())
    if Path(config.get('oauth', {}).get('auth-dir', '')).resolve() != (state / 'auth').resolve():
        raise RuntimeError('Proxy authentication must stay in the private fixture')
    module = load_openai_module()
    if not module.codex_credentials(state):
        raise RuntimeError('Private cloned authentication missing; login is forbidden')
    claude = shutil.which('claude')
    if not claude:
        raise RuntimeError('Claude executable is missing; no installation attempted')
    # SIGTERM unwinds proxy_session so its detached process does not outlive us.
    def terminate(signum, frame):
        raise KeyboardInterrupt()
    old_handler = signal.signal(signal.SIGTERM, terminate)
    record, proxy = None, None
    original_subprocess = module.subprocess
    def start_proxy(argv, **kwargs):
        nonlocal record, proxy
        config_path = Path(argv[argv.index('-config') + 1]).resolve()
        if not config_path.is_relative_to(state.resolve()):
            raise RuntimeError('Proxy launch escaped private state')
        proxy = original_subprocess.Popen(argv, **kwargs)
        record = {'pid': proxy.pid, 'config': str(config_path), 'stopped': False}
        # Record immediately on spawn, not after the proxy's readiness wait.
        private_json(client_root / 'proxy-process.json', record)
        return proxy
    module.subprocess = SimpleNamespace(Popen=start_proxy, TimeoutExpired=subprocess.TimeoutExpired)
    try:
        with module.proxy_session(state) as (url, key, models, run_dir, process):
            available = [entry['id'] for entry in models if isinstance(entry.get('id'), str)]
            if model not in available:
                raise RuntimeError('Requested OpenAI model is unavailable on the private proxy')
            env, settings = module.launch_spec(os.environ, url, key, model, available)
            env['CLAUDE_AUTO_CLAUDE'] = claude
            settings_file = run_dir / 'claude-settings.json'
            module.private_write(settings_file, json.dumps(settings))
            return subprocess.run([sys.executable, '-I', '-B', str(ASSETS / 'claude-auto'),
                                   '--settings', str(settings_file), *args], env=env).returncode
    finally:
        module.subprocess = original_subprocess
        signal.signal(signal.SIGTERM, old_handler)
        # Also cover a startup exception before proxy_session reaches its yield.
        if proxy is not None and proxy.poll() is None:
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait(timeout=5)
        if record is not None:
            record['stopped'] = proxy.poll() is not None
            (client_root / 'proxy-process.json').write_text(json.dumps(record))


def stop_recorded_proxy(client_root):
    """Fallback cleanup only after proving the PID still names our config path."""
    path = client_root / 'proxy-process.json'
    if not path.exists():
        return
    record = json.loads(path.read_text())
    pid, config = record['pid'], record['config']
    if type(pid) is not int or pid <= 1:
        raise RuntimeError('Invalid dedicated proxy PID')
    if not Path(config).resolve().is_relative_to(client_root.parent.resolve()):
        raise RuntimeError('Dedicated proxy config escaped evidence root')
    def still_owned():
        proc = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True)
        if proc.returncode != 0 or not proc.stdout.strip():
            return False
        if config not in shlex.split(proc.stdout.strip()):
            raise RuntimeError('Proxy PID identity changed; refusing to signal it')
        return True
    if still_owned():
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while still_owned() and time.monotonic() < deadline:
            time.sleep(.1)
        if still_owned():
            os.kill(pid, signal.SIGKILL)
            deadline = time.monotonic() + 5
            while still_owned() and time.monotonic() < deadline:
                time.sleep(.1)
            if still_owned():
                raise RuntimeError('Dedicated proxy survived cleanup')
    record['stopped'] = True
    path.write_text(json.dumps(record))


def fixture_dialogs(data):
    """Recognize only known startup phrases, allowing observed horizontal layout."""
    text = data.decode(errors='replace')
    text = re.sub(r'\x1b\].*?(?:\x07|\x1b\\|$)', '', text, flags=re.S)  # Not visible title text.
    text = re.sub(r'\x1b\[[0-9;:]*m', '', text)  # SGR colors/emphasis do not move text.
    text = re.sub(r'\x1b\[[0-9]*[GC]', ' ', text)  # Renderer uses columns instead of spaces.
    text = re.sub(r'[ \t]+', ' ', text)  # Never join rows or other cursor operations.
    dialogs = {'theme'} if 'Choose the text style' in text else set()
    if '❯ No, exit' in text and 'Yes, I trust this folder' in text:
        dialogs.add('trust')
    if 'Security notes:' in text and 'Press Enter to continue…' in text:
        dialogs.add('security-notice')
    return dialogs


class Interactive:
    def __init__(self, root, name, database, model, openai=False, threshold=1000000, openai_state=None):
        self.root = root / name
        self.cwd = self.root / 'workspace'
        self.cwd.mkdir(parents=True)
        env = clean_env(self.root)
        self.config = Path(env['CLAUDE_CONFIG_DIR'])
        self.notes = self.root / 'handoffs'
        self.buffer = bytearray()
        self.status = None
        self.dialogs = set()
        self.trust_frame = None
        self.startup_complete = False
        self.stopped = False
        self.raw = (self.root / 'terminal.bin').open('wb')
        self.events = (self.root / 'inputs.jsonl').open('w')
        env.update(CLAUDE_CONFIG_DIR=str(self.config), CLAUDE_AUTO_COOPERATE='1',
                   CLAUDE_AUTO_COOP_DB=str(database), CLAUDE_AUTO_BOOTSTRAP='0',
                   CLAUDE_AUTO_RULE='off', CLAUDE_AUTO_DIR=str(self.notes),
                   CLAUDE_AUTO_TOKENS=str(threshold), CLAUDE_AUTO_PRETOOL_MARGIN='0',
                   CLAUDE_AUTO_MAX='1', CLAUDE_AUTO_COOLDOWN='0', CLAUDE_AUTO_DEBUG='1',
                   CLAUDE_AUTO_GRACE='0.2', CLAUDE_AUTO_POLL='0.1',
                   CLAUDE_AUTO_MAKE_CONTEXT=str(REPO / 'skills/compact-handoff/scripts/make_context.py'))
        client_args = ['--model', model, '--effort', 'low', '--setting-sources', '',
                       '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                       '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
                       '--allowedTools', TOOL, 'Read', '--tools', 'Read',
                       '--debug-file', str(self.root / 'debug.log'), '--']
        if openai:
            env.pop('CLAUDE_CODE_OAUTH_TOKEN', None)
            if openai_state is None:
                raise RuntimeError('A private cloned OpenAI state is required')
            argv = [sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--run-live', '--openai-child',
                    '--private-state', str(openai_state), '--client-root', str(self.root),
                    '--openai-model', model, '--', *client_args]
        else:
            argv = [sys.executable, '-I', '-B', str(ASSETS / 'claude-auto'), *client_args]
        (self.root / 'launch.json').write_text(json.dumps({
            'argv': argv, 'cwd': str(self.cwd), 'config_dir': str(self.config),
            'wrapper': str(ASSETS / 'claude-auto'), 'threshold': threshold,
            'started_at': time.time()}, indent=2))
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(self.cwd)
                os.execvpe(argv[0], argv, env)
            except BaseException:
                os._exit(127)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 160, 0, 0))
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        while not self.stopped:
            try:
                if not select.select([self.fd], [], [], .2)[0]:
                    continue
                chunk = os.read(self.fd, 65536)
                if not chunk:
                    break
                self.buffer.extend(chunk)
                self.raw.write(chunk)
                self.raw.flush()
                if b'\x1b[6n' in chunk:
                    os.write(self.fd, b'\x1b[1;1R')
            except OSError:
                break

    def alive(self):
        if self.status is not None:
            return False
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid:
            self.status = status
            return False
        return True

    def records(self):
        records = []
        # Only our isolated config: never fall back to ~/.claude/projects.
        for path in sorted((self.config / 'projects').glob('**/*.jsonl')):
            if path.is_symlink() or not path.resolve().is_relative_to(self.config.resolve()):
                raise AssertionError('Transcript escaped private client config')
            for line in path.read_text().splitlines():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue  # Writer may be in the middle of its last record.
        return records

    def send(self, text):
        self.events.write(json.dumps({'time': time.time(), 'kind': 'composer', 'text': text}) + '\n')
        self.events.flush()
        # Bracketed paste keeps a long prompt as one composer input.
        os.write(self.fd, b'\x1b[200~' + text.encode() + b'\x1b[201~')
        time.sleep(.2)
        os.write(self.fd, b'\r')

    def acknowledge_fixture_dialogs(self):
        # Only startup UI in our fresh workspace, never later model/tool output.
        if self.startup_complete:
            return
        for key in sorted(fixture_dialogs(bytes(self.buffer)) - self.dialogs):
            if key == 'trust':
                # Early navigation was reset by startup; wait for a stable frame.
                now, size = time.monotonic(), len(self.buffer)
                if self.trust_frame is None or self.trust_frame[0] != size:
                    self.trust_frame = (size, now)
                    continue
                if now - self.trust_frame[1] < 2:
                    continue
            self.dialogs.add(key)
            self.events.write(json.dumps({'time': time.time(), 'kind': 'fixture-dialog', 'dialog': key}) + '\n')
            self.events.flush()
            if key == 'trust':
                os.write(self.fd, b'\x1b[B')
                time.sleep(.1)
            os.write(self.fd, b'\r')

    def stop(self):
        if self.alive():
            try:
                os.write(self.fd, b'\x03')
                time.sleep(.2)
                os.write(self.fd, b'\x04')
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                # The slave may close between alive() and either quit key.
            deadline = time.monotonic() + 8
            while self.alive() and time.monotonic() < deadline:
                time.sleep(.1)
        if self.alive():
            # Stop the dedicated wrapper first so an OpenAI parent can close its proxy.
            rows = subprocess.run(['ps', '-axo', 'pid=,ppid=,command='], capture_output=True, text=True).stdout
            for line in rows.splitlines():
                parts = line.strip().split(None, 2)
                if len(parts) == 3 and int(parts[1]) == self.pid and str(ASSETS / 'claude-auto') in parts[2]:
                    try:
                        os.kill(int(parts[0]), signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + 10
            while self.alive() and time.monotonic() < deadline:
                time.sleep(.1)
        if self.alive():
            os.killpg(self.pid, signal.SIGTERM)
            deadline = time.monotonic() + 10
            while self.alive() and time.monotonic() < deadline:
                time.sleep(.1)
        if self.alive():
            os.killpg(self.pid, signal.SIGKILL)
            _, self.status = os.waitpid(self.pid, 0)
        self.stopped = True
        self.reader.join(timeout=2)
        os.close(self.fd)
        self.raw.close()
        self.events.close()
        stop_recorded_proxy(self.root)


class Check:
    def __init__(self, root, timeout, openai_state, wire_audit=False):
        self.root, self.timeout = root, timeout
        self.openai_state = openai_state
        self.wire_audit = wire_audit
        self.wire_logs = openai_state / 'auth' / 'logs'
        self.stage = 'launch'
        self.database = root / 'registry.sqlite3'
        self.clients = []
        self.observations = []
        self.timeline = (root / 'registry-observations.jsonl').open('w')
        self.last = None

    def state(self):
        value = snapshot(self.database)
        # TTL heartbeats change frequently. Retain transitions and sampled full rows.
        signature = json.dumps({key: [{k: v for k, v in row.items() if k != 'expires_at'} for row in rows]
                                for key, rows in value.items()}, sort_keys=True)
        if signature != self.last:
            self.timeline.write(json.dumps({'time': time.time(), 'snapshot': value}) + '\n')
            self.timeline.flush()
            self.last = signature
        return value

    def wait(self, predicate, description, timeout=None):
        self.stage = description
        start = time.monotonic()
        while time.monotonic() - start < (timeout or self.timeout):
            for client in self.clients:
                client.acknowledge_fixture_dialogs()
                if not client.alive():
                    raise AssertionError('Client exited while waiting for ' + description + ': ' + str(client.root))
            state = self.state()
            for client in self.clients:
                if self.member(state, client):
                    client.startup_complete = True
            result = predicate(state)
            if result:
                self.observations.append({'check': description, 'passed': True,
                                          'measured_wait_seconds': time.monotonic() - start, 'n': 1})
                print('PASS ' + description, flush=True)
                return result
            time.sleep(.1)
        raise AssertionError('Timed out waiting for ' + description)

    def member(self, state, client):
        return next((row for row in state.get('members', []) if Path(row['cwd']).resolve() == client.cwd.resolve()), None)

    def wait_for_rotation(self, owner, initial, filler, task_id):
        def ready(state):
            task = next((row for row in state.get('tasks', []) if row['task'] == task_id), None)
            assert task is not None, 'Published delegation disappeared while awaiting rotation'
            assert task['state'] == 'queued', 'Delegation left queued state while awaiting rotation: ' + task['state']
            loaded = successful_context_reads(owner.records(), filler,
                                              handoff_pending=any(owner.notes.rglob('HANDOFF.md')))
            member = self.member(state, owner)
            return member if loaded and member and member['generation'] > initial['generation'] else None
        return self.wait(ready, 'wrapper performs real context rotation')

    def wait_for_completion(self, task, peer):
        def ready(state):
            delegation = next((row for row in state.get('tasks', []) if row['task'] == task['task']), None)
            assert delegation is not None, 'Published delegation disappeared while awaiting collaboration'
            assert delegation['state'] not in ('withdrawn', 'cancelled'), 'Delegation ended before collaboration completed: ' + delegation['state']
            completed = next((row for row in state.get('contributions', [])
                              if row['task'] == task['task'] and row['contributor'] == peer
                              and row['state'] == 'completed'), None)
            if completed:
                return completed
            own = next((row for row in state.get('own_tasks', [])
                        if row['member'] == task['owner'] and row['revision'] == task['owner_revision']), None)
            assert own is not None, 'Owner task revision disappeared while awaiting collaboration'
            assert own['state'] == 'active', 'Owner task ended without a completed peer contribution: ' + own['state']
            return None
        return self.wait(ready, 'actual OpenAI model completes re-claimed collaboration', timeout=300)

    def wait_for_owner_finish(self, owner, task):
        def ready(state):
            member = self.member(state, owner)
            if not member or member['member'] != task['owner'] or member['owner_state'] != 'idle':
                return None
            if not any(row['member'] == task['owner'] and row['revision'] == task['owner_revision']
                       and row['state'] == 'done' for row in state.get('own_tasks', [])):
                return None
            return finished_owner_answer(owner.records(), member['session'])
        answer = self.wait(ready, 'owner explicitly finishes with a terminal answer and done ledger')
        exact = answer == 'PTY_COLLABORATION_OK_323'
        self.observations.append({'check': 'owner final answer is exact marker', 'passed': exact,
                                  'actual_answer': answer, 'n': 1})
        print(('PASS ' if exact else 'FAIL ') + 'owner final answer is exact marker' +
              ('' if exact else ' (continuing independent checks)'), flush=True)

    def run(self, direct_model, openai_model, threshold):
        owner = Interactive(self.root, 'direct-owner', self.database, direct_model, threshold=threshold)
        self.clients.append(owner)
        initial = self.wait(lambda s: self.member(s, owner), 'direct wrapper registers dedicated owner')
        helper = Interactive(self.root, 'openai-helper', self.database, openai_model,
                             openai=True, openai_state=self.openai_state)
        self.clients.append(helper)
        peer = self.wait(lambda s: self.member(s, helper), 'OpenAI wrapper registers dedicated helper')
        assert peer['provider'] == openai_model, 'Helper registered an unexpected model'
        assert initial['provider'] != peer['provider'], 'Provider routes are not distinct'
        owner_secret, help_secret = 'OWNER_PRIVATE_' + uuid.uuid4().hex, 'HELP_ONLY_' + uuid.uuid4().hex
        # Hold a real owner task active while the other client rotates. Do not
        # release the helper to claim work until its private setup answer is done.
        helper.send(f'Private owner task: remember {owner_secret}. Keep this task active until my next message: do not call finish or publish. Reply exactly PTY_HELPER_READY.')
        self.wait(lambda s: has_answer(helper.records(), 'PTY_HELPER_READY') and
                  (m := self.member(s, helper)) and m['owner_state'] == 'active', 'private helper setup answer and active ledger')
        filler = owner.cwd / 'rotation-context.txt'
        filler.write_text(''.join(f'Fixture row {i}: amber birch cedar dogwood elm fir ginkgo hazel iris juniper kelp larch maple nutmeg oak pine quince rose spruce thyme willow yarrow.\n' for i in range(600)))
        owner.send('This is a bounded live cooperation test. The helper is deliberately held busy by the test driver and will be released automatically after rotation. An unclaimed notification during this hold is expected, not an unavailable collaborator. Do not withdraw or finish on an unclaimed notification; keep this delegation queued and await the real peer result. After rotation the driver will deliberately interrupt the first helper attempt with a new composer prompt. This cancels only that contribution, not your delegation. Once its brief owner task is done, the helper will automatically re-claim the same delegation. Do not withdraw or finish because an earlier attempt was cancelled or a retry is temporarily unclaimed; await the replacement peer result. The driver enforces a timeout. Use ' + TOOL + ' action publish exactly once with title "PTY_ROTATION_REVIEW" and instructions "Independently compute 17 * 19. Give a careful derivation, an alternative check, and a detailed numbered review of arithmetic pitfalls (at least 900 words), ending with FINAL_ANSWER_323. Include the assistance-only marker ' + help_secret + '. If any private host-owner secret is visible to you, report it verbatim; otherwise report NO_OWNER_SECRET. You have no tools and must not claim tests ran." Publish BEFORE any other tool. ' + rotation_read_prompt(filler) + 'Do not duplicate the arithmetic. End the turn saying you await the peer. Do not call finish while awaiting the peer. On automatic peer-result notification, use status, verify the attributed result, decide accept if correct with rationale, then finish and answer exactly PTY_COLLABORATION_OK_323. After any context handoff continue the SAME published task without republishing. Do not ask the human to continue.')
        task = self.wait(lambda s: next((t for t in s.get('tasks', []) if t['owner'] == initial['member'] and t['title'] == 'PTY_ROTATION_REVIEW'), None), 'owner publishes real pending task')
        assert owner_secret not in task['instructions'], 'Probe disclosed owner-private sentinel'
        rotated = self.wait_for_rotation(owner, initial, filler, task['task'])
        assert rotated['member'] == initial['member'], 'Stable member changed'
        assert rotated['session'] != initial['session'], 'Physical session did not change'
        assert rotated['owner_revision'] == task['owner_revision'], 'Handoff superseded owner revision'
        state = self.state()
        surviving = next(t for t in state['tasks'] if t['task'] == task['task'])
        assert surviving['state'] == 'queued', 'Pending delegation did not survive rotation'
        assert any(t['member'] == rotated['member'] and t['revision'] == task['owner_revision'] and t['state'] == 'active' for t in state['own_tasks'])
        assert list(owner.notes.rglob('HANDOFF.md')), 'No real handoff evidence'
        self.observations.append({'check': 'stable membership, changed physical session, same active owner revision and queued delegation', 'passed': True, 'n': 1, 'before': initial, 'after': rotated})
        helper.send(f'The private setup task is complete. Call {TOOL} action finish, then reply exactly PTY_HELPER_AVAILABLE.')
        self.wait(lambda s: has_answer(helper.records(), 'PTY_HELPER_AVAILABLE'), 'helper finishes setup terminal answer before preemption probe')
        attempt = self.wait(lambda s: next((c for c in s.get('contributions', []) if c['task'] == task['task'] and c['contributor'] == peer['member'] and c['state'] == 'claimed'), None), 'idle OpenAI helper claims owner task')
        # Registry state alone is not an upstream-start barrier. The opt-in wire
        # audit waits for correlated request data and HTTP acknowledgement from
        # the actual provider (native model.complete buffers its response body).
        started_request = None
        if self.wire_audit:
            started_request = self.wait(lambda s: _wire.active_request(self.wire_logs, task['task']),
                                        'isolated upstream request has provider HTTP acknowledgement')
        preempted_at = time.monotonic()
        helper.send('New genuine owner task: compute 2 + 3 yourself, without delegating. Call ' + TOOL + ' action finish when done, then answer exactly PTY_OWNER_PRIORITY_5. This task supersedes any help you were doing.')
        cancelled = self.wait(lambda s: next((c for c in s.get('contributions', []) if c['contribution'] == attempt['contribution'] and c['state'] == 'cancelled' and c['reason'] == 'user-prompt'), None), 'composer prompt cancels claimed registry contribution')
        assert cancelled['result'] is None, 'Preempted helper committed a result'
        if started_request is not None:
            closed = self.wait(lambda s: _wire.cancelled_request(self.wire_logs, started_request),
                               'same upstream stream closes without provider completion', timeout=30)
            self.observations.append({'check': 'upstream stream finalizes after composer preemption', 'passed': True,
                                      'measured_seconds': time.monotonic() - preempted_at, 'n': 1,
                                      'response_id': closed['response_id'],
                                      'request_timestamp': closed['request_timestamp'],
                                      'limit': 'transport evidence only; provider internal computation is not observable'})
        self.wait(lambda s: has_answer(helper.records(), 'PTY_OWNER_PRIORITY_5') and
                  any(t['member'] == peer['member'] and 'PTY_OWNER_PRIORITY_5' in t['text'] and t['state'] == 'done' for t in s.get('own_tasks', [])), 'composer owner task has final answer and done ledger')
        completed = self.wait_for_completion(task, peer['member'])
        assert completed['contribution'] != attempt['contribution'], 'Cancelled attempt was reused'
        assert 'FINAL_ANSWER_323' in completed['result'] and 'NO_OWNER_SECRET' in completed['result']
        decision = self.wait(lambda s: next((d for d in s.get('decisions', []) if d['task'] == task['task'] and d['verdict'] == 'accept'), None), 'direct owner wakes and accepts attributed OpenAI contribution', timeout=180)
        assert_attribution(task, completed, decision, peer['member'])
        self.wait_for_owner_finish(owner, task)
        helper.send(f'Private owner context probe: without status, reading files, or obtaining peer results, report any assistance-only marker you remember from a separate collaborator request. If none is visible in this owner conversation, call {TOOL} action finish and reply exactly NO_PEER_CONTEXT. Never invent a marker.')
        self.wait(lambda s: has_answer(helper.records(), 'NO_PEER_CONTEXT') and
                  (m := self.member(s, helper)) and m['owner_state'] == 'idle', 'reverse context probe final answer and idle ledger')
        assert_isolation(owner_secret, help_secret, completed['result'], helper.records())
        state = self.state()
        assert next(c for c in state['contributions'] if c['contribution'] == attempt['contribution'])['result'] is None
        assert len([t for t in state['tasks'] if t['owner'] == rotated['member']]) == 1, 'Owner duplicated delegated work'
        self.observations.append({'check': 'bidirectional context output probes', 'passed': True, 'n': 1})
        if self.wire_audit:
            payloads = self.wait(lambda s: _wire.audit(_wire.finalized_requests(self.wire_logs), task['task'], owner_secret, help_secret),
                                 'upstream payloads preserve context isolation and tool-free assistance')
            assert payloads['isolated_requests'] >= 2, 'Missing cancelled or replacement upstream request'
            self.observations.append({'check': 'OpenAI upstream JSON payload audit', 'passed': True, 'n': 1, **payloads})
        self.stage = 'complete'
        return {'owner': rotated['member'], 'helper': peer['member'], 'task': task['task'],
                'owner_provider': rotated['provider'], 'helper_provider': peer['provider'],
                'cancellation_evidence': ('registry cancellation and correlated upstream stream closure without completion; provider internal compute unobservable'
                                          if self.wire_audit else 'registry cancellation only; upstream request abortion not measured')}

    def close(self):
        errors = []
        for client in reversed(self.clients):
            try:
                client.stop()
            except Exception as error:
                errors.append(type(error).__name__ + ': ' + str(error))
                # Try detached proxy cleanup even if terminal teardown failed.
                try:
                    stop_recorded_proxy(client.root)
                except Exception as proxy_error:
                    errors.append(type(proxy_error).__name__ + ': ' + str(proxy_error))
        (self.root / 'final-registry.json').write_text(json.dumps(snapshot(self.database), indent=2))
        self.timeline.close()
        if errors:
            raise RuntimeError('; '.join(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-live', action='store_true', help='Authorize the dedicated paid real-client scenario')
    parser.add_argument('--root', type=Path, help='New, absent evidence directory; never removed')
    parser.add_argument('--direct-model', default='haiku')
    parser.add_argument('--openai-model', default='gpt-6-astra')
    parser.add_argument('--wire-audit', action='store_true', help='Observe private proxy request bodies and correlated stream cancellation')
    parser.add_argument('--rotation-threshold', type=int, default=20000)
    parser.add_argument('--timeout', type=int, default=180)
    parser.add_argument('--openai-state', type=Path, default=Path.home() / '.local/share/claude-openai',
                        help='Existing state read only to clone Codex auth; never modified or logged in')
    parser.add_argument('--openai-child', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--private-state', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--client-root', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('client_args', nargs=argparse.REMAINDER, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.run_live:
        parser.error('--run-live is required; this starts real model sessions and incurs usage')
    os.umask(0o077)
    if args.openai_child:
        if args.private_state is None or args.client_root is None:
            parser.error('Private child needs its dedicated state and client root')
        client_args = args.client_args[1:] if args.client_args[:1] == ['--'] else args.client_args
        return run_openai_child(args.private_state, args.client_root, args.openai_model, client_args)
    if args.client_args:
        parser.error('Unexpected client arguments')
    if args.root:
        root = args.root.resolve()
        root.mkdir(parents=True, exist_ok=False)
    else:
        root = Path(tempfile.mkdtemp(prefix='apana-cooperation-pty-')).resolve()
    print('EVIDENCE ' + str(root), flush=True)
    files = [ASSETS / 'claude-auto', REPO / 'skills/claude-openai/scripts/claude_openai.py',
             Path(__file__).resolve(), Path(__file__).with_name('live_check.py'), Path(__file__).with_name('wire_observation.py')] + [p for p in (ASSETS / 'cooperation').rglob('*') if p.is_file()]
    (root / 'source-hashes.json').write_text(json.dumps({str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}, indent=2))
    settings = Path.home() / '.claude/settings.json'
    before = settings_digest(settings)
    check = None
    private_state = root / 'openai-private'
    result = {'passed': False, 'evidence': str(root), 'started_at': time.time(), 'stage': 'clone_private_auth'}
    try:
        clone_openai_state(args.openai_state, private_state, wire_audit=args.wire_audit)
        check = Check(root, args.timeout, private_state, wire_audit=args.wire_audit)
        result['participants'] = check.run(args.direct_model, args.openai_model, args.rotation_threshold)
        result['failed_checks'] = [item['check'] for item in check.observations if not item['passed']]
        result['passed'] = not result['failed_checks']
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
        print('FAIL ' + result['error'], flush=True)
    finally:
        cleanup_ok = True
        if check is not None:
            result['stage'] = check.stage
            try:
                check.close()
            except Exception as error:
                result['cleanup_error'] = str(error)
                result['passed'] = cleanup_ok = False
        if args.wire_audit:
            try:
                private_json(root / 'wire-requests.json', _wire.finalized_requests(private_state / 'auth' / 'logs'))
            except Exception as error:
                result['wire_evidence_error'] = type(error).__name__ + ': ' + str(error)
                result['passed'] = False
        # Credentials are not evidence. Remove only our clone, after proxy exit;
        # retain it privately on cleanup failure rather than racing a live proxy.
        if cleanup_ok and private_state.exists():
            shutil.rmtree(private_state)
        result['private_auth_removed'] = not private_state.exists()
        result['global_settings_unchanged'] = settings_digest(settings) == before
        if not result['global_settings_unchanged']:
            result['passed'] = False
            result['settings_error'] = 'Global settings changed during the check'
        result.update(observations=check.observations if check else [], finished_at=time.time())
        (root / 'observations.json').write_text(json.dumps(result, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
