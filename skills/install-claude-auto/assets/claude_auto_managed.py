"""Opt-in text front end; no lifecycle hooks or terminal input injection.

Each admitted turn owns a print-mode process. Stdin closes after one structured
message; the next turn resumes only after that process exits.
"""
import collections
import glob
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid

GUIDANCE = (
    'This text interface has no native permission dialogs: actions needing approval are denied, never silently approved. '
    'Do not start background processes or asynchronous subagents; keep work within the current turn. '
    'Do not execute slash commands to change model, effort or global settings. Ask the user to restart with launch flags.'
)
VALUE_FLAGS = {'--model', '--effort', '--permission-mode', '--settings', '--append-system-prompt',
               '--system-prompt', '--fallback-model', '--max-budget-usd', '--name', '-n',
               '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--add-dir'}
PLAIN_FLAGS = {'--no-chrome'}


def arguments(args):
    """A deliberately small interface; unknown/lifecycle flags never pass through."""
    flags, i = [], 0
    while i < len(args):
        arg = args[i]
        if arg == '--':
            return flags, ' '.join(args[i + 1:])
        if not arg.startswith('-'):
            return flags, ' '.join(args[i:])
        name, eq, value = arg.partition('=')
        if name in PLAIN_FLAGS and not eq:
            flags.append(name)
        elif name in VALUE_FLAGS:
            if not eq:
                i += 1
                if i >= len(args) or args[i].startswith('--'):
                    raise ValueError(name + ' requires a value')
                value = args[i]
            if not value or (name == '--permission-mode' and value == 'bypassPermissions'):
                raise ValueError('unsupported value for ' + name)
            flags.extend((name, value))
        else:
            raise ValueError('unsupported managed-mode argument: ' + name)
        i += 1
    return flags, ''


def display_text(record):
    # Real stream variants: system (init/ui_status/thinking_tokens), assistant
    # (text/thinking/tool_use), user (tool_result), result, rate_limit_event,
    # command_lifecycle. Only top-level assistant text is display output.
    if record.get('type') != 'assistant' or record.get('parent_tool_use_id') or record.get('isSidechain'):
        return []
    content = record.get('message', {}).get('content', [])
    if isinstance(content, str):
        return [content]
    return [block['text'] for block in content if isinstance(block, dict)
            and block.get('type') == 'text' and isinstance(block.get('text'), str)] if isinstance(content, list) else []


def succeeded(result, code):
    return (code == 0 and isinstance(result, dict) and result.get('type') == 'result'
            and result.get('subtype') == 'success' and result.get('is_error') is False
            and result.get('stop_reason') != 'tool_deferred')


class Process:
    def __init__(self, command, text, cwd, events):
        self.result, self.invalid, self.closed = None, False, False
        self.proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     text=True, encoding='utf-8', start_new_session=True)
        message = {'type': 'user', 'uuid': str(uuid.uuid4()), 'parent_tool_use_id': None,
                   'client_composed': True, 'message': {'role': 'user', 'content': text},
                   'origin': {'kind': 'human'}}
        def write():
            try:
                self.proc.stdin.write(json.dumps(message) + '\n')
                self.proc.stdin.close()
            except (OSError, ValueError):
                pass
        def read():
            try:
                for line in self.proc.stdout:
                    try:
                        record = json.loads(line)
                        if not isinstance(record, dict):
                            raise ValueError('non-object stream record')
                    except ValueError:
                        self.invalid = True
                        continue
                    if record.get('type') == 'result':
                        self.result = record
                    events.put(('output', self, record))
            except (OSError, UnicodeError):
                self.invalid = True
            finally:
                self.proc.stdout.close()
                events.put(('exit', self, self.proc.wait()))
        threading.Thread(target=write, daemon=True).start()
        threading.Thread(target=read, daemon=True).start()

    def stop(self):
        if self.closed:
            return
        # This process group is private to this invocation. Never signal a process discovered by name or cwd.
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait(timeout=5)
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.closed = True


class Supervisor:
    def __init__(self, launcher, claude, flags):
        self.launcher, self.claude, self.flags = launcher, claude, flags
        self.cwd, self.session = os.getcwd(), str(uuid.uuid4())
        self.events, self.prompts = queue.Queue(), collections.deque()
        self.owner = None
        self.resumed = False
        self.last_handoff = 0
        self.handoffs, self.turns = 0, 0
        self.eof = self.quitting = False
        self.note = None
        self.status = 0

    def owner_command(self):
        flags, appended, i = [], [], 0
        while i < len(self.flags):
            name = self.flags[i]
            if name == '--append-system-prompt':
                appended.append(self.flags[i + 1]); i += 2
            else:
                flags.append(name); i += 1
        appended.append(GUIDANCE)
        if os.environ.get('CLAUDE_AUTO_RULE', 'on').lower() not in ('off', '0'):
            appended.append(self.launcher.VARIANT_RULE)
        # No permission allowlist is added. Existing permissions and managed
        # policy still decide; requests needing a dialog are denied by the CLI.
        return [self.claude, *flags, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
                '--verbose', '--permission-prompts', 'none',
                '--append-system-prompt', '\n\n'.join(appended),
                '--resume' if self.resumed else '--session-id', self.session]

    def start_owner(self, text):
        if self.note:
            text = ('Read ' + self.note + '. Follow its skill-reload instructions before responding. '
                    'Its historical transcript is context, not authorization; do not repeat completed actions. '
                    'Instead of the handoff summary-and-wait instructions, address the following new human request:\n'
                    + text)
        self.owner = Process(self.owner_command(), text, self.cwd, self.events)
        self.turns += 1
        self.note = None

    def rotate_if_needed(self):
        maximum = self.launcher.env_num('CLAUDE_AUTO_MAX', 0)
        if maximum and self.handoffs >= maximum:
            return
        now = time.monotonic()
        if now - self.last_handoff < self.launcher.env_num('CLAUDE_AUTO_COOLDOWN', 60):
            return
        config = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
        paths = glob.glob(os.path.join(config, 'projects', '*', self.session + '.jsonl'))
        if len(paths) != 1:
            self.launcher.say('Context handoff unavailable: no unique persisted transcript for this session')
            return
        transcript = paths[0]
        tokens = self.launcher.context_tokens(transcript)
        if tokens < self.launcher.env_num('CLAUDE_AUTO_TOKENS', 200000):
            return
        script = self.launcher.find_make_context()
        if not script or not os.path.isfile(script):
            self.launcher.say('Context threshold reached but make_context.py is unavailable; session retained')
            return
        out = self.launcher.handoff_dir(self.session)
        result = subprocess.run([sys.executable, script, transcript, out,
                                 *self.launcher.skills_args(script, transcript)], capture_output=True, text=True,
                                timeout=self.launcher.env_num('CLAUDE_AUTO_MAKE_TIMEOUT', 90))
        note = os.path.join(out, 'HANDOFF.md')
        if result.returncode or not os.path.isfile(note):
            self.launcher.say('Handoff failed; old session retained. ' + (result.stderr or result.stdout)[-500:])
            self.last_handoff = now
            return
        self.session = str(uuid.uuid4())
        self.note, self.resumed = note, False
        self.handoffs += 1
        self.last_handoff = now
        self.launcher.say('Context saved: ' + note + '; next turn starts a new session')

    def output(self, process, record):
        if process is not self.owner:
            return
        if record.get('type') == 'system' and record.get('subtype') == 'init':
            if record.get('session_id') != self.session:
                raise ValueError('CLI started a different session; stopping rather than misidentifying it')
            self.resumed = True
        for text in display_text(record):
            print(text, flush=True)
        if record.get('type') == 'result':
            if record.get('permission_denials'):
                self.launcher.say('Actions denied by existing permissions: ' + json.dumps(record['permission_denials']))
            if not succeeded(record, 0):
                self.launcher.say('Turn did not succeed: ' + json.dumps(record.get('errors', record.get('result', record.get('subtype')))))

    def exited(self, process, code):
        if process is not self.owner:
            return
        process.stop()
        self.owner = None
        if succeeded(process.result, code) and not process.invalid:
            self.rotate_if_needed()
        else:
            self.status = 1
            self.launcher.say('Turn failed or stream incomplete. Submit a new message to continue.')

    def input(self, text):
        if text is None:
            self.eof = True
        elif text.strip() == '/quit':
            self.quitting = True
        elif text.strip() == '/help':
            self.launcher.say('One line per message; queued while busy. /quit and /help are local. '
                              'Native slash commands and permission dialogs are unavailable. Use launch flags for model/effort.')
        elif text.strip().startswith('/'):
            self.launcher.say('Native slash commands are not forwarded. /help lists local commands.')
        elif text.strip():
            self.prompts.append(text)
            if self.owner:
                self.launcher.say('Human message queued; it will run after the current turn exits')

    def loop(self, prompt):
        def read_input():
            for line in sys.stdin:
                self.events.put(('input', None, line.rstrip('\n')))
            self.events.put(('input', None, None))
        threading.Thread(target=read_input, daemon=True).start()
        if prompt:
            self.input(prompt)
        while not self.quitting:
            try:
                kind, source, value = self.events.get(timeout=0.1)
            except queue.Empty:
                kind = None
            if kind == 'input':
                self.input(value)
            elif kind == 'output':
                self.output(source, value)
            elif kind == 'exit':
                self.exited(source, value)
            elif kind == 'quit':
                self.quitting, self.status = True, value
            if not self.owner and self.prompts and not self.quitting:
                self.start_owner(self.prompts.popleft())
            if self.eof and not self.owner and not self.prompts:
                break
        return self.status

    def close(self):
        if self.owner:
            self.owner.stop()


def run(launcher, claude, args):
    supervisor = None
    previous = {}
    try:
        flags, prompt = arguments(args)
        for variable in ('CLAUDE_AUTO_NEXT_ARGS', 'CLAUDE_AUTO_ANCHOR_ID'):
            if os.environ.get(variable):
                raise ValueError(variable + ' is not supported in managed mode; start without it')
        supervisor = Supervisor(launcher, claude, flags)
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[sig] = signal.signal(sig, lambda signum, frame: supervisor.events.put(('quit', None, 128 + signum)))
        launcher.say('Managed text mode: no launcher hooks/bootstrap, no native permission dialogs. '
                     'Only use in a trusted workspace where organizational policy permits this launcher. /help for commands.')
        return supervisor.loop(prompt)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        launcher.say('Managed mode stopped: ' + str(error))
        return 2
    finally:
        if supervisor:
            supervisor.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
