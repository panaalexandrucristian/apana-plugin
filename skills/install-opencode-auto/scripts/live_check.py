#!/usr/bin/env python3
"""live_check.py: opencode-auto in a real TUI, on a pseudo-terminal, against a private server and a stand-in model.

    live_check.py [--keep] [--only auto|plain] [--opencode NAME_OR_PATH]

What it does, in a throw-away folder for each of its two windows (own HOME and XDG folders: nothing of yours is read or written, and no
credentials or network beyond 127.0.0.1 are involved, so it costs nothing):
  1. starts `opencode serve` with the plugin folder linked into plugins/ and the `enabled` file in place, and a stand-in provider (OpenAI chat
     completions, streaming) whose reported token usage this script controls;
  2. the automatic window: starts the launcher of this repository (assets/opencode-auto) as a TUI connected to that server, on the session it
     opens; waits until the TUI has marked the session, makes the stand-in report a context over the threshold and sends a prompt; checks that
     the plugin made a handoff (`next` on the old session, a note, a new session), that the SAME TUI process then shows the new session on
     screen with the toast, that the old session was archived and the new one was not, and that no second handoff happened;
  3. the plain window: starts a plain `opencode` (no variable) on a session that already carries the mark, as the new session of a chain or one
     marked by an earlier automatic window does; checks that the TUI took the mark off and that a context over the threshold then makes no
     handoff (a plain window cannot follow one, and the old session would refuse every tool call).

It starts processes and uses a terminal of 45x160, so it is not part of `npm test`; run it after a change to the TUI part or to the launcher.
Exit codes: 0 every check passed, 1 a check failed, 2 it could not run (no opencode, not 2.3.x, no free port, the server did not start).
"""
import argparse, base64, fcntl, json, os, pty, re, select, shutil, signal, socket, struct, subprocess, sys, tempfile, termios, threading, time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
LAUNCHER = os.path.join(HERE, "..", "assets", "opencode-auto")
PASSWORD = "live-check"
THRESHOLD = 60000          # the mark; the stand-in's model has a window of 100000, so OpenCode's own ceiling is 84000
OVER = 70000

failures = []


def say(tag, msg):
    print("%-5s %s" % (tag, msg), flush=True)


def check(ok, what, detail=""):
    say("ok" if ok else "FAIL", what + ("" if ok or not detail else ": " + detail))
    if not ok:
        failures.append(what)
    return ok


class StandIn(ThreadingHTTPServer):
    """A model provider that answers every request with `stub reply #n` and reports the usage it is told to."""
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), self.Handler)
        self.usage = {"prompt": 1, "completion": 1}
        self.count = 0
        self.requests = []          # (n, text of the user messages, offered tools)
        self.lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            server = self.server
            with server.lock:
                server.count += 1
                n, usage = server.count, dict(server.usage)
                users = " ".join(str(part.get("text", "")) if isinstance(part, dict) else str(part)
                                 for m in body.get("messages", []) if m.get("role") == "user"
                                 for part in (m["content"] if isinstance(m.get("content"), list) else [m.get("content")]))
                server.requests.append((n, users, bool(body.get("tools"))))
            chunk = lambda delta, finish=None: {"id": "stub-%d" % n, "object": "chat.completion.chunk", "created": 0, "model": body.get("model", "m"),
                                                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            usage_chunk = {"id": "stub-%d" % n, "object": "chat.completion.chunk", "created": 0, "model": body.get("model", "m"), "choices": [],
                           "usage": {"prompt_tokens": usage["prompt"], "completion_tokens": usage["completion"], "total_tokens": usage["prompt"] + usage["completion"]}}
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            for part in (chunk({"role": "assistant", "content": "stub reply #%d" % n}), chunk({}, "stop"), usage_chunk):
                self.wfile.write(("data: %s\n\n" % json.dumps(part)).encode())
            self.wfile.write(b"data: [DONE]\n\n")


class Terminal:
    """A command on a pseudo-terminal; everything it prints is kept, with the escape sequences taken out."""
    def __init__(self, argv, env, cwd):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
        self.raw = bytearray()
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while True:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.2)
                if not ready:
                    continue
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if not data:
                return
            with self.lock:
                self.raw += data

    def text(self):
        with self.lock:
            text = bytes(self.raw).decode("latin-1")
        text = re.sub(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]", " ", text)
        text = re.sub(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", " ", text)
        text = re.sub(r"\x1b[()][0-9A-Za-z]", " ", text)
        return re.sub(r"[\x00-\x08\x0b-\x1f]", " ", text)

    def alive(self):
        try:
            done, _ = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            return False
        return done == 0

    def kill(self):
        for target in (lambda: os.killpg(self.pid, signal.SIGKILL), lambda: os.kill(self.pid, signal.SIGKILL)):
            try:
                target()
            except (ProcessLookupError, PermissionError):
                pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass


def until(read, ok, seconds, step=0.4):
    end = time.time() + seconds
    value = read()
    while not ok(value) and time.time() < end:
        time.sleep(step)
        value = read()
    return value


class Rig:
    """A private server in its own throw-away folder, with the plugin linked in, the `enabled` file and a stand-in provider."""
    def __init__(self, binary, name):
        self.root = tempfile.mkdtemp(prefix="apana-live-%s-" % name)
        for folder in ("config/opencode/plugins", "data", "cache", "state/opencode/apana/auto", "tmp", "ws", "home"):
            os.makedirs(self.sub(*folder.split("/")), exist_ok=True)
        os.symlink(os.path.join(REPO, "opencode-auto"), self.sub("config", "opencode", "plugins", "apana-auto"))
        open(self.sub("state", "opencode", "apana", "auto", "enabled"), "w").close()
        self.stand_in = StandIn()
        threading.Thread(target=self.stand_in.serve_forever, daemon=True).start()
        config = {
            "provider": {"stub": {"npm": "@ai-sdk/openai-compatible", "name": "Stub", "options": {"baseURL": "http://127.0.0.1:%d/v1" % self.stand_in.server_address[1], "apiKey": "stub"},
                                  "models": {"m": {"name": "m", "tool_call": True, "limit": {"context": 100000, "output": 4000}}}}},
            "model": "stub/m", "small_model": "stub/m", "autoupdate": False, "share": "disabled",
        }
        with open(self.sub("config", "opencode", "opencode.jsonc"), "w") as f:
            json.dump(config, f)
        self.env = {"PATH": os.environ["PATH"], "HOME": self.sub("home"), "XDG_CONFIG_HOME": self.sub("config"), "XDG_DATA_HOME": self.sub("data"), "XDG_CACHE_HOME": self.sub("cache"),
                    "XDG_STATE_HOME": self.sub("state"), "TMPDIR": self.sub("tmp"), "OPENCODE_SERVER_PASSWORD": PASSWORD}
        with socket.socket() as probe:   # a port the system says is free now, not one worked out from the pid
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.server = subprocess.Popen([binary, "serve", "--hostname", "127.0.0.1", "--port", str(port), "--print-logs"], cwd=self.sub("ws"), env=self.env,
                                       stdout=open(self.sub("server.log"), "wb"), stderr=subprocess.STDOUT, start_new_session=True)
        self.terminal = None
        self.base = "http://127.0.0.1:%d" % port
        self.headers = {"authorization": "Basic " + base64.b64encode(("opencode:" + PASSWORD).encode()).decode(), "content-type": "application/json", "x-opencode-directory": self.sub("ws")}

    def sub(self, *names):
        return os.path.join(self.root, *names)

    def api(self, method, path, body=None):
        request = urllib.request.Request(self.base + path, method=method, headers=self.headers, data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request, timeout=30) as res:
                return json.loads(res.read() or b"null")
        except Exception:
            return None

    def session(self, sid):
        return ((self.api("GET", "/api/session/" + sid) or {}).get("data")) or {}

    def up(self):
        return bool(until(lambda: self.api("GET", "/api/command"), lambda v: v is not None, 30))

    def first_turn(self, metadata=None):
        """A session with one finished turn (the title request and the reply), as a session the user comes back to has."""
        body = {"title": "live", "location": {"directory": self.sub("ws")}}
        if metadata is not None:
            body["metadata"] = metadata
        sid = self.api("POST", "/api/session", body)["data"]["id"]
        self.api("POST", "/api/session/%s/prompt" % sid, {"text": "hi"})
        until(lambda: self.stand_in.count, lambda n: n >= 1, 30)
        time.sleep(3)
        say("info", "private server up on %s, session %s created" % (self.base, sid))
        return sid

    def tui_env(self, **extra):
        return dict(self.env, TERM="xterm-256color", COLORTERM="truecolor", **extra)

    def notes(self):
        folder = self.sub("data", "opencode", "apana", "handoffs", "auto")
        return os.listdir(folder) if os.path.isdir(folder) else []

    def auto_log(self):
        path = self.sub("state", "opencode", "apana", "auto", "auto.log")
        return open(path).read() if os.path.isfile(path) else ""

    def show_failure(self):
        say("info", "end of the TUI screen: " + " ".join(self.terminal.text()[-800:].split()))
        with open(self.sub("server.log"), errors="replace") as log:
            say("info", "end of the server log: " + " | ".join(line[-200:] for line in log.read().splitlines()[-4:]))

    def close(self, keep):
        if self.terminal:
            self.terminal.kill()
        try:
            os.killpg(self.server.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.server.wait()
        self.stand_in.shutdown()
        if keep:
            say("info", "kept %s" % self.root)
        else:
            shutil.rmtree(self.root, ignore_errors=True)


def auto_window(rig):
    """The launcher's window marks the session it opens, hands it off over the threshold and moves to the new session."""
    old = rig.first_turn()
    tui_env = rig.tui_env(APANA_OPENCODE_AUTO_TOKENS=str(THRESHOLD), APANA_OPENCODE_AUTO_COOLDOWN="0", APANA_OPENCODE_AUTO_MAX="1")
    rig.terminal = terminal = Terminal(["/bin/sh", LAUNCHER, "--server", rig.base, "--session", old, rig.sub("ws")], tui_env, rig.sub("ws"))
    tui_pid = terminal.pid
    marked = until(lambda: rig.session(old).get("metadata", {}).get("apana", {}).get("auto"), bool, 30)
    if not check(bool(marked), "the TUI marked the session it opened", str(rig.session(old).get("metadata"))):
        rig.show_failure()
    check(bool(marked) and marked.get("tokens") == THRESHOLD, "the mark carries the settings of the launcher", str(marked))

    rig.stand_in.usage = {"prompt": OVER, "completion": 10}
    before = len(terminal.text())
    rig.api("POST", "/api/session/%s/prompt" % old, {"text": "go on"})
    next_id = until(lambda: rig.session(old).get("metadata", {}).get("apana", {}).get("next"), bool, 90)
    if not check(bool(next_id), "the old session got `next` after the context went over the threshold", str(rig.session(old).get("metadata"))):
        return
    folders = rig.notes()
    check(len(folders) == 1 and os.path.isfile(rig.sub("data", "opencode", "apana", "handoffs", "auto", folders[0], "HANDOFF.md")), "one handoff note was written", str(folders))
    made = rig.session(next_id)
    check(made.get("metadata", {}).get("apana", {}).get("auto", {}).get("chain") == 1, "the new session carries the mark, one handoff down the chain")

    told = until(lambda: [n for n, users, tools in list(rig.stand_in.requests) if tools and "HANDOFF.md" in users and "oprită automat" in users], bool, 60)   # the agent's own request, not the title
    check(bool(told), "the new session was told to read the note and to continue")
    reply = lambda t: bool(told) and re.search(r"stub\s+reply\s+#%d\b" % told[0], t)
    screen = until(lambda: terminal.text()[before:], lambda t: reply(t) and "moved to the new session" in t, 60)
    check(bool(reply(screen)), "the TUI shows the reply of the new session", "reply #%s not on screen" % (told[0] if told else "?"))
    check("moved to the new session" in screen, "the toast says the window moved")
    check(terminal.alive(), "it is the same TUI process (pid %d still running)" % tui_pid)
    archived = until(lambda: rig.session(old).get("time", {}).get("archived"), bool, 30)
    check(bool(archived), "the old session was archived, after the window moved", str(rig.session(old).get("time")))
    check(not rig.session(next_id).get("time", {}).get("archived"), "the new session is not archived")
    time.sleep(4)
    log = rig.auto_log()
    check(len(re.findall(r"handoff \((step|tool)\)", log)) == 1, "exactly one handoff happened", " | ".join(log.splitlines())[-1800:])


def plain_window(rig):
    """A plain `opencode` on a session that carries the mark takes the mark off, so that no handoff leaves this window behind."""
    old = rig.first_turn(metadata={"keep": 1, "apana": {"other": True, "auto": {"tokens": THRESHOLD, "cooldown": 0, "max": 3, "chain": 2}}})
    rig.terminal = terminal = Terminal([BINARY, "--server", rig.base, "--session", old, rig.sub("ws")], rig.tui_env(), rig.sub("ws"))
    metadata = until(lambda: rig.session(old).get("metadata", {}), lambda m: "auto" not in m.get("apana", {}), 30)
    if not check("auto" not in metadata.get("apana", {}), "the plain TUI took the mark off the session it opened", str(metadata)):
        rig.show_failure()
    check(metadata.get("keep") == 1 and metadata.get("apana", {}).get("other") is True, "and kept the rest of the metadata", str(metadata))

    rig.stand_in.usage = {"prompt": OVER, "completion": 10}
    count = rig.stand_in.count
    rig.api("POST", "/api/session/%s/prompt" % old, {"text": "go on"})
    until(lambda: rig.stand_in.count, lambda n: n > count, 30)
    time.sleep(8)   # a handoff takes about 3 s from the end of the step
    meta = rig.session(old).get("metadata", {})
    check("next" not in meta.get("apana", {}), "no handoff over the threshold: the old session has no `next`", str(meta))
    check(rig.notes() == [] and "handoff (" not in rig.auto_log(), "no note was written and the log has no handoff", " | ".join(rig.auto_log().splitlines())[-600:])
    check(not rig.session(old).get("time", {}).get("archived"), "the session the window shows is not archived")
    check(terminal.alive(), "the plain TUI is still running")


BINARY = None


def main():
    global BINARY
    ap = argparse.ArgumentParser(description="Run opencode-auto in a real TUI against a private server and a stand-in model.")
    ap.add_argument("--opencode", default=os.environ.get("APANA_OPENCODE", "opencode"), help="the opencode binary (default: opencode on PATH)")
    ap.add_argument("--keep", action="store_true", help="keep the throw-away folders and print their paths")
    ap.add_argument("--only", choices=("auto", "plain"), help="run one window only")
    args = ap.parse_args()

    BINARY = shutil.which(args.opencode)
    if not BINARY:
        say("fail", "`%s` is not on PATH" % args.opencode)
        return 2
    found = re.search(r"(\d+)\.(\d+)\.(\d+)", subprocess.run([BINARY, "--version"], capture_output=True, text=True, timeout=60).stdout)
    if not found or (int(found.group(1)), int(found.group(2))) != (2, 3):
        say("fail", "written for OpenCode 2.3.x, found %s" % (found.group(0) if found else "no version"))
        return 2

    for name, scenario in (("auto", auto_window), ("plain", plain_window)):
        if args.only and args.only != name:
            continue
        say("info", "-- the %s window" % ("automatic" if name == "auto" else "plain"))
        rig = Rig(BINARY, name)
        try:
            if not rig.up():
                say("fail", "the server did not start (see %s)" % rig.sub("server.log"))
                rig.close(keep=True)
                return 2
            scenario(rig)
        finally:
            rig.close(args.keep)
    print()
    say("done" if not failures else "FAILED", "%d check(s) failed: %s" % (len(failures), "; ".join(failures)) if failures else "every check passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
