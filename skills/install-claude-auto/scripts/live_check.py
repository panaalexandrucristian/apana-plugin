#!/usr/bin/env python3
"""Live checks of claude-auto with a REAL `claude --model haiku` in a pty.   live_check.py [SCENARIO ...] [--auto PATH]
Every scenario prints its observations and one PASS/FAIL line per check; exit 0 only if all checks pass."""
import fcntl, glob, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, tempfile, termios, time

SCRATCH = os.path.dirname(os.path.abspath(__file__))
CWD = os.path.join(os.path.expanduser("~"), ".claude")      # an already trusted folder
PROJ = os.path.join(CWD, "projects", re.sub(r"[^A-Za-z0-9]", "-", CWD))   # Claude Code names the project folder after its path
LIVE = os.path.join(CWD, "lt-live")               # test files live inside the project, so Read needs no permission
REAL_CLAUDE = shutil.which("claude")


class Live:
    def __init__(self, auto, name, args, env=None, cwd=CWD, tokens="1"):
        os.makedirs(LIVE, exist_ok=True)
        self.name, self.cwd = name, cwd
        self.base = tempfile.mkdtemp(prefix=name + "-", dir=LIVE)
        e = dict(os.environ, CLAUDE_AUTO_DIR=self.base, CLAUDE_AUTO_TOKENS=tokens, TERM="xterm-256color",
                 CLAUDE_AUTO_DEBUG="1", CLAUDE_AUTO_COOLDOWN="0")
        for k in [k for k in e if k.startswith("CLAUDE") and not k.startswith("CLAUDE_AUTO_")]:
            e.pop(k)                               # markers of the session this runs in; a real terminal has none
        e.pop("CLAUDE_AUTO_RUN", None)
        e.update(env or {})
        self.before = set(os.listdir(PROJ))
        self.t0, self.buf, self.status, self.notes = time.time(), b"", None, {}
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execve(sys.executable, [sys.executable, "-I", auto] + args, e)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
        self.raw = open(os.path.join(self.base, "raw.bin"), "wb")

    # -- terminal
    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if select.select([self.fd], [], [], 0.2)[0]:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError:
                    return False
                if not chunk:
                    return False
                self.buf += chunk
                self.raw.write(chunk)
                self.raw.flush()
        return True

    def wait_for(self, pattern, timeout, start=0):
        end = time.time() + timeout
        while time.time() < end:
            m = re.search(pattern, self.buf[start:])
            if m:
                return start + m.end()
            if not self.pump(0.5):
                break
        m = re.search(pattern, self.buf[start:])          # the process may have ended right after writing what we wait for
        return start + m.end() if m else None

    def idle(self, quiet, timeout):
        end, last, since = time.time() + timeout, len(self.buf), time.time()
        while time.time() < end:
            self.pump(0.5)
            if len(self.buf) != last:
                last, since = len(self.buf), time.time()
            elif time.time() - since >= quiet:
                return True
        return False

    def alive(self):
        if self.status is not None:
            return False
        r = os.waitpid(self.pid, os.WNOHANG)
        if r != (0, 0):
            self.status = r[1]
            return False
        return True

    def start(self):
        ok = self.idle(4, 90)
        if re.search(rb"Quick.?safety.?check", self.buf, re.I):
            raise SystemExit("trust prompt: not typing anything")
        return ok

    def send(self, text):
        os.write(self.fd, text.encode())
        time.sleep(1)
        os.write(self.fd, b"\r")

    def exit_text(self):
        s = self.status
        return None if s is None else (os.WEXITSTATUS(s) if os.WIFEXITED(s) else "signal %d" % os.WTERMSIG(s))

    def stop(self, sig=signal.SIGTERM, wait=15):
        if self.alive():
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                pass
            for _ in range(int(wait * 4)):
                self.pump(0.25)
                if not self.alive():
                    break
        if self.alive():
            os.kill(self.pid, signal.SIGKILL)
            time.sleep(0.5)
            self.alive()
        return self.exit_text()

    # -- processes and files
    def children(self):
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
        rows = [l.split(None, 2) for l in out.splitlines() if l.strip()]
        return [(int(p), int(pp), c) for p, pp, c in rows if int(pp) == self.pid]

    def handoff_dirs(self):
        return sorted(d for d in glob.glob(os.path.join(self.base, "*")) if os.path.isfile(os.path.join(d, "HANDOFF.md")))

    def pending_text(self, d):
        text = ""
        for root, _, files in sorted(os.walk(d)):
            for f in sorted(files):
                if f.startswith("pending"):
                    text += open(os.path.join(root, f), errors="replace").read()
        return text

    def auto_log(self):
        p = os.path.join(self.base, "auto.log")
        return open(p).read() if os.path.exists(p) else ""

    def new_transcripts(self):
        return [os.path.join(PROJ, f) for f in sorted(set(os.listdir(PROJ)) - self.before) if f.endswith(".jsonl")]

    def cleanup(self):
        self.stop(wait=5)
        for f in set(os.listdir(PROJ)) - self.before:
            p = os.path.join(PROJ, f)
            shutil.rmtree(p, True) if os.path.isdir(p) else os.remove(p)


def turn(live, text, quiet=8, timeout=150):
    """One ordinary turn: type the prompt, wait until the screen has been quiet for `quiet` seconds."""
    live.send(text)
    live.pump(3)
    return live.idle(quiet, timeout)


def banner(live, timeout):
    return live.wait_for(rb"\[claude-auto\]", timeout, 0)


def check(results, name, ok, detail=""):
    results.append((name, bool(ok)))
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, ("   " + str(detail)[:300]) if detail else ""))


def read_in_transcripts(live, needle):
    """Transcripts created by this run that contain `needle`."""
    return [p for p in live.new_transcripts() if needle in open(p, errors="replace").read()]


def tool_results_after_read(path, name_part):
    """Read-tool results in a transcript for file_paths containing name_part: list of (file_path, result text)."""
    uses, out = {}, []
    for line in open(path, errors="replace"):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        c = (o.get("message") or {}).get("content")
        if not isinstance(c, list):
            continue
        for it in c:
            if not isinstance(it, dict):
                continue
            if it.get("type") == "tool_use" and it.get("name") == "Read":
                fp = (it.get("input") or {}).get("file_path") or ""
                if name_part in fp:
                    uses[it["id"]] = fp
            elif it.get("type") == "tool_result" and it.get("tool_use_id") in uses:
                body = it.get("content")
                if isinstance(body, list):
                    body = " ".join(b.get("text", "") for b in body if isinstance(b, dict))
                out.append((uses[it["tool_use_id"]], str(body)))
    return out


# ----------------------------------------------------------------------------------------------- scenarios

def s_trunc(auto):
    """finding 1: a big tool result must reach the pending files whole, and the new session must be able to read them."""
    big = os.path.join(LIVE, "big.txt")
    os.makedirs(LIVE, exist_ok=True)
    with open(big, "w") as f:
        for i in range(1000):
            f.write("line-%04d the quick brown fox jumps over the lazy dog 0123456789\n" % i)
        f.write("END-MARKER-7f3a9c\n")
    L, R = Live(auto, "trunc", ["--model", "haiku"], env={"CLAUDE_AUTO_MAX": "1", "BASH_MAX_OUTPUT_LENGTH": "150000"}), []
    try:
        L.start()
        L.send("Run exactly `cat %s` with the Bash tool. Then write the single word done." % big)
        b = banner(L, 240)
        check(R, "handoff happened (banner seen)", b)
        d = L.handoff_dirs()
        pend = L.pending_text(d[0]) if d else ""
        check(R, "pending data holds the END marker of the big result", "END-MARKER-7f3a9c" in pend, "pending chars: %d" % len(pend))
        if b:
            L.pump(60)
            L.idle(8, 120)
            ts = read_in_transcripts(L, "oprită automat")
            reads = [r for t in ts for r in tool_results_after_read(t, "pending")]
            bad = [r for r in reads if re.search(r"exceeds|truncated|too large|maximum", r[1][:300], re.I)]
            check(R, "new session read a pending file", len(reads) > 0, [os.path.basename(r[0]) for r in reads])
            check(R, "no pending read failed on size/truncation", len(reads) > 0 and not bad, [r[1][:120] for r in bad])
    finally:
        L.cleanup()
        os.remove(big)
    return R


def s_parallel(auto):
    """findings 2 and 4: two tool calls in one turn -> two concurrent hooks; one handoff, both results saved."""
    L, R = Live(auto, "parallel", ["--model", "haiku", "--allowedTools", "Bash(echo PAR-ONE-111)", "Bash(echo PAR-TWO-222)"],
                env={"CLAUDE_AUTO_MAX": "1"}), []
    try:
        L.start()
        L.send("In ONE single message, call the Bash tool twice IN PARALLEL: first `echo PAR-ONE-111`, second `echo PAR-TWO-222`. "
               "Then write the single word done.")
        b = banner(L, 240)
        check(R, "handoff happened (banner seen)", b)
        d = L.handoff_dirs()
        pend = L.pending_text(d[0]) if d else ""
        log = L.auto_log()
        L.notes["handoffs_in_log"] = len(re.findall(r"handoff /", log))
        check(R, "exactly one handoff", len(d) == 1, d)
        check(R, "pending data holds result ONE", "PAR-ONE-111" in pend)
        check(R, "pending data holds result TWO", "PAR-TWO-222" in pend, "(fails if the two hooks did not run together)")
    finally:
        L.cleanup()
    return R


def s_dashdash(auto):
    """finding 5: tokens after -- are prompt text, never flags: not carried into the follow-up session."""
    L, R = Live(auto, "dashdash", ["--model", "haiku", "--", "--dangerously-skip-permissions"], env={"CLAUDE_AUTO_MAX": "1"}), []
    try:
        L.start()
        L.idle(8, 120)                      # the first turn answers the literal prompt
        L.send("Reply with the single word ok. Do not use any tools.")
        b = banner(L, 240)
        check(R, "handoff happened (wrapped, banner seen)", b, "(fails if the whole run was passed through)")
        if b:
            L.pump(6)
            cmds = [c for _, _, c in L.children()]
            L.notes["follow_up_commands"] = [c[:200] for c in cmds]
            check(R, "follow-up claude exists", any("claude" in c for c in cmds))
            check(R, "follow-up has no --dangerously-skip-permissions", not any("--dangerously-skip-permissions" in c for c in cmds))
    finally:
        L.cleanup()
    return R


def s_kill9(auto):
    """finding 9: claude killed with SIGKILL cannot reset the terminal; the wrapper must."""
    L, R = Live(auto, "kill9", ["--model", "haiku"], tokens="100000000"), []
    try:
        L.start()
        kids = [p for p, _, c in L.children() if "claude" in c]
        check(R, "claude child found", kids, kids)
        mark = len(L.buf)
        if kids:
            os.kill(kids[0], signal.SIGKILL)
            for _ in range(40):
                L.pump(0.25)
                if not L.alive():
                    break
        tail = L.buf[mark:]
        L.notes["wrapper_exit"] = L.exit_text()
        check(R, "wrapper exited", L.status is not None, L.notes["wrapper_exit"])
        check(R, "terminal reset sequences written after the kill", b"\x1b[?25h" in tail and b"\x1b[?2004l" in tail,
              tail[-80:])
    finally:
        L.cleanup()
    return R


def s_bg(auto):
    """finding 6: a background process started by the session must not outlive the forced end of the session."""
    marker = "987654"
    L, R = Live(auto, "bg", ["--model", "haiku", "--allowedTools", "Bash(sleep *)"], env={"CLAUDE_AUTO_MAX": "1"}), []
    try:
        L.start()
        L.send("Use the Bash tool with run_in_background set to true to run exactly `sleep %s`. Then write the single word done." % marker)
        b = banner(L, 240)
        check(R, "handoff happened (banner seen)", b)
        time.sleep(4)
        left = subprocess.run(["pgrep", "-f", "sleep %s" % marker], capture_output=True, text=True).stdout.split()
        L.notes["sleep_pids_left"] = left
        check(R, "no `sleep %s` left running" % marker, not left, left)
    finally:
        subprocess.run(["pkill", "-f", "sleep %s" % marker])
        L.cleanup()
    return R


def s_sigterm(auto):
    """finding 3 (real-claude path): SIGTERM to the wrapper during a running tool ends everything, quickly, with 143."""
    L, R = Live(auto, "sigterm", ["--model", "haiku", "--allowedTools", "Bash(sleep 60)"], tokens="100000000"), []
    try:
        L.start()
        L.send("Run exactly `sleep 60` with the Bash tool. Then write the single word done.")
        L.pump(25)
        t = time.time()
        st = L.stop(signal.SIGTERM, wait=20)
        took = time.time() - t
        L.notes.update(exit=st, seconds=round(took, 1))
        check(R, "wrapper ended within 12 s", L.status is not None and took < 12, "%.1fs" % took)
        check(R, "exit status 143", st == 143, st)
        left = [c for _, _, c in L.children()]
        check(R, "no claude child left", not left, left)
    finally:
        L.cleanup()
    return R


def s_chain(auto):
    """findings 7 and 8: two handoffs in a row; the second keeps the first as its parent; folders are unique and named handoff-*."""
    L, R = Live(auto, "chain", ["--model", "haiku", "--allowedTools", "Bash(echo chain-one)"], env={"CLAUDE_AUTO_MAX": "2"}), []
    try:
        L.start()
        L.send("Run exactly `echo chain-one` with the Bash tool. Then write the single word done.")
        first = banner(L, 240)
        check(R, "first handoff", first)
        second = L.wait_for(rb"\[claude-auto\]", 300, first or 0)
        check(R, "second handoff", second)
        d = L.handoff_dirs()
        L.notes["folders"] = [os.path.basename(x) for x in d]
        check(R, "two distinct handoff folders", len(d) == 2, L.notes["folders"])
        check(R, "folders are named handoff-<8 hex>-<date>-*", all(re.match(r"handoff-[0-9a-f]{8}-\d{8}-", os.path.basename(x)) for x in d))
        check(R, "second handoff holds the first as parent", len(d) == 2 and os.path.isfile(os.path.join(d[-1], "parents", "HANDOFF.md")) or
              len(d) == 2 and bool(glob.glob(os.path.join(d[-1], "parents", "*"))), os.listdir(d[-1]) if d else None)
    finally:
        L.cleanup()
    return R


def s_stop(auto):
    """declared gap: the Stop path, interactive. A plain answer without tools -> Stop hook -> handoff -> new session."""
    L, R = Live(auto, "stop", ["--model", "haiku"], env={"CLAUDE_AUTO_MAX": "1"}), []
    try:
        L.start()
        turn(L, "Reply with the single word hello. Do not use any tools.")
        L.send("Reply with the single word ok. Do not use any tools.")
        b = banner(L, 240)
        check(R, "handoff happened on the Stop event (banner seen)", b)
        d = L.handoff_dirs()
        check(R, "HANDOFF.md written", len(d) == 1, d)
        pend = L.pending_text(d[0]) if d else ""
        check(R, "last reply saved as pending data", "ok" in pend.lower(), pend[:200])
        if b:
            L.pump(40)
            L.idle(8, 90)
            check(R, "second session got the handoff prompt", bool(read_in_transcripts(L, "oprită automat")))
    finally:
        L.cleanup()
    return R


def s_nextargs(auto):
    """UNVERIFIED item (a): CLAUDE_AUTO_NEXT_ARGS with a variadic option must not swallow the generated prompt."""
    L, R = Live(auto, "nextargs", ["--model", "haiku"],
                env={"CLAUDE_AUTO_MAX": "1", "CLAUDE_AUTO_NEXT_ARGS": "--model haiku --allowedTools Read"}), []
    try:
        L.start()
        turn(L, "Reply with the single word hello. Do not use any tools.")
        L.send("Reply with the single word ok. Do not use any tools.")
        b = banner(L, 240)
        check(R, "handoff happened", b)
        if b:
            L.pump(40)
            L.idle(8, 90)
            check(R, "second session got the handoff prompt (not swallowed by --allowedTools)", bool(read_in_transcripts(L, "oprită automat")))
    finally:
        L.cleanup()
    return R


def s_settings(auto):
    """UNVERIFIED item (b): a user --settings must not silence the wrapper's hooks, and the user's own hooks must keep firing."""
    os.makedirs(LIVE, exist_ok=True)
    mark = os.path.join(LIVE, "user-hook-fired")
    if os.path.exists(mark):
        os.remove(mark)
    us = os.path.join(LIVE, "user-settings.json")
    json.dump({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "touch " + mark}]}]}}, open(us, "w"))
    L, R = Live(auto, "settings", ["--model", "haiku", "--settings", us], env={"CLAUDE_AUTO_MAX": "1"}), []
    try:
        L.start()
        turn(L, "Reply with the single word hello. Do not use any tools.")
        L.send("Reply with the single word ok. Do not use any tools.")
        b = banner(L, 200)
        check(R, "handoff happened (the wrapper's hooks fired)", b)
        check(R, "the user's own Stop hook fired too", os.path.exists(mark))
    finally:
        L.cleanup()
        for p in (mark, us):
            if os.path.exists(p):
                os.remove(p)
    return R


def s_relpath(auto):
    """finding 10: a relative CLAUDE_AUTO_CLAUDE keeps working after the follow-up changes directory."""
    d = os.path.join(LIVE, "rel")
    os.makedirs(os.path.join(d, "sub"), exist_ok=True)
    stub = os.path.join(d, "claude")
    open(stub, "w").write('#!/bin/sh\nexec %s "$@"\n' % REAL_CLAUDE)
    os.chmod(stub, 0o755)
    L, R = Live(auto, "relpath", ["--model", "haiku", "--allowedTools", "Bash(cd sub && pwd)"],
                env={"CLAUDE_AUTO_MAX": "1", "CLAUDE_AUTO_CLAUDE": "./lt-live/rel/claude"}), []
    try:
        L.start()
        L.send("Run exactly `cd %s/sub && pwd` with the Bash tool. Then write the single word done." % d)
        b = banner(L, 240)
        check(R, "handoff happened", b)
        if b:
            L.pump(12)
            text = L.buf[b:].decode("utf-8", "replace")
            check(R, "follow-up session started (no 'No such file' error)", "No such file" not in text and "not found" not in text, text[:200])
            check(R, "wrapper still running the follow-up", L.alive())
    finally:
        L.cleanup()
        shutil.rmtree(d, True)
    return R



# ---------------------------------------------------------------------------------- real claude behind a shim that ignores SIGTERM

def ps_rows():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    return [(int(a), int(b), c) for a, b, c in (l.split(None, 2) for l in out.splitlines() if len(l.split(None, 2)) == 3)]


def tree(pid):
    rows, found, todo = ps_rows(), [], [pid]
    while todo:
        cur = todo.pop()
        for p_, pp, _ in rows:
            if pp == cur:
                found.append(p_)
                todo.append(p_)
    return found


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def make_shim():
    """A parent for the real claude that ignores SIGTERM: the wrapper's SIGTERM does nothing, so only the escalation to
    SIGKILL (and the clean-up of what is left under it) can end the session. The real claude runs under it, on the tty."""
    d = os.path.join(LIVE, "shim")
    os.makedirs(d, exist_ok=True)
    p_ = os.path.join(d, "claude-shim")
    open(p_, "w").write('#!/bin/sh\ntrap "" TERM\n%s "$@" <&0 &\nwait $!\nexit $?\n' % REAL_CLAUDE)
    os.chmod(p_, 0o755)
    return p_


def s_shim_handoff(auto):
    """findings 3 + 6: a real haiku session that does not end on SIGTERM is killed, and the real claude under it goes too."""
    shim = make_shim()
    L, R, mine = Live(auto, "shimho", ["--model", "haiku"], env={"CLAUDE_AUTO_MAX": "1", "CLAUDE_AUTO_CLAUDE": shim,
                                                                  "CLAUDE_AUTO_KILL_WAIT": "2"}), [], []
    try:
        L.start()
        first = [p_ for p_, _, c in L.children()]
        old_real = [p_ for p_ in (tree(first[0]) if first else []) if "claude" in " ".join(c for q, _, c in ps_rows() if q == p_)]
        mine += first + old_real
        check(R, "first session: shim + a real claude under it", len(first) == 1 and len(old_real) >= 1, (first, old_real))
        L.send("Run exactly `echo shim-one` with the Bash tool. Then write the single word done.")
        t = time.time()
        b = banner(L, 240)
        check(R, "handoff happened (banner seen)", b)
        L.pump(10)
        L.notes["seconds_since_prompt"] = round(time.time() - t, 1)
        left = [p_ for p_ in old_real if pid_alive(p_)]
        check(R, "the first real claude is gone (two claudes would share one terminal)", not left, left)
        kids = [p_ for p_, _, _ in L.children()]
        new_real = [p_ for k in kids for p_ in tree(k)]
        mine += kids + new_real
        check(R, "the follow-up session is running", len(kids) == 1 and kids[0] not in first and new_real, (kids, new_real))
    finally:
        for p_ in mine + [q for p_ in mine for q in tree(p_)]:
            try:
                os.kill(p_, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        L.cleanup()
    return R


def s_shim_sigterm(auto):
    """finding 3: SIGTERM to the wrapper while a real haiku session (that ignores SIGTERM) runs a tool: bounded, nothing left."""
    shim = make_shim()
    L, R, mine = Live(auto, "shimterm", ["--model", "haiku"], env={"CLAUDE_AUTO_CLAUDE": shim, "CLAUDE_AUTO_KILL_WAIT": "2"},
                      tokens="100000000"), [], []
    try:
        L.start()
        L.send("Run exactly `sleep 30` with the Bash tool. Then write the single word done.")
        L.pump(15)
        first = [p_ for p_, _, _ in L.children()]
        mine += first + [q for p_ in first for q in tree(p_)]
        check(R, "a real claude with a running tool is under the shim", len(mine) >= 3, mine)
        t = time.time()
        st = L.stop(signal.SIGTERM, wait=12)
        took = time.time() - t
        L.notes.update(exit=st, seconds=round(took, 1))
        check(R, "the wrapper ended by itself within 8 s", took < 8 and st == 137, "%s after %.1fs" % (st, took))
        left = [p_ for p_ in mine if pid_alive(p_)]
        check(R, "nothing of the session is left running", not left, left)
    finally:
        for p_ in mine:
            try:
                os.kill(p_, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        L.cleanup()
    return R


def s_stalelock(auto):
    """finding 4: a stale lock of this very session sits in the run folder; four tool calls of one turn fire four hooks at once."""
    L, R = Live(auto, "stalelock", ["--model", "haiku"], env={"CLAUDE_AUTO_MAX": "1"}), []
    try:
        L.start()
        turn(L, "Reply with the single word hello. Do not use any tools.")
        sessions = [os.path.basename(t)[:-6] for t in L.new_transcripts()]
        runs = glob.glob(os.path.join(L.base, "run-*"))
        check(R, "session id and run folder known", len(sessions) == 1 and len(runs) == 1, (sessions, runs))
        if sessions and runs:
            lock = os.path.join(runs[0], "lock-" + sessions[0])
            open(lock, "w").close()
            os.utime(lock, (1, 1))                       # a hook of this session died long ago and left its lock
        L.send("In ONE single message call the Bash tool FOUR times IN PARALLEL: `echo S1`, `echo S2`, `echo S3`, `echo S4`. "
               "Then write the single word done.")
        b = banner(L, 240)
        check(R, "handoff happened (banner seen)", b)
        L.pump(3)
        log = L.auto_log()
        check(R, "exactly one handoff was made", len(re.findall(r"handoff /", log)) == 1 and len(L.handoff_dirs()) == 1,
              (len(re.findall(r"handoff /", log)), len(L.handoff_dirs())))
        pend = L.pending_text(L.handoff_dirs()[0]) if L.handoff_dirs() else ""
        L.notes["results_kept"] = [k for k in ("S1", "S2", "S3", "S4") if re.search(r"\b%s\b" % k, pend)]
    finally:
        L.cleanup()
    return R


def s_setup(auto):
    """finding 11: setup problems end cleanly with nothing left behind, and a real haiku session still works afterwards."""
    R = []
    blocker = os.path.join(LIVE, "blocker")
    os.makedirs(LIVE, exist_ok=True)
    open(blocker, "w").close()

    def run_to_end(L):
        for _ in range(60):
            L.pump(0.25)
            if not L.alive():
                break
        return L.buf.decode("utf-8", "replace")

    A = Live(auto, "setupA", ["--model", "haiku"], env={"CLAUDE_AUTO_DIR": os.path.join(blocker, "sub")})
    text = run_to_end(A)
    check(R, "unusable notes folder: stops with a message, no traceback", "nothing was started" in text and "Traceback" not in text, text[-200:])
    check(R, "unusable notes folder: no claude was started", A.exit_text() == 1 and not A.new_transcripts(), A.exit_text())
    A.cleanup()
    B = Live(auto, "setupB", ["--model", "haiku"], env={"CLAUDE_AUTO_NEXT_ARGS": "--model 'oops"})
    text = run_to_end(B)
    check(R, "invalid CLAUDE_AUTO_NEXT_ARGS: clean message, no traceback", "CLAUDE_AUTO_NEXT_ARGS" in text and "Traceback" not in text, text[-200:])
    check(R, "invalid CLAUDE_AUTO_NEXT_ARGS: exit 2, nothing started, no run folder left",
          B.exit_text() == 2 and not B.new_transcripts() and not glob.glob(os.path.join(B.base, "run-*")),
          (B.exit_text(), glob.glob(os.path.join(B.base, "run-*"))))
    B.cleanup()
    C = Live(auto, "setupC", ["--model", "haiku"], env={"CLAUDE_AUTO_MAX": "1",
                                                        "CLAUDE_AUTO_NEXT_ARGS": "--model haiku --append-system-prompt 'be brief please'"})
    try:
        C.start()
        C.send("Run exactly `echo setup-one` with the Bash tool. Then write the single word done.")
        b = banner(C, 240)
        check(R, "real haiku session with quoted NEXT_ARGS: handoff happened", b)
        if b:
            C.pump(8)
            cmds = [c for _, _, c in C.children()]
            check(R, "follow-up started with the quoted option intact",
                  any("--append-system-prompt" in c and "be brief please" in c for c in cmds), [c[:160] for c in cmds])
            C.idle(8, 90)
            check(R, "follow-up received the handoff prompt", bool(read_in_transcripts(C, "oprită automat")))
        C.stop(wait=10)
        check(R, "after the wrapper ended no run folder is left", not glob.glob(os.path.join(C.base, "run-*")),
              glob.glob(os.path.join(C.base, "run-*")))
    finally:
        C.cleanup()
        os.remove(blocker)
    return R


SCENARIOS = {k[2:]: v for k, v in globals().items() if k.startswith("s_")}

if __name__ == "__main__":
    args = sys.argv[1:]
    auto = os.path.join(CWD, "claude-auto", "claude-auto")
    if "--auto" in args:
        i = args.index("--auto")
        auto = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    names = args or list(SCENARIOS)
    failed = 0
    for n in names:
        print("=== %s  (%s)" % (n, auto))
        res = SCENARIOS[n](auto)
        failed += sum(1 for _, ok in res if not ok)
    shutil.rmtree(LIVE, True) if not os.listdir(LIVE) else None
    sys.exit(1 if failed else 0)
