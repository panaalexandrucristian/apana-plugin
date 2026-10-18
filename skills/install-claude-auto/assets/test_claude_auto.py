#!/usr/bin/env python3
"""Tests for claude-auto: python3 -W ignore -I test_claude_auto.py
Never touches ~/.claude: every run uses CLAUDE_AUTO_DIR in a temp folder, a stub make_context.py and a fake claude."""
import fcntl, importlib.machinery, importlib.util, itertools, json, os, pty, select, shutil, signal, subprocess, sys
import tempfile, textwrap, time, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "claude-auto")
PY = sys.executable


def load():
    loader = importlib.machinery.SourceFileLoader("claude_auto", SCRIPT)
    spec = importlib.util.spec_from_loader("claude_auto", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def write_script(path, body):
    with open(path, "w") as f:
        f.write("#!%s\n%s" % (PY, textwrap.dedent(body)))
    os.chmod(path, 0o755)
    return path


def transcript(path, tokens, extra=()):
    recs = [{"type": "user", "message": {"content": "hi"}}]
    if tokens is not None:
        recs.append({"type": "assistant", "message": {"usage": {
            "input_tokens": 5, "cache_read_input_tokens": max(tokens - 15, 0), "cache_creation_input_tokens": 10}}})
    recs += list(extra)
    with open(path, "w") as f:
        for r in recs:
            f.write((r if isinstance(r, str) else json.dumps(r)) + "\n")
    return path


MAKE_CONTEXT = {   # stub make_context.py by behaviour
    "ok": 'os.makedirs(out, exist_ok=True); open(os.path.join(out, "HANDOFF.md"), "w").write("# note")',
    "exit1": 'sys.stderr.write("boom"); sys.exit(1)',
    "nofile": "pass",
    "timeout": "time.sleep(5)",
    "slow": 'time.sleep(1.0); os.makedirs(out, exist_ok=True); open(os.path.join(out, "HANDOFF.md"), "w").write("# note")',
}


def make_stubs(folder):
    stubs = {}
    for mode, body in MAKE_CONTEXT.items():
        stubs[mode] = write_script(os.path.join(folder, "mc_%s.py" % mode), """
            import os, sys, time
            transcript, out = sys.argv[1], sys.argv[2]
            open(os.environ["STUB_CALLS"], "a").write(transcript + " " + out + "\\n")
            %s
            """ % body)
    stubs["missing"] = os.path.join(folder, "does-not-exist.py")
    return stubs


class ContextTokens(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.m = load()

    def tok(self, recs, tail=1 << 20):
        p = os.path.join(self.tmp, "t.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            for r in recs:
                f.write((r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)) + "\n")
        return self.m.context_tokens(p, tail)

    @staticmethod
    def a(n, **kw):
        return dict({"type": "assistant", "message": {"usage": {"input_tokens": n}}}, **kw)

    def test_cases(self):
        a = self.a
        cases = [
            ("last of several", [a(10), a(30), a(20)], 20),
            ("sidechain after main is ignored", [a(10), a(99, isSidechain=True)], 10),
            ("record without usage after", [a(10), {"type": "assistant", "message": {"content": "x"}}], 10),
            ("zero usage skipped", [a(10), a(0)], 10),
            ("malformed last line", [a(10), "{not json"], 10),
            ("non-assistant with usage ignored", [a(10), {"type": "user", "message": {"usage": {"input_tokens": 99}}}], 10),
            ("none fields", [a(10), {"type": "assistant", "message": {"usage": {"input_tokens": None}}}], 10),
            ("three fields summed", [{"type": "assistant", "message": {"usage": {
                "input_tokens": 1, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 300}}}], 321),
            ("U+2028 inside a text", [a(10), {"type": "user", "message": {"content": "a b"}}], 10),
            ("U+2028 inside the usage record", [dict(a(10), note="x y")], 10),
            ("empty", [], 0),
            ("message is not a dict", [a(10), {"type": "assistant", "message": "text"}], 10),
        ]
        for name, recs, want in cases:
            with self.subTest(name):
                self.assertEqual(self.tok(recs), want)

    def test_tail_boundaries(self):
        filler = {"type": "user", "message": {"content": "é" * 200}}
        recs = [self.a(777)] + [filler] * 40 + [self.a(0)]
        for tail in (50, 333, 1000, 5000, 1 << 20):   # cuts inside a multibyte char and inside a JSON line
            with self.subTest(tail=tail):
                self.assertEqual(self.tok(recs, tail), 777)      # usage only far back: the full scan finds it
        self.assertEqual(self.tok([self.a(5)] + [filler] * 40 + [self.a(9)], 1000), 9)   # last one inside the tail


class HookMatrix(unittest.TestCase):
    """Every combination of the gates that decide whether the hook hands off (4860), against an independent oracle."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.stubs = make_stubs(cls.tmp)
        cls.m = load()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, True)

    @staticmethod
    def expected(c):
        """(outcome, number of pending files left in run/pending) for one combination of the gates."""
        gate, event, tokens, lock, cool, failed, sig, mc = c
        if gate != "set" or event not in ("Stop", "PostToolUse"):
            return "none", 0
        if sig == "yes":
            return "none", 1                  # a handoff is waiting for the wrapper: only this event is kept
        if tokens < 100000 or lock == "done" or cool == "recent" or failed == "recent" or mc == "missing":
            return "none", 0
        if lock == "held":
            return "none", 1                  # another hook is writing the handoff right now: this event is kept
        return ("handoff", 1) if mc == "ok" else ("failed", 0)

    def run_case(self, i, c):
        gate, event, tokens, lock, cool, failed, sig, mc = c
        root = os.path.join(self.tmp, "c%d" % i)
        base, run = os.path.join(root, "base"), os.path.join(root, "run")
        os.makedirs(base), os.makedirs(run)
        calls = os.path.join(root, "calls")
        sid = "sess%d" % i
        old = time.time() - 700

        def touch(name, when=None):
            p = os.path.join(run, name)
            open(p, "w").close()
            if when:
                os.utime(p, (when, when))

        held = None
        if lock == "done":
            touch("done-" + sid)
        elif lock == "held":                  # another hook process owns the claim: an flock on another open file
            held = open(os.path.join(run, "lock-" + sid), "a")
            fcntl.flock(held, fcntl.LOCK_EX)
        if cool != "none":
            touch("last-handoff", old if cool == "old" else None)
        if failed != "none":
            touch("failed-" + sid, old if failed == "old" else None)
        if sig == "yes":
            open(os.path.join(run, "signal.json"), "w").write('{"pre": 1}')
        env = {"CLAUDE_AUTO_DIR": base, "CLAUDE_AUTO_TOKENS": "100000", "CLAUDE_AUTO_COOLDOWN": "600",
               "CLAUDE_AUTO_MAKE_CONTEXT": self.stubs[mc], "CLAUDE_AUTO_MAKE_TIMEOUT": "1", "STUB_CALLS": calls}
        payload = {"hook_event_name": event, "session_id": sid, "cwd": "/work", "tool_name": "Bash",
                   "tool_input": {"command": "ls"}, "tool_response": {"stdout": "files"}, "last_assistant_message": "done",
                   "transcript_path": transcript(os.path.join(root, "t.jsonl"), tokens)}
        try:
            with mock.patch.dict(os.environ, env):
                os.environ.pop("CLAUDE_AUTO_RUN", None)
                if gate == "set":
                    os.environ["CLAUDE_AUTO_RUN"] = run
                res = self.m.handle(payload)
        finally:
            if held:
                held.close()
            while self.m.HELD:                # a real hook process ends; this one must let go of its claim
                self.m.HELD.pop().close()
        ncalls = len(open(calls).read().splitlines()) if os.path.exists(calls) else 0
        has = lambda n: os.path.exists(os.path.join(run, n))
        want, npending = self.expected(c)
        pdir = os.path.join(run, "pending")
        files = sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []
        self.assertEqual(len(files), npending, files)
        for f in files:
            self.assertTrue(f.startswith("pending-%s-" % sid), f)
            self.assertIn("files" if event == "PostToolUse" else "done", open(os.path.join(pdir, f)).read())
        if want == "handoff":
            self.assertEqual(ncalls, 1)
            s = json.load(open(os.path.join(run, "signal.json")))
            self.assertTrue(os.path.isfile(s["handoff"]), s)
            self.assertTrue(s["handoff"].startswith(base) and s["handoff"].endswith("/HANDOFF.md"))
            self.assertRegex(os.path.basename(os.path.dirname(s["handoff"])), r"^handoff-[0-9a-f]{8}-\d{8}-\w+$")
            self.assertEqual((s["event"], s["session_id"], s["cwd"], s["tokens"]), (event, sid, "/work", tokens))
            self.assertNotIn("pending", s)    # the wrapper collects the pending files; the signal does not name them
            self.assertTrue(has("done-" + sid) and has("last-handoff"))
            self.assertFalse(has("signal.json.tmp"))
            if event == "PostToolUse":
                self.assertIs(res["continue"], False)
                self.assertIn("stopReason", res)
            else:
                self.assertEqual(list(res), ["systemMessage"])
        elif want == "failed":
            self.assertEqual(ncalls, 1)
            self.assertIsNone(res)
            self.assertFalse(has("signal.json") or has("done-" + sid))
            self.assertTrue(has("failed-" + sid))
            out = open(calls).read().split()[1]
            self.assertFalse(os.path.exists(out), "the folder of a failed handoff was left behind")
        else:
            self.assertEqual(ncalls, 0, "make_context ran although a gate was closed")
            self.assertIsNone(res)
            self.assertEqual(has("signal.json"), sig == "yes")
            self.assertEqual(has("done-" + sid), lock == "done")
            self.assertEqual(has("failed-" + sid), failed != "none")
            self.assertEqual(has("last-handoff"), cool != "none")
            if lock == "done" and gate == "set" and event in ("Stop", "PostToolUse") and tokens >= 100000 and sig == "no":
                # an already handed-off session returns at the marker, before any log line (not only at claim())
                self.assertFalse(os.path.exists(os.path.join(base, "auto.log")))

    def test_matrix(self):
        space = [("set", "unset"), ("Stop", "PostToolUse", "SessionStart"), (99999, 100000, 150000),
                 ("none", "done", "held"), ("none", "recent", "old"), ("none", "recent", "old"), ("no", "yes"),
                 ("ok", "exit1", "nofile", "timeout", "missing")]
        cases = list(itertools.product(*space))
        self.assertEqual(len(cases), 4860)
        counts = {}
        for i, c in enumerate(cases):
            with self.subTest(case=c):
                self.run_case(i, c)
            counts[self.expected(c)[0]] = counts.get(self.expected(c)[0], 0) + 1
        self.assertEqual(sorted(counts), ["failed", "handoff", "none"])      # all three outcomes were exercised

    def hand_off(self, name, extra, sid="s"):
        root = os.path.join(self.tmp, name)
        run = os.path.join(root, "run")
        os.makedirs(run)
        env = {"CLAUDE_AUTO_DIR": os.path.join(root, "base"), "CLAUDE_AUTO_TOKENS": "1", "CLAUDE_AUTO_RUN": run,
               "CLAUDE_AUTO_MAKE_CONTEXT": self.stubs["ok"], "STUB_CALLS": os.path.join(root, "calls")}
        payload = dict({"hook_event_name": "PostToolUse", "session_id": sid, "cwd": "/w",
                        "transcript_path": transcript(os.path.join(root, "t.jsonl"), 500)}, **extra)
        with mock.patch.dict(os.environ, env):
            self.m.handle(payload)
        while self.m.HELD:
            self.m.HELD.pop().close()
        pdir = os.path.join(run, "pending")
        names = sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []
        return run, [os.path.join(pdir, n) for n in names]

    def test_pending_files(self):
        cases = [("PostToolUse", {"tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": {"command": "echo hi"},
                                  "tool_response": {"stdout": "hello-handoff"}},
                  ["Apel de unealtă: Bash", "toolu_1", "echo hi", "hello-handoff"]),
                 ("Stop", {"last_assistant_message": "răspuns final"}, ["răspuns final"]),
                 ("PostToolUse", {"tool_name": "Bash"}, None),
                 ("Stop", {}, None),
                 ("PostToolUse", {"tool_response": ""}, ["--- rezultat ---"])]
        for i, (event, extra, texts) in enumerate(cases):
            with self.subTest(event=event, texts=texts):
                run, files = self.hand_off("p%d" % i, dict(extra, hook_event_name=event))
                self.assertEqual(len(files), 1 if texts else 0, files)
                if texts:
                    body = open(files[0], encoding="utf-8").read()
                    for t in texts:
                        self.assertIn(t, body)
                self.assertNotIn("pending", json.load(open(os.path.join(run, "signal.json"))))

    def test_missing_tool_response_is_logged(self):
        self.hand_off("nores", {"tool_name": "Bash"})
        log = open(os.path.join(self.tmp, "nores", "base", "auto.log")).read()
        self.assertIn("no tool_response", log)

    def test_a_big_payload_is_kept_whole_in_pieces_one_read_can_open(self):
        rows = ["line-%05d %s" % (i, "x" * 60) for i in range(3000)] + ["END-MARKER"]       # about 200 KB
        long_line = "y" * 5000 + "TAIL-OF-THE-LONG-LINE"
        run, files = self.hand_off("big", {"tool_name": "Bash", "tool_use_id": "toolu_big", "tool_input": {"command": "z" * 50000},
                                           "tool_response": {"stdout": "\n".join(rows) + "\n" + long_line}})
        self.assertGreater(len(files), 3)
        texts = [open(f, encoding="utf-8").read() for f in files]
        for f, t in zip(files, texts):
            self.assertLessEqual(len(t), self.m.PENDING_CHUNK + self.m.PENDING_LINE + 2, f)
            self.assertTrue(all(len(l) <= self.m.PENDING_LINE for l in t.split("\n")), f)
        body = "".join(texts)
        self.assertTrue(all(r in body for r in rows))                      # every line of the result, up to the last
        flat = body.replace("\n", "")
        self.assertIn(long_line, flat)                                      # a line over the cap is wrapped, not cut
        self.assertIn("z" * 50000, flat)                                    # a big input does not push the result out
        self.assertLess(body.index("--- input ---"), body.index("--- rezultat ---"))

    def test_pending_is_capped_per_run(self):
        run = os.path.join(self.tmp, "cap", "run")
        os.makedirs(run)
        with mock.patch.dict(os.environ, {"CLAUDE_AUTO_DIR": os.path.join(self.tmp, "cap", "base")}):
            wrote = [self.m.save_pending(run, {"hook_event_name": "Stop", "session_id": "s", "last_assistant_message": "r%d" % i})
                     for i in range(self.m.PENDING_MAX + 5)]
        self.assertEqual(sum(1 for w in wrote if w), self.m.PENDING_MAX)
        self.assertEqual(len(os.listdir(os.path.join(run, "pending"))), self.m.PENDING_MAX)

    def test_default_make_context_is_the_newest_plugin_copy(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("CLAUDE_AUTO_MAKE_CONTEXT", None)
            found = self.m.find_make_context()
        if found is None:
            self.skipTest("the apana plugin is not installed")
        self.assertTrue(found.endswith("/skills/compact-handoff/scripts/make_context.py") and os.path.isfile(found))

    def test_claim_is_exclusive_and_needs_no_timeout(self):
        run = os.path.join(self.tmp, "lockrun")
        os.makedirs(run)
        self.assertTrue(self.m.claim(run, "a"))
        self.assertFalse(self.m.claim(run, "a"))                 # held by this very process
        self.m.give_up(run, "a")                                 # lets go
        self.assertTrue(self.m.claim(run, "a"))
        self.m.give_up(run, "a")
        p = os.path.join(run, "lock-b")                          # the lock file of a hook that died, however old
        open(p, "w").close()
        os.utime(p, (1, 1))
        self.assertTrue(self.m.claim(run, "b"))
        self.m.give_up(run, "b")
        open(self.m.done_file(run, "c"), "w").close()            # a session that was handed off is not claimed again
        self.assertFalse(self.m.claim(run, "c"))

    def test_only_one_of_many_simultaneous_claims_wins(self):
        code = textwrap.dedent("""
            import importlib.machinery, importlib.util, sys, time
            loader = importlib.machinery.SourceFileLoader("ca", sys.argv[1])
            m = importlib.util.module_from_spec(importlib.util.spec_from_loader("ca", loader)); loader.exec_module(m)
            time.sleep(max(0, float(sys.argv[3]) - time.time()))
            won = m.claim(sys.argv[2], "s")
            print("WON" if won else "LOST", flush=True)
            time.sleep(1.5)                      # the winner is still writing its handoff while the others try
            """)
        for rnd in range(3):
            run = os.path.join(self.tmp, "race%d" % rnd)
            os.makedirs(run)
            p = os.path.join(run, "lock-s")                      # the old race: a stale lock that many hooks replace at once
            open(p, "w").close()
            os.utime(p, (1, 1))
            start = time.time() + 2.5
            procs = [subprocess.Popen([PY, "-I", "-c", code, SCRIPT, run, str(start)], stdout=subprocess.PIPE, text=True)
                     for _ in range(12)]
            results = [q.communicate(timeout=60)[0].strip() for q in procs]
            self.assertEqual(results.count("WON"), 1, results)


class HookProcess(unittest.TestCase):
    """The hook as Claude Code runs it: `claude-auto __hook`, payload on stdin. It must always exit 0."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(os.environ, CLAUDE_AUTO_DIR=os.path.join(self.tmp, "base"), CLAUDE_AUTO_TOKENS="1",
                        CLAUDE_AUTO_MAKE_CONTEXT=make_stubs(self.tmp)["ok"], STUB_CALLS=os.path.join(self.tmp, "calls"))
        self.env.pop("CLAUDE_AUTO_RUN", None)

    def hook(self, stdin, run=True):
        env = dict(self.env)
        if run:
            os.makedirs(os.path.join(self.tmp, "run"), exist_ok=True)
            env["CLAUDE_AUTO_RUN"] = os.path.join(self.tmp, "run")
        return subprocess.run([PY, "-I", SCRIPT, "__hook"], input=stdin, env=env, capture_output=True, text=True, timeout=30)

    def test_invalid_input_exits_zero_without_output(self):
        t = transcript(os.path.join(self.tmp, "t.jsonl"), 500)
        for stdin in ("", "not json", "[]", "null", "42", '{"hook_event_name": "Stop"}', json.dumps(
                {"hook_event_name": "Stop", "session_id": "s", "transcript_path": self.tmp}), json.dumps(
                {"hook_event_name": "Stop", "session_id": "s", "transcript_path": t + ".missing"})):
            with self.subTest(stdin=stdin[:40]):
                r = self.hook(stdin)
                self.assertEqual((r.returncode, r.stdout), (0, ""), r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "run", "signal.json")))

    def test_real_handoff_prints_valid_json(self):
        t = transcript(os.path.join(self.tmp, "t.jsonl"), 500)
        for event, key in (("Stop", "systemMessage"), ("PostToolUse", "continue")):
            r = self.hook(json.dumps({"hook_event_name": event, "session_id": "s" + event, "transcript_path": t, "cwd": "/w"}))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(key, json.loads(r.stdout))
            os.remove(os.path.join(self.tmp, "run", "signal.json"))
            os.remove(os.path.join(self.tmp, "run", "last-handoff"))

    def test_default_threshold_is_150000(self):
        self.env.pop("CLAUDE_AUTO_TOKENS")
        for tokens, handoff in ((100000, False), (149999, False), (150000, True)):
            with self.subTest(tokens=tokens):
                t = transcript(os.path.join(self.tmp, "t%d.jsonl" % tokens), tokens)
                r = self.hook(json.dumps({"hook_event_name": "Stop", "session_id": "d%d" % tokens, "transcript_path": t, "cwd": "/w"}))
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout != "", handoff, r.stdout)
                for f in ("signal.json", "last-handoff"):
                    if os.path.exists(os.path.join(self.tmp, "run", f)):
                        os.remove(os.path.join(self.tmp, "run", f))

    def test_parallel_hooks_make_one_handoff_and_every_event_is_kept(self):
        self.env["CLAUDE_AUTO_MAKE_CONTEXT"] = make_stubs(self.tmp)["slow"]          # the winner needs a second
        t = transcript(os.path.join(self.tmp, "t.jsonl"), 500)
        os.makedirs(os.path.join(self.tmp, "run"), exist_ok=True)
        env = dict(self.env, CLAUDE_AUTO_RUN=os.path.join(self.tmp, "run"))
        procs = [subprocess.Popen([PY, "-I", SCRIPT, "__hook"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
                 for _ in range(6)]
        for i, p in enumerate(procs):
            p.stdin.write(json.dumps({"hook_event_name": "PostToolUse", "session_id": "par", "transcript_path": t, "cwd": "/w",
                                      "tool_name": "Bash", "tool_use_id": "toolu_%d" % i, "tool_input": {"command": "echo %d" % i},
                                      "tool_response": {"stdout": "RESULT-%d" % i}}))
            p.stdin.close()
        outs = [p.stdout.read() for p in procs]
        for p in procs:
            self.assertEqual(p.wait(30), 0)
        self.assertEqual(len(open(self.env["STUB_CALLS"]).read().splitlines()), 1)         # one handoff
        self.assertEqual(sum(1 for o in outs if '"continue": false' in o), 1)
        pdir = os.path.join(self.tmp, "run", "pending")
        body = "".join(open(os.path.join(pdir, n)).read() for n in sorted(os.listdir(pdir)))
        self.assertEqual(len(os.listdir(pdir)), 6)
        for i in range(6):
            self.assertIn("RESULT-%d" % i, body)                                            # the winner's and the losers'

    def test_without_the_run_variable_nothing_happens(self):
        t = transcript(os.path.join(self.tmp, "t.jsonl"), 500)
        r = self.hook(json.dumps({"hook_event_name": "Stop", "session_id": "s", "transcript_path": t}), run=False)
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        self.assertFalse(os.path.exists(self.env["STUB_CALLS"]))


FAKE_CLAUDE = """
    import json, os, signal, subprocess, sys, termios, time, tty
    state, mode = os.environ["FAKE_STATE"], os.environ.get("FAKE_MODE", "")
    n = len([f for f in os.listdir(state) if f.startswith("call-")])
    rec = {"n": n, "argv": sys.argv[1:], "cwd": os.getcwd(), "run": os.environ.get("CLAUDE_AUTO_RUN"), "pid": os.getpid()}
    if "--settings" in sys.argv:
        rec["settings"] = open(sys.argv[sys.argv.index("--settings") + 1]).read()
    if os.isatty(0):
        rec["lflag"] = termios.tcgetattr(0)[3]
        rec["echo_icanon"] = bool(rec["lflag"] & termios.ECHO and rec["lflag"] & termios.ICANON)
    json.dump(rec, open(os.path.join(state, "call-%d" % n), "w"))

    def fire(sid):
        t = os.path.join(state, "t%d.jsonl" % n)
        open(t, "w").write(json.dumps({"type": "assistant", "message": {"usage": {"input_tokens": 150000}}}) + "\\n")
        payload = {"hook_event_name": os.environ.get("FAKE_EVENT", "Stop"), "session_id": sid, "transcript_path": t,
                   "cwd": os.environ.get("FAKE_CWD", os.getcwd()), "tool_response": {"stdout": "last-output"},
                   "last_assistant_message": "last-reply"}
        cmd = json.loads(rec["settings"])["hooks"]["Stop"][-1]["hooks"][0]["command"] if "settings" in rec else None
        if cmd:   # run the hook exactly as Claude Code would: the command string of the settings file, through a shell
            subprocess.run(cmd, shell=True, input=json.dumps(payload), text=True, env=os.environ)

    if mode == "exit7":
        sys.exit(7)
    elif mode == "sleep":
        time.sleep(60)
    elif mode in ("handoff", "handoff_ignore_term", "tty"):
        if n == 0:
            if mode == "handoff_ignore_term":
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
            if mode == "tty":
                tty.setraw(0)
                sys.stdout.write("\\x1b[?2004h\\x1b[?25l"); sys.stdout.flush()
            fire("s0")
            time.sleep(60)
    elif mode == "ignore_term_sleep":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(60)
    elif mode == "handoff_child":
        if n == 0:   # a tool of the session, detached like the ones Claude Code's Bash tool starts
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True)
            open(os.path.join(state, "child-pid"), "w").write(str(child.pid))
            fire("s0")
            time.sleep(60)
    elif mode == "tty_die":
        if n == 0:
            tty.setraw(0)
            sys.stdout.write("\\x1b[?2004h\\x1b[?25l"); sys.stdout.flush()
            os.kill(os.getpid(), signal.SIGKILL)
    elif mode == "handoff_then_quit":
        fire("s0")
        time.sleep(0.5)
        sys.exit(3)
    elif mode == "chain":
        if n < 3 and os.environ.get("CLAUDE_AUTO_RUN"):
            fire("s%d" % n)
            time.sleep(60)
    """


class Wrapper(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, "state")
        self.base = os.path.join(self.tmp, "base")
        self.cwd2 = os.path.join(self.tmp, "second cwd")
        for d in (self.state, self.base, self.cwd2):
            os.makedirs(d)
        # a path with a space: the hook command in the settings file must survive quoting
        self.auto = os.path.join(self.tmp, "dir with space", "claude-auto")
        os.makedirs(os.path.dirname(self.auto))
        shutil.copy(SCRIPT, self.auto)
        self.fake = write_script(os.path.join(self.tmp, "fakeclaude"), FAKE_CLAUDE)
        self.env = dict(os.environ, CLAUDE_AUTO_CLAUDE=self.fake, CLAUDE_AUTO_DIR=self.base, FAKE_STATE=self.state,
                        CLAUDE_AUTO_MAKE_CONTEXT=make_stubs(self.tmp)["ok"], STUB_CALLS=os.path.join(self.tmp, "calls"),
                        CLAUDE_AUTO_GRACE="0.05", CLAUDE_AUTO_POLL="0.02", CLAUDE_AUTO_KILL_WAIT="0.5",
                        CLAUDE_AUTO_COOLDOWN="0", FAKE_CWD=self.cwd2)
        for k in ("CLAUDE_AUTO_RUN", "CLAUDE_AUTO_NEXT_ARGS", "CLAUDE_AUTO_MAX", "CLAUDE_AUTO_TOKENS"):
            self.env.pop(k, None)

    def wrap(self, *args, cwd=None, **env):
        e = dict(self.env, **env)
        return subprocess.run([PY, "-I", self.auto, *args], env=e, capture_output=True, text=True, timeout=60, cwd=cwd)

    def calls(self):
        names = sorted((f for f in os.listdir(self.state) if f.startswith("call-")), key=lambda f: int(f[5:]))
        return [json.load(open(os.path.join(self.state, f))) for f in names]

    def assertDead(self, pid):
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        self.fail("process %d is still alive" % pid)

    def test_exit_code_passes_through_and_nothing_is_relaunched(self):
        r = self.wrap("--model", "opus", FAKE_MODE="exit7")
        self.assertEqual(r.returncode, 7, r.stderr)
        c = self.calls()
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0]["argv"][0], "--settings")
        self.assertEqual(c[0]["argv"][2:], ["--model", "opus"])
        self.assertTrue(c[0]["run"] and c[0]["run"].startswith(self.base))
        self.assertEqual([d for d in os.listdir(self.base) if d.startswith("run-")], [])      # run folder removed

    def test_settings_file_has_both_hooks_with_a_quoted_command(self):
        self.wrap(FAKE_MODE="exit7")
        s = json.loads(self.calls()[0]["settings"])
        self.assertEqual(sorted(s["hooks"]), ["PostToolUse", "Stop"])
        self.assertEqual(s["hooks"]["PostToolUse"][0]["matcher"], "*")
        cmd = s["hooks"]["Stop"][0]["hooks"][0]["command"]
        self.assertEqual(cmd, s["hooks"]["PostToolUse"][0]["hooks"][0]["command"])
        self.assertIn("'%s'" % os.path.realpath(self.auto), cmd)  # the path with a space is quoted (macOS: /var -> /private/var)
        self.assertTrue(cmd.endswith(" __hook"))

    def test_handoff_ends_claude_and_starts_the_new_session(self):
        for event in ("Stop", "PostToolUse"):
            with self.subTest(event=event):
                shutil.rmtree(self.state), os.makedirs(self.state)
                r = self.wrap("--model", "opus", "do the task", "--permission-mode=plan", "--verbose",
                              FAKE_MODE="handoff", FAKE_EVENT=event)
                self.assertEqual(r.returncode, 0, r.stderr)
                c = self.calls()
                self.assertEqual(len(c), 2, r.stderr)
                self.assertEqual(c[0]["argv"][2:], ["--model", "opus", "do the task", "--permission-mode=plan", "--verbose"])
                self.assertDead(c[0]["pid"])
                second = c[1]["argv"]
                self.assertEqual(second[0], "--settings")
                # follow-up flags: only the sticky ones, never the first prompt
                self.assertEqual(second[2:-2], ["--model", "opus", "--permission-mode=plan", "--verbose"])
                self.assertEqual(second[-2], "--")                      # the prompt can never be taken for an option value
                prompt = second[-1]
                handoff = prompt.split(" ")[1]
                self.assertTrue(handoff.endswith("/HANDOFF.md") and os.path.isfile(handoff), prompt)
                self.assertIn("150k tokeni", prompt)
                pdir = os.path.join(os.path.dirname(handoff), "pending")
                files = sorted(os.listdir(pdir))                         # moved next to the note before the new session
                self.assertEqual(len(files), 1)
                self.assertRegex(files[0], r"^pending-s0-\d{19}-\w+\.txt$")
                self.assertIn(os.path.join(pdir, files[0]), prompt)
                self.assertIn("last-output" if event == "PostToolUse" else "last-reply", open(os.path.join(pdir, files[0])).read())
                self.assertEqual(self.run_folders(), [])
                self.assertEqual(os.path.realpath(c[1]["cwd"]), os.path.realpath(self.cwd2))
                self.assertIn("[claude-auto]", r.stderr)
                self.assertIn(handoff, r.stderr)
                self.assertEqual([d for d in os.listdir(self.base) if d.startswith("run-")], [])

    def run_folders(self):
        return [d for d in os.listdir(self.base) if d.startswith("run-")]

    def test_next_args_override(self):
        self.wrap("--model", "opus", FAKE_MODE="handoff", CLAUDE_AUTO_NEXT_ARGS="--permission-mode 'accept Edits'")
        self.assertEqual(self.calls()[1]["argv"][2:-2], ["--permission-mode", "accept Edits"])
        shutil.rmtree(self.state), os.makedirs(self.state)
        self.wrap("--model", "opus", FAKE_MODE="handoff", CLAUDE_AUTO_NEXT_ARGS="")
        self.assertEqual(self.calls()[1]["argv"][2:-2], [])

    def test_a_variadic_next_arg_does_not_swallow_the_prompt(self):
        self.wrap(FAKE_MODE="handoff", CLAUDE_AUTO_NEXT_ARGS="--allowedTools Bash Read")
        second = self.calls()[1]["argv"]
        self.assertEqual(second[2:-2], ["--allowedTools", "Bash", "Read"])
        self.assertEqual(second[-2], "--")
        self.assertIn("HANDOFF.md", second[-1])

    def test_an_invalid_next_args_stops_before_anything_is_created(self):
        r = self.wrap("--model", "opus", FAKE_MODE="exit7", CLAUDE_AUTO_NEXT_ARGS="--model 'oops")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("CLAUDE_AUTO_NEXT_ARGS", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.run_folders(), [])

    def test_an_unusable_notes_folder_stops_cleanly(self):
        blocker = os.path.join(self.tmp, "a-file")
        open(blocker, "w").close()
        r = self.wrap("--model", "opus", FAKE_MODE="exit7", CLAUDE_AUTO_DIR=os.path.join(blocker, "sub"))
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("nothing was started", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_setup_failure_leaves_no_run_folder(self):
        m = load()
        with mock.patch.dict(os.environ, self.env), mock.patch.object(m, "write_settings", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                m.wrapper(["--model", "opus"])
        self.assertEqual(self.run_folders(), [])

    def test_a_relative_claude_path_survives_the_follow_up_changing_directory(self):
        os.symlink(self.fake, os.path.join(self.tmp, "rel-claude"))
        r = self.wrap(FAKE_MODE="handoff", CLAUDE_AUTO_CLAUDE="./rel-claude", cwd=self.tmp)
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()
        self.assertEqual(len(c), 2, r.stderr)
        self.assertEqual(os.path.realpath(c[1]["cwd"]), os.path.realpath(self.cwd2))

    def test_sigterm_to_a_claude_that_ignores_it_is_bounded(self):
        p = subprocess.Popen([PY, "-I", self.auto], env=dict(self.env, FAKE_MODE="ignore_term_sleep"),
                             stderr=subprocess.DEVNULL, text=True)
        for _ in range(100):
            if os.listdir(self.state):
                break
            time.sleep(0.05)
        time.sleep(0.3)
        pid = self.calls()[0]["pid"]
        started = time.time()
        p.send_signal(signal.SIGTERM)
        try:
            code = p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
            self.fail("the wrapper waits for ever for a claude that ignores SIGTERM")
        self.assertEqual(code, 137)                                     # 128 + SIGKILL: it was killed after KILL_WAIT
        self.assertLess(time.time() - started, 5)
        self.assertDead(pid)
        self.assertEqual(self.run_folders(), [])

    def test_no_new_session_is_started_after_a_stop_was_requested(self):
        m = load()
        m.Child.stop, m.Child.signum = True, signal.SIGTERM
        self.addCleanup(setattr, m.Child, "stop", False)
        self.assertEqual(m.run_once([self.fake], dict(os.environ), None, None), (143, None))
        self.assertEqual(self.calls(), [])

    def test_what_the_session_left_running_is_ended_with_it(self):
        r = self.wrap(FAKE_MODE="handoff_child")
        self.assertEqual(r.returncode, 0, r.stderr)
        child = int(open(os.path.join(self.state, "child-pid")).read())
        self.addCleanup(lambda: os.kill(child, signal.SIGKILL) if self.alive(child) else None)
        self.assertDead(child)

    def alive(self, pid):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def test_dashes_make_the_rest_prompt_text(self):
        r = self.wrap("--model", "opus", "--", "--dangerously-skip-permissions", FAKE_MODE="handoff")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()
        self.assertEqual(c[0]["argv"][2:], ["--model", "opus", "--", "--dangerously-skip-permissions"])
        self.assertEqual(c[1]["argv"][2:-2], ["--model", "opus"])               # the "flag" after -- is not carried over
        r = self.wrap("--", "--help", FAKE_MODE="exit7")                        # prompt text, not a request for help
        self.assertEqual(r.returncode, 7)
        self.assertEqual(self.calls()[-1]["argv"][0], "--settings")             # wrapped, not passed through

    def test_a_user_settings_file_is_merged_not_overridden(self):
        user = os.path.join(self.tmp, "user.json")
        json.dump({"permissions": {"allow": ["Bash(ls)"]},
                   "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo user"}]}]}}, open(user, "w"))
        for form in (["--settings", user], ["--settings=" + user], ["--settings", open(user).read()]):
            with self.subTest(form=form[0]):
                shutil.rmtree(self.state), os.makedirs(self.state)
                self.wrap("--model", "opus", *form, FAKE_MODE="exit7")
                a = self.calls()[0]["argv"]
                self.assertEqual((a[0], a[2:]), ("--settings", ["--model", "opus"]))     # only ours is left on the command line
                s = json.loads(self.calls()[0]["settings"])
                self.assertEqual(s["permissions"], {"allow": ["Bash(ls)"]})
                self.assertEqual([h["hooks"][0]["command"] for h in s["hooks"]["Stop"]][0], "echo user")
                self.assertTrue(s["hooks"]["Stop"][-1]["hooks"][0]["command"].endswith(" __hook"))
                self.assertEqual(len(s["hooks"]["Stop"]), 2)
                self.assertEqual(len(s["hooks"]["PostToolUse"]), 1)

    def test_a_user_settings_that_cannot_be_read_is_reported_and_kept(self):
        r = self.wrap("--settings", "/nonexistent/user.json", FAKE_MODE="exit7")
        self.assertIn("cannot be merged", r.stderr)
        a = self.calls()[0]["argv"]
        self.assertEqual(a[2:], ["--settings", "/nonexistent/user.json"])        # as typed: it stays in force, as before

    def test_user_settings_stay_after_the_hooks_are_gone(self):
        user = os.path.join(self.tmp, "user.json")
        json.dump({"permissions": {"allow": ["Bash(ls)"]}}, open(user, "w"))
        self.wrap("--settings", user, FAKE_MODE="chain", CLAUDE_AUTO_MAX="1")
        c = self.calls()
        self.assertEqual(len(c), 2)
        self.assertTrue(c[0]["run"] and not c[1]["run"])                          # the second session has no hooks
        self.assertEqual(c[1]["argv"][0], "--settings")                           # but it still gets the user's settings
        self.assertEqual(json.loads(c[1]["settings"]), {"permissions": {"allow": ["Bash(ls)"]}})

    def test_claude_that_ignores_sigterm_is_killed(self):
        r = self.wrap(FAKE_MODE="handoff_ignore_term")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()
        self.assertEqual(len(c), 2)
        self.assertDead(c[0]["pid"])

    def test_user_who_quits_during_the_grace_gets_no_new_session(self):
        r = self.wrap(FAKE_MODE="handoff_then_quit", CLAUDE_AUTO_GRACE="3")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertEqual(len(self.calls()), 1)

    def test_max_handoffs_then_claude_runs_without_the_hook(self):
        for maximum, hooked in (("1", [True, False]), ("2", [True, True, False]), ("0", [True, True, True, False])):
            with self.subTest(max=maximum):
                shutil.rmtree(self.state), os.makedirs(self.state)
                r = self.wrap(FAKE_MODE="chain", CLAUDE_AUTO_MAX=maximum)
                self.assertEqual(r.returncode, 0, r.stderr)
                c = self.calls()
                if maximum == "0":      # unlimited: the stub stops after 3 hooked sessions by itself (n < 3)
                    hooked = [True, True, True, True]
                self.assertEqual([("--settings" in x["argv"], bool(x["run"])) for x in c],
                                 [(h, h) for h in hooked][:len(c)], c)
                self.assertEqual(len(c), len(hooked))

    def test_passthrough_runs_plain_claude(self):
        cases = [["-p", "say hi"], ["--print", "x"], ["--version"], ["-h"], ["mcp", "list"], ["doctor"], ["--bg", "task"],
                 ["update"], ["plugin", "list"]]
        for args in cases:
            with self.subTest(args=args):
                shutil.rmtree(self.state), os.makedirs(self.state)
                r = self.wrap(*args, FAKE_MODE="exit7")
                self.assertEqual(r.returncode, 7)
                c = self.calls()
                self.assertEqual((c[0]["argv"], c[0]["run"]), (args, None))
        self.assertEqual([d for d in os.listdir(self.base) if d.startswith("run-")], [])

    def test_a_prompt_that_only_looks_like_a_subcommand_word_is_wrapped(self):
        self.wrap("explain mcp servers", FAKE_MODE="exit7")
        self.assertEqual(self.calls()[0]["argv"][0], "--settings")

    def test_missing_claude_binary(self):
        r = self.wrap(CLAUDE_AUTO_CLAUDE="/nonexistent/claude")
        self.assertEqual(r.returncode, 127)
        self.assertIn("claude not found", r.stderr)

    def test_sigterm_to_the_wrapper_ends_claude_and_cleans_up(self):
        p = subprocess.Popen([PY, "-I", self.auto], env=dict(self.env, FAKE_MODE="sleep"), stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            if os.listdir(self.state):
                break
            time.sleep(0.05)
        time.sleep(0.2)
        pid = self.calls()[0]["pid"]
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(15), 143)
        self.assertDead(pid)
        self.assertEqual([d for d in os.listdir(self.base) if d.startswith("run-")], [])

    def test_hook_runs_through_the_shell_and_the_wrapper_reads_its_signal_only_from_its_own_run(self):
        # two wrappers at once: each has its own run folder, so one's signal never ends the other's claude
        a = subprocess.Popen([PY, "-I", self.auto], env=dict(self.env, FAKE_MODE="sleep"), stderr=subprocess.DEVNULL)
        for _ in range(100):
            if os.listdir(self.state):
                break
            time.sleep(0.05)
        r = self.wrap(FAKE_MODE="exit7")                    # a second wrapper that hands off nothing
        self.assertEqual(r.returncode, 7)
        self.assertIsNone(a.poll())                        # the first one is untouched
        a.send_signal(signal.SIGTERM)
        a.wait(15)

    def test_modes_are_reset_when_claude_dies_by_a_signal(self):
        text = self.pty_output(FAKE_MODE="tty_die", CLAUDE_AUTO_MAX="1")
        self.assertIn("\x1b[?2004h", text)                                     # the fake claude turned the modes on, then died
        self.assertIn(load().TERMINAL_RESET, text[text.index("\x1b[?2004h"):])  # nobody else could turn them off

    def pty_output(self, **env):
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(PY, [PY, "-I", self.auto], dict(self.env, **env))
        out = b""
        deadline = time.time() + 30
        while time.time() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                out += chunk
        os.waitpid(pid, 0)
        os.close(fd)
        return out.decode(errors="replace")

    def test_terminal_is_restored_after_claude_is_killed(self):
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(PY, [PY, "-I", self.auto], dict(self.env, FAKE_MODE="tty"))
        out = b""
        deadline = time.time() + 30
        while time.time() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                out += chunk
        os.waitpid(pid, 0)
        os.close(fd)
        text = out.decode(errors="replace")
        self.assertIn("\x1b[?2004h", text)                          # the fake claude did turn the modes on
        self.assertIn(load().TERMINAL_RESET, text)                  # and the wrapper turned them off
        self.assertLess(text.index("\x1b[?2004h"), text.rindex(load().TERMINAL_RESET))
        c = self.calls()
        self.assertEqual(len(c), 2)
        self.assertTrue(c[1]["echo_icanon"], "the new session started with the terminal still in raw mode")


class PendingFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.m = load()

    def test_only_the_session_that_was_handed_off_is_collected_in_arrival_order(self):
        run, note = os.path.join(self.tmp, "run"), os.path.join(self.tmp, "base", "handoff-aaaaaaaa-20261018-x")
        os.makedirs(os.path.join(run, "pending")), os.makedirs(note)
        for n in ("pending-s0-0000000000000000002-b.txt", "pending-s0-0000000000000000001-a.txt",
                  "pending-s1-0000000000000000001-c.txt", ".pending-s0-0000000000000000003-d.txt"):
            open(os.path.join(run, "pending", n), "w").write(n)
        moved = self.m.collect_pending(run, {"handoff": os.path.join(note, "HANDOFF.md"), "session_id": "s0"})
        self.assertEqual([os.path.basename(p) for p in moved],
                         ["pending-s0-0000000000000000001-a.txt", "pending-s0-0000000000000000002-b.txt"])
        self.assertTrue(all(os.path.dirname(p) == os.path.join(note, "pending") for p in moved))
        self.assertEqual(sorted(os.listdir(os.path.join(run, "pending"))),
                         [".pending-s0-0000000000000000003-d.txt", "pending-s1-0000000000000000001-c.txt"])
        self.assertEqual(self.m.collect_pending(self.tmp, {"handoff": os.path.join(note, "HANDOFF.md"), "session_id": "s0"}), [])

    def test_the_prompt_names_the_pending_files(self):
        sig = {"handoff": "/n/HANDOFF.md", "tokens": 151000}
        self.assertNotIn("Citește și", self.m.new_session_prompt(dict(sig, pending=[])))
        two = self.m.new_session_prompt(dict(sig, pending=["/n/pending/a.txt", "/n/pending/b.txt"]))
        self.assertIn("/n/pending/a.txt, /n/pending/b.txt", two)
        many = self.m.new_session_prompt(dict(sig, pending=["/n/pending/f%d.txt" % i for i in range(13)]))
        self.assertIn("toate cele 13 fișiere din /n/pending", many)
        self.assertIn("~151k tokeni", many)

    def test_handoff_folder_names_follow_the_helpers_convention(self):
        with mock.patch.dict(os.environ, {"CLAUDE_AUTO_DIR": self.tmp}):
            names = [os.path.basename(self.m.handoff_dir(sid)) for sid in
                     ("654223bf-9f36-491e-983f-dd062d60245c", "654223bf-9f36-491e-983f-dd062d60245c", "zz-not-hex!", "")]
        for n in names:
            self.assertRegex(n, r"^handoff-[0-9a-f]{8}-\d{8}-\w+$")
        self.assertTrue(names[0].startswith("handoff-654223bf-"))
        self.assertEqual(len(set(names)), 4)                                  # unique even for the same session in the same second


class Settings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.m = load()

    def test_split_settings(self):
        f = os.path.join(self.tmp, "s.json")
        json.dump({"hooks": {}, "model": "x"}, open(f, "w"))
        cases = [
            (["a", "--settings", f, "b"], (["a", "b"], {"hooks": {}, "model": "x"})),
            (["--settings=" + f], ([], {"hooks": {}, "model": "x"})),
            (['--settings', '{"hooks": {}}'], ([], {"hooks": {}})),
            (["x", "--", "--settings", f], (["x", "--", "--settings", f], None)),          # after -- it is prompt text
            (["--settings"], (["--settings"], None)),                                      # no value
            (["--settings", "--"], (["--settings", "--"], None)),
            (["--model", "opus"], (["--model", "opus"], None)),
        ]
        for args, (kept, data) in cases:
            with self.subTest(args=args):
                k, d, err = self.m.split_settings(args)
                self.assertEqual((k, d, err), (kept, data, None))
        for bad in ("/nonexistent.json", "{not json", '["a"]', '{"hooks": 5}'):
            with self.subTest(bad=bad):
                k, d, err = self.m.split_settings(["--settings", bad])
                self.assertEqual((k, d), (["--settings", bad], None))
                self.assertTrue(err)

    def test_write_settings_merges_and_never_loses_the_users_entries(self):
        p = os.path.join(self.tmp, "o.json")
        self.m.write_settings(p, None)
        plain = json.load(open(p))
        self.assertEqual(sorted(plain["hooks"]), ["PostToolUse", "Stop"])
        user = {"env": {"A": "1"}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "u"}]}],
                                              "PreToolUse": [{"matcher": "Bash", "hooks": []}], "PostToolUse": "oops"}}
        self.m.write_settings(p, user)
        s = json.load(open(p))
        self.assertEqual(s["env"], {"A": "1"})
        self.assertEqual(s["hooks"]["PreToolUse"], user["hooks"]["PreToolUse"])
        self.assertEqual(s["hooks"]["Stop"][0], user["hooks"]["Stop"][0])
        self.assertEqual(len(s["hooks"]["Stop"]), 2)
        self.assertEqual(len(s["hooks"]["PostToolUse"]), 1)          # a malformed user value is replaced, not crashed on
        self.assertEqual(user["hooks"]["Stop"], [{"hooks": [{"type": "command", "command": "u"}]}])      # input not mutated


class Sticky(unittest.TestCase):
    def test_passthrough_stops_at_the_dashes(self):
        m = load()
        for args, want in ((["--help"], True), (["--", "--help"], False), (["x", "--", "-p"], False), (["-p", "--", "x"], True),
                           (["mcp", "list"], True), (["--", "mcp"], False), ([], False), (["--model", "opus", "--version"], True)):
            with self.subTest(args=args):
                self.assertEqual(m.passthrough(args), want)

    def test_cases(self):
        m = load()
        cases = [
            ([], []),
            (["fix the bug"], []),
            (["--model", "opus", "fix"], ["--model", "opus"]),
            (["--model=opus"], ["--model=opus"]),
            (["--permission-mode", "plan", "--resume", "abc", "-c"], ["--permission-mode", "plan"]),
            (["--dangerously-skip-permissions", "go"], ["--dangerously-skip-permissions"]),
            (["--model"], []),                                          # value missing
            (["--allowedTools", "Bash", "Read"], []),                   # variadic flags are not carried over
            (["--effort", "high", "--verbose", "--chrome"], ["--effort", "high", "--verbose", "--chrome"]),
            (["--", "--dangerously-skip-permissions"], []),            # after -- everything is prompt text
            (["--model", "opus", "--", "--effort", "high"], ["--model", "opus"]),
            (["--model", "--", "x"], []),                                # -- is never an option's value
        ]
        for args, want in cases:
            with self.subTest(args=args):
                self.assertEqual(m.sticky_args(args), want)


if __name__ == "__main__":
    unittest.main(verbosity=1)
