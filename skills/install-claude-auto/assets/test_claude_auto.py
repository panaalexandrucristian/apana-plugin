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


class Cooldown(unittest.TestCase):
    def test_default_is_sixty_seconds_from_last_successful_handoff(self):
        m = load()
        with tempfile.TemporaryDirectory() as run, mock.patch.dict(os.environ, {}, clear=True):
            marker = os.path.join(run, "last-handoff")
            self.assertTrue(m.cooled_down(run))  # the first handoff has no cooldown
            with open(marker, "w"):
                pass
            os.utime(marker, (1000, 1000))
            for now, allowed in ((1000, False), (1059, False), (1059.999, False),
                                 (1060, True), (1060.001, True), (1600, True)):
                with self.subTest(now=now), mock.patch.object(m.time, "time", return_value=now):
                    self.assertEqual(m.cooled_down(run), allowed)
                    self.assertEqual(os.path.getmtime(marker), 1000)  # checks never restart the countdown

    def test_successive_sessions_wait_sixty_seconds_and_keep_correct_token_count(self):
        m = load()
        with tempfile.TemporaryDirectory() as root:
            run = os.path.join(root, "run")
            os.mkdir(run)
            marker = os.path.join(run, "last-handoff")
            env = {"CLAUDE_AUTO_DIR": root, "CLAUDE_AUTO_RUN": run,
                   "CLAUDE_AUTO_TOKENS": "150000", "CLAUDE_AUTO_RULE": "off",
                   "CLAUDE_AUTO_MAKE_CONTEXT": make_stubs(root)["ok"],
                   "STUB_CALLS": os.path.join(root, "calls")}
            t = transcript(os.path.join(root, "synthetic.jsonl"), 150000)
            self.assertEqual(m.context_tokens(t), 150000)  # input + cache read + cache creation, not cumulative
            try:
                with mock.patch.dict(os.environ, env, clear=True):
                    for i in range(3):
                        payload = {"hook_event_name": "Stop", "session_id": "synthetic-%d" % i,
                                   "cwd": root, "transcript_path": t, "last_assistant_message": "synthetic"}
                        if i:
                            os.utime(marker, (1000, 1000))
                            with mock.patch.object(m.time, "time", return_value=1059.999):
                                self.assertIsNone(m.handle(payload))
                            self.assertEqual(os.path.getmtime(marker), 1000)
                            self.assertFalse(os.path.exists(os.path.join(run, "signal.json")))
                            with open(os.path.join(root, "auto.log")) as f:
                                self.assertIn("younger than 60s; skipped", f.read())
                        with mock.patch.object(m.time, "time", return_value=1060):
                            self.assertIsNotNone(m.handle(payload))
                        with open(os.path.join(run, "signal.json")) as f:
                            sig = json.load(f)
                        self.assertEqual((sig["session_id"], sig["tokens"]), (payload["session_id"], 150000))
                        self.assertTrue(os.path.exists(m.done_file(run, payload["session_id"])))
                        self.assertGreater(os.path.getmtime(marker), 1000)
                        os.remove(os.path.join(run, "signal.json"))  # wrapper consumed it
                        while m.HELD:
                            m.HELD.pop().close()  # hook process exited
                    with open(env["STUB_CALLS"]) as f:
                        self.assertEqual(len(f.readlines()), 3)
            finally:
                while m.HELD:
                    m.HELD.pop().close()


class BootstrapBudget(unittest.TestCase):
    def test_anchor_leaves_cooldown_free_and_three_forks_use_default_budgets(self):
        m = load()
        with tempfile.TemporaryDirectory() as root:
            run = os.path.join(root, "run")
            os.mkdir(run)
            marker = os.path.join(run, "last-handoff")
            env = {"CLAUDE_AUTO_DIR": root, "CLAUDE_AUTO_RUN": run,
                   "CLAUDE_AUTO_MAKE_CONTEXT": make_stubs(root)["ok"],
                   "STUB_CALLS": os.path.join(root, "calls")}
            def payload(sid, event, tokens):
                # Synthetic fork ancestry: an anchor request, current main request,
                # then a sidechain request that must not replace the main usage.
                path = os.path.join(root, sid + ".jsonl")
                records = [
                    {"type": "assistant", "uuid": "anchor", "message": {"usage": {"input_tokens": 5000}}},
                    {"type": "user", "uuid": "fork", "parentUuid": "anchor", "message": {"content": "synthetic fork"}},
                    {"type": "assistant", "parentUuid": "fork", "message": {"usage": {
                        "input_tokens": 5, "cache_read_input_tokens": tokens - 15, "cache_creation_input_tokens": 10}}},
                    {"type": "assistant", "isSidechain": True, "message": {"usage": {"input_tokens": 900000}}}]
                with open(path, "w") as f:
                    f.write("\n".join(json.dumps(r) for r in records) + "\n")
                self.assertEqual(m.context_tokens(path), tokens)
                return {"hook_event_name": event, "session_id": sid, "cwd": root, "transcript_path": path}
            try:
                with mock.patch.dict(os.environ, env, clear=True):
                    with mock.patch.dict(os.environ, {"CLAUDE_AUTO_BOOTSTRAP": "1"}):
                        self.assertIsNotNone(m.handle(payload("anchor", "Stop", 5000)))
                    with open(os.path.join(run, "signal.json")) as f:
                        self.assertEqual(json.load(f)["kind"], "anchor")
                    self.assertFalse(os.path.exists(marker))
                    self.assertFalse(os.path.exists(m.done_file(run, "anchor")))
                    self.assertTrue(m.cooled_down(run))
                    os.remove(os.path.join(run, "signal.json"))
                    for i, event in enumerate(("PreToolUse", "PostToolUse", "Stop")):
                        sid = "fork-%d" % i
                        limit = 120000 if event == "PreToolUse" else 150000
                        self.assertIsNone(m.handle(payload(sid, event, limit - 1)))
                        if i:
                            os.utime(marker, (1000, 1000))
                            with mock.patch.object(m.time, "time", return_value=1059.999):
                                self.assertIsNone(m.handle(payload(sid, event, limit)))
                            self.assertEqual(os.path.getmtime(marker), 1000)
                        with mock.patch.object(m.time, "time", return_value=1060):
                            result = m.handle(payload(sid, event, limit))
                        self.assertIsNotNone(result)
                        if event == "PreToolUse":
                            self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
                        with open(os.path.join(run, "signal.json")) as f:
                            sig = json.load(f)
                        self.assertEqual((sig["session_id"], sig["tokens"]), (sid, limit))
                        self.assertTrue(os.path.exists(m.done_file(run, sid)))
                        self.assertTrue(os.path.exists(marker))
                        os.remove(os.path.join(run, "signal.json"))
                        while m.HELD:
                            m.HELD.pop().close()
                    with open(env["STUB_CALLS"]) as f:
                        self.assertEqual(len(f.readlines()), 3)
            finally:
                while m.HELD:
                    m.HELD.pop().close()


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


class SessionFlags(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.m = load()

    def flags(self, recs, tail=1 << 20):
        p = os.path.join(self.tmp, "t.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            for r in recs:
                f.write((r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)) + "\n")
        return self.m.session_flags(p, tail)

    @staticmethod
    def a(model=None, effort=None, n=10, **kw):
        r = {"type": "assistant", "message": {"usage": {"input_tokens": n}}}
        if model is not None:
            r["requestedModel"] = model
        if effort is not None:
            r["effort"] = effort
        return dict(r, **kw)

    def test_cases(self):
        a = self.a
        cases = [
            ("last main-thread record wins", [a("m1", "low"), a("m2", "high")], {"model": "m2", "effort": "high"}),
            ("sidechain is ignored", [a("m1", "low"), a("sub", "max", isSidechain=True)], {"model": "m1", "effort": "low"}),
            ("record without usage is skipped", [a("m1", "low"), {"type": "assistant", "requestedModel": "syn"}],
             {"model": "m1", "effort": "low"}),
            ("zero usage is skipped", [a("m1", "low"), a("m2", "high", n=0)], {"model": "m1", "effort": "low"}),
            ("no effort on the last record", [a("m1", "low"), a("m2")], {"model": "m2"}),
            ("no model on the last record", [a("m1", "low"), a(None, "high")], {"effort": "high"}),
            ("a value that looks like a flag is dropped", [a("--dangerously-skip-permissions", "-x")], {}),
            ("empty or non-string values are dropped", [a("", 5)], {}),
            ("malformed last line", [a("m1", "low"), "{not json"], {"model": "m1", "effort": "low"}),
            ("non-assistant is ignored", [a("m1", "low"), {"type": "user", "requestedModel": "u", "message": {"usage": {"input_tokens": 9}}}],
             {"model": "m1", "effort": "low"}),
            ("empty", [], {}),
        ]
        for name, recs, want in cases:
            with self.subTest(name):
                self.assertEqual(self.flags(recs), want)

    def test_record_far_back_is_found_by_the_full_scan(self):
        filler = {"type": "user", "message": {"content": "é" * 200}}
        recs = [self.a("m1", "low")] + [filler] * 40
        for tail in (50, 333, 1000, 1 << 20):
            with self.subTest(tail=tail):
                self.assertEqual(self.flags(recs, tail), {"model": "m1", "effort": "low"})


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

    def test_pre_tool_guard_hands_off_before_a_large_result_is_admitted(self):
        root = os.path.join(self.tmp, "pretool")
        run = os.path.join(root, "run")
        os.makedirs(run)
        env = {"CLAUDE_AUTO_DIR": os.path.join(root, "base"), "CLAUDE_AUTO_TOKENS": "100000",
               "CLAUDE_AUTO_PRETOOL_MARGIN": "10000", "CLAUDE_AUTO_RUN": run,
               "CLAUDE_AUTO_MAKE_CONTEXT": self.stubs["ok"], "STUB_CALLS": os.path.join(root, "calls")}
        payload = {"hook_event_name": "PreToolUse", "session_id": "pre", "cwd": "/w", "tool_name": "Bash",
                   "tool_input": {"command": "command-that-could-return-a-lot"},
                   "transcript_path": transcript(os.path.join(root, "t.jsonl"), 90000)}
        with mock.patch.dict(os.environ, env):
            res = self.m.handle(payload)
        while self.m.HELD:
            self.m.HELD.pop().close()
        self.assertEqual(res, {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                        "permissionDecisionReason": mock.ANY}})
        self.assertIn("continuă în sesiunea nouă", res["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertTrue(os.path.isfile(json.load(open(os.path.join(run, "signal.json")))["handoff"]))
        self.assertEqual(len(open(env["STUB_CALLS"]).read().splitlines()), 1)
        self.assertFalse(os.path.exists(os.path.join(run, "pending")))

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

    def test_newest_plugin_copy_is_by_version_whatever_the_home_folder_is_called(self):
        for user in ("apana", "bob"):                            # a home folder named apana put every version at the same key
            home = os.path.join(self.tmp, "home-" + user, "Users", user)
            for v in ("0.1.2", "0.10.2", "0.1.0", "0.1.1", "0.9.9"):
                d = os.path.join(home, ".claude", "plugins", "cache", "apana-private", "apana", v, "skills", "compact-handoff", "scripts")
                os.makedirs(d)
                open(os.path.join(d, "make_context.py"), "w").close()
            with mock.patch.dict(os.environ, {"HOME": home}):
                os.environ.pop("CLAUDE_AUTO_MAKE_CONTEXT", None)
                found = self.m.find_make_context()
            self.assertIn("/apana/0.10.2/", found, user)         # 0.10.2 is newer than 0.9.9 and 0.1.2: compared as numbers

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


class Subagents(unittest.TestCase):
    """A subagent is not the session: its events never start a handoff, and a handoff waits for it to stop."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.stubs = make_stubs(cls.tmp)
        cls.m = load()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, True)

    def setUp(self):
        self.root = tempfile.mkdtemp(dir=self.tmp)
        self.run = os.path.join(self.root, "run")
        os.makedirs(self.run)
        self.calls = os.path.join(self.root, "calls")
        self.env = {"CLAUDE_AUTO_DIR": os.path.join(self.root, "base"), "CLAUDE_AUTO_TOKENS": "100000",
                    "CLAUDE_AUTO_RUN": self.run, "CLAUDE_AUTO_MAKE_CONTEXT": self.stubs["ok"], "STUB_CALLS": self.calls}
        self.tokens = 110000                # over the threshold (100000), under its ceiling (130000)

    def send(self, event, **extra):
        payload = dict({"hook_event_name": event, "session_id": "sess", "cwd": "/w", "tool_name": "Bash",
                        "tool_response": {"stdout": "files"},
                        "transcript_path": transcript(os.path.join(self.root, "t.jsonl"), self.tokens)}, **extra)
        with mock.patch.dict(os.environ, self.env):
            res = self.m.handle(payload)
        while self.m.HELD:
            self.m.HELD.pop().close()
        return res

    def made(self):
        return os.path.exists(os.path.join(self.run, "signal.json"))

    def marker(self, agent):
        return os.path.join(self.run, "agents", agent)

    def log(self):
        p = os.path.join(self.root, "base", "auto.log")
        return open(p).read() if os.path.exists(p) else ""

    def test_a_tool_call_of_a_subagent_never_starts_the_handoff(self):
        for event in ("PostToolUse", "Stop"):
            with self.subTest(event=event):
                self.assertIsNone(self.send(event, agent_id="a1", agent_type="general-purpose"))
        self.assertFalse(self.made())
        self.assertFalse(os.path.exists(self.calls), "make_context ran for a subagent's event")
        self.assertFalse(os.path.exists(os.path.join(self.run, "pending")), "a subagent's event was kept as pending")
        self.assertTrue(os.path.exists(self.marker("a1")))

    def test_the_session_waits_for_a_running_subagent_and_hands_off_when_it_stops(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("PostToolUse", tool_name="Agent", tool_response={"isAsync": True, "agentId": "a1"})      # launched in the background
        self.assertTrue(os.path.exists(self.marker("a1")))
        for event in ("PostToolUse", "Stop", "PostToolUse"):
            self.assertIsNone(self.send(event))
        self.assertFalse(self.made())
        self.assertEqual(self.log().count("handoff deferred"), 1, self.log())      # one line, not one per event
        self.send("SubagentStop", agent_id="a1")
        self.assertEqual(os.path.getmtime(self.marker("a1")), 0)          # kept as an old file: it no longer holds anything
        res = self.send("PostToolUse")
        self.assertIs(res["continue"], False)
        self.assertTrue(self.made())

    def test_every_running_subagent_holds_the_handoff_back(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("SubagentStart", agent_id="a2")
        self.send("SubagentStop", agent_id="a1")
        self.assertIsNone(self.send("PostToolUse"))
        self.assertFalse(self.made())
        self.send("SubagentStop", agent_id="a2")
        self.send("PostToolUse")
        self.assertTrue(self.made())

    def test_a_subagent_that_went_quiet_without_stopping_stops_holding_it_back(self):
        self.send("SubagentStart", agent_id="a1")
        old = time.time() - 1000
        os.utime(self.marker("a1"), (old, old))
        self.send("PostToolUse")
        self.assertTrue(self.made())
        os.remove(os.path.join(self.run, "signal.json"))
        self.env["CLAUDE_AUTO_AGENT_IDLE"] = "2000"      # the limit is a setting
        for name in ("done-sess", "last-handoff"):
            os.remove(os.path.join(self.run, name))
        self.send("PostToolUse")
        self.assertFalse(self.made())

    def test_each_tool_call_of_a_subagent_keeps_it_marked_as_running(self):
        self.send("SubagentStart", agent_id="a1")
        old = time.time() - 1000
        os.utime(self.marker("a1"), (old, old))
        self.send("PostToolUse", agent_id="a1")
        self.assertLess(time.time() - os.path.getmtime(self.marker("a1")), 5)
        self.send("PostToolUse")
        self.assertFalse(self.made())

    def test_a_late_stop_of_a_resumed_subagent_is_healed_by_its_next_tool_call(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("SubagentStop", agent_id="a1")          # arrives after the resumed run started: the marker is gone while it works
        self.assertFalse(os.path.exists(self.marker("a1")))
        self.send("PostToolUse", agent_id="a1")            # its next tool call marks it again
        self.assertTrue(os.path.exists(self.marker("a1")))
        self.assertIsNone(self.send("PostToolUse"))
        self.assertFalse(self.made())

    def test_launching_a_background_subagent_marks_it_before_its_own_start_event_arrives(self):
        launched = {"isAsync": True, "status": "async_launched", "agentId": "a9", "description": "x"}
        self.assertIsNone(self.send("PostToolUse", tool_name="Agent", tool_response=launched))      # over the threshold
        self.assertFalse(self.made())
        self.assertTrue(os.path.exists(self.marker("a9")))
        self.send("SubagentStop", agent_id="a9")
        for resp in ({"isAsync": True, "agentId": 5}, {"isAsync": False, "agentId": "a8"}, {"agentId": "a8"}, "text", None):
            with self.subTest(resp=resp):
                self.send("PostToolUse", tool_response=resp)
                self.assertFalse(os.path.exists(self.marker("a8")))
                self.assertTrue(self.made())          # nothing was marked: the session handed off
                os.remove(os.path.join(self.run, "signal.json"))
                for name in ("done-sess", "last-handoff"):
                    os.remove(os.path.join(self.run, name))

    # SendMessage to a subagent that has finished: the payloads of a real run (claude 2.1.303, haiku)
    RESUME = {"tool_name": "SendMessage", "tool_input": {"to": "a1", "message": "again"},
              "tool_response": {"success": True, "message": "Resuming agent a1", "resumedAgentId": "a1"}}

    def test_a_resume_whose_start_event_arrives_before_the_send_message_event_holds_the_handoff_back(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("SubagentStop", agent_id="a1")
        self.send("SubagentStart", agent_id="a1")                          # the resumed run
        self.assertIsNone(self.send("PostToolUse", **self.RESUME))
        self.assertFalse(self.made())

    def test_a_resume_whose_send_message_event_arrives_before_its_start_event_does_not_lose_the_subagent(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("SubagentStop", agent_id="a1")
        self.assertIsNone(self.send("PostToolUse", **self.RESUME))        # SubagentStart of the resumed run comes after it
        self.assertFalse(self.made())

    def test_a_subagent_ended_with_task_stop_does_not_hold_the_handoff_back(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("PostToolUse", tool_name="TaskStop", tool_input={"task_id": "a1"},
                  tool_response={"message": "Successfully stopped task: a1 (x)", "task_id": "a1", "task_type": "local_agent"})
        self.assertTrue(self.made())

    def test_task_stop_and_send_message_cannot_touch_anything_outside_the_agents_folder(self):
        open(os.path.join(self.run, "x"), "w").close()
        self.send("PostToolUse", tool_name="SendMessage", tool_response={"resumedAgentId": "../y"})
        self.assertFalse(os.path.exists(os.path.join(self.run, "y")))
        self.assertEqual(os.listdir(os.path.join(self.run, "agents")), ["y"])      # the name is cleaned, inside agents/
        self.send("PostToolUse", tool_name="TaskStop", tool_input={"task_id": "../x"}, tool_response={"task_id": "../x"})
        self.assertTrue(os.path.exists(os.path.join(self.run, "x")))
        self.assertFalse(self.made())      # y still holds the handoff back

    def test_send_message_marks_only_a_resumed_subagent_and_task_stop_only_what_it_names(self):
        self.send("SubagentStart", agent_id="a1")
        for resp in ({"success": True, "message": "Message sent"}, {"resumedAgentId": 5}, "text", None):
            with self.subTest(resp=resp):
                self.send("PostToolUse", tool_name="SendMessage", tool_response=resp)
                self.assertEqual(os.listdir(os.path.join(self.run, "agents")), ["a1"])
        self.send("PostToolUse", tool_name="SendMessage", tool_response={"resumedAgentId": "a2"}, tool_input={"task_id": "a1"})
        self.assertEqual(sorted(os.listdir(os.path.join(self.run, "agents"))), ["a1", "a2"])      # a SendMessage never unmarks
        self.send("PostToolUse", tool_name="TaskStop", tool_input={"task_id": "a2"}, tool_response={"task_id": "a2"})
        self.assertEqual(os.listdir(os.path.join(self.run, "agents")), ["a1"])
        self.send("PostToolUse", tool_name="Bash", tool_input={"task_id": "a1"}, tool_response={"task_id": "a1"})
        self.assertEqual(os.listdir(os.path.join(self.run, "agents")), ["a1"])      # only TaskStop unmarks

    # A foreground subagent cannot outlive the turn of the session; Esc ends it with no SubagentStop (live, claude 2.1.303,
    # haiku: the marker stayed and the handoff was deferred for the whole run, n=2). A background one outlives the turn.
    LAUNCHED = {"isAsync": True, "status": "async_launched", "agentId": "a9", "description": "x"}

    def test_the_stop_of_the_session_ends_a_foreground_subagent_that_never_sent_its_stop(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("PostToolUse", agent_id="a1")
        res = self.send("Stop")                       # the answer to the message typed after Esc
        self.assertTrue(self.made())
        self.assertFalse(os.path.exists(self.marker("a1")))
        self.assertIn("systemMessage", res)

    def test_the_stop_of_the_session_does_not_end_a_background_subagent(self):
        self.send("SubagentStart", agent_id="a9")
        self.send("PostToolUse", tool_name="Agent", tool_response=self.LAUNCHED)
        self.assertIsNone(self.send("Stop"))
        self.assertFalse(self.made())
        self.assertTrue(os.path.exists(self.marker("a9")))
        self.send("SubagentStop", agent_id="a9")
        self.send("Stop")
        self.assertTrue(self.made())

    def test_the_stop_of_the_session_ends_only_the_foreground_ones(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("PostToolUse", tool_name="Agent", tool_response=self.LAUNCHED)
        self.assertIsNone(self.send("Stop"))
        self.assertEqual(os.listdir(os.path.join(self.run, "agents")), ["a9"])

    def test_the_stop_of_the_session_does_not_end_a_resumed_subagent_whose_late_stop_removed_its_marker(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("PostToolUse", **self.RESUME)
        self.send("SubagentStop", agent_id="a1")          # arrives after the resumed run started
        self.send("PostToolUse", agent_id="a1")            # its next tool call heals the marker
        self.assertIsNone(self.send("Stop"))
        self.assertFalse(self.made())

    def test_the_stop_of_a_subagent_is_not_the_stop_of_the_session(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("Stop", agent_id="a2")
        self.assertTrue(os.path.exists(self.marker("a1")))
        self.assertFalse(self.made())

    def test_the_wait_has_a_ceiling_in_tokens(self):
        self.send("SubagentStart", agent_id="a1")
        self.tokens = 129999
        self.send("PostToolUse")
        self.assertFalse(self.made())
        self.tokens = 130000                  # threshold 100000 + 30000
        self.send("PostToolUse")
        self.assertTrue(self.made())
        self.assertIn("handing off anyway", self.log())

    def test_the_wait_can_be_switched_off_and_a_setting_that_is_not_a_number_means_the_default(self):
        for setting, handed_off in (({"CLAUDE_AUTO_DEFER_EXTRA": "0"}, True), ({"CLAUDE_AUTO_AGENT_IDLE": "0"}, True),
                                    ({"CLAUDE_AUTO_DEFER_EXTRA": "abc"}, False), ({"CLAUDE_AUTO_AGENT_IDLE": "abc"}, False)):
            with self.subTest(setting=setting):
                self.env.update(setting)
                self.send("SubagentStart", agent_id="a1")
                self.send("PostToolUse")
                self.assertEqual(self.made(), handed_off)
                for name in ("signal.json", "done-sess", "last-handoff"):
                    if os.path.exists(os.path.join(self.run, name)):
                        os.remove(os.path.join(self.run, name))
                shutil.rmtree(os.path.join(self.run, "agents"), True)
                for key in setting:
                    self.env.pop(key)

    def test_a_subagent_event_after_the_handoff_was_decided_is_not_kept_as_pending(self):
        open(os.path.join(self.run, "signal.json"), "w").write("{}")
        self.send("PostToolUse")                                  # the session's own event: kept, it is not in the transcript
        self.send("PostToolUse", agent_id="a1")                   # a subagent's: never in the session's transcript, not kept
        self.send("Stop", agent_id="a1")
        self.assertEqual(len(os.listdir(os.path.join(self.run, "pending"))), 1)

    def test_a_session_without_subagents_hands_off_as_before(self):
        self.send("SubagentStart", agent_id="a1")
        self.send("SubagentStop", agent_id="a1")
        self.send("SubagentStop", agent_id="never-started")      # no marker: nothing to fail on
        self.send("PostToolUse")
        self.assertTrue(self.made())

    def test_an_agent_id_that_is_not_a_name_cannot_reach_outside_the_run_folder(self):
        for agent in (7, ["a"], "../../x", "/etc/x"):
            with self.subTest(agent=agent):
                self.send("SubagentStart", agent_id=agent)
                self.send("SubagentStop", agent_id=agent)
                self.send("PostToolUse", agent_id=agent)
        self.assertFalse(self.made())
        self.assertEqual(sorted(os.listdir(self.run)), ["agents"] if os.path.isdir(os.path.join(self.run, "agents")) else [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "x")))

    def test_nothing_happens_outside_a_claude_auto_run(self):
        self.env.pop("CLAUDE_AUTO_RUN")
        self.assertIsNone(self.send("SubagentStart", agent_id="a2"))
        self.assertFalse(os.path.exists(self.marker("a2")))


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
        for tokens, handoff in ((99999, False), (100000, False), (149999, False), (150000, True)):
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
    rec["cooperation"] = {key: value for key, value in os.environ.items() if key.startswith("CLAUDE_AUTO_COOP")}
    if "--settings" in sys.argv:
        rec["settings"] = open(sys.argv[sys.argv.index("--settings") + 1]).read()
    if os.isatty(0):
        rec["lflag"] = termios.tcgetattr(0)[3]
        rec["echo_icanon"] = bool(rec["lflag"] & termios.ECHO and rec["lflag"] & termios.ICANON)
    rec["run_files"] = sorted(os.listdir(rec["run"])) if rec["run"] and os.path.isdir(rec["run"]) else None
    json.dump(rec, open(os.path.join(state, "call-%d" % n), "w"))

    def fire(sid):
        t = os.path.join(state, "t%d.jsonl" % n)
        last = {"type": "assistant", "message": {"usage": {"input_tokens": 150000}}}
        if os.environ.get("FAKE_MODEL"):
            last["requestedModel"] = os.environ["FAKE_MODEL"]
        if os.environ.get("FAKE_EFFORT"):
            last["effort"] = os.environ["FAKE_EFFORT"]
        open(t, "w").write(json.dumps(last) + "\\n")
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
    elif mode == "handoff_after_subagents":
        if n == 0:   # a subagent whose SubagentStop never came (old marker, so it does not hold the handoff back) and the deferral line
            os.makedirs(os.path.join(rec["run"], "agents"))
            marker = os.path.join(rec["run"], "agents", "a1")
            open(marker, "w").close()
            os.utime(marker, (1, 1))
            open(os.path.join(rec["run"], "deferred"), "w").write("a1")
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
    elif mode == "bootstrap":
        if n == 0:
            fire("anchor-123")
            time.sleep(60)
    elif mode == "bootstrap_then_handoff":
        if n == 0:
            fire("anchor-123")
            time.sleep(60)
        elif n == 1:
            fire("work-456")
            time.sleep(60)
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
                        CLAUDE_AUTO_COOLDOWN="0", CLAUDE_AUTO_BOOTSTRAP="0", FAKE_CWD=self.cwd2)
        for k in ("CLAUDE_AUTO_RUN", "CLAUDE_AUTO_NEXT_ARGS", "CLAUDE_AUTO_MAX", "CLAUDE_AUTO_TOKENS"):
            self.env.pop(k, None)
        for key in list(self.env):
            if key.startswith("CLAUDE_AUTO_COOP"):
                self.env.pop(key)
        self.env["CLAUDE_AUTO_RULE"] = "off"       # the tests below pin positions in argv; SystemPromptRule tests the rule

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

    def cooperation_plugin(self):
        plugin = os.path.join(os.path.dirname(os.path.realpath(self.auto)), "cooperation")
        os.makedirs(os.path.join(plugin, ".claude-plugin"))
        os.makedirs(os.path.join(plugin, "scripts"))
        os.makedirs(os.path.join(plugin, "hooks"))
        os.makedirs(os.path.join(plugin, "types"))
        with open(os.path.join(plugin, "types", "index.d.ts"), "w") as f:
            f.write("// persistent state contract\n")
        for name in ("hooks.json", "register.ts"):
            with open(os.path.join(plugin, "hooks", name), "w") as f:
                f.write("{}")
        with open(os.path.join(plugin, ".claude-plugin", "plugin.json"), "w") as f:
            json.dump({"name": "cooperation"}, f)
        write_script(os.path.join(plugin, "scripts", "registry.py"), '''
            import json, os, sys
            with open(os.path.join(os.environ["FAKE_STATE"], "closed"), "w") as f:
                json.dump({"db": sys.argv[1], "request": json.load(sys.stdin), "isolated": sys.flags.isolated}, f)
        ''')
        return plugin

    def test_cooperation_real_children_keep_member_and_advance_generation(self):
        import uuid
        plugin = self.cooperation_plugin()
        db = os.path.join(self.tmp, "registry.sqlite3")
        result = self.wrap("task", FAKE_MODE="chain", CLAUDE_AUTO_COOPERATE="1",
                           CLAUDE_AUTO_COOP_DB=db, CLAUDE_AUTO_COOP_MEMBER="inherited",
                           CLAUDE_AUTO_COOP_GENERATION="90", CLAUDE_AUTO_COOP_CONTINUATION="1",
                           CLAUDE_AUTO_MAX="2")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 3)
        member = calls[0]["cooperation"]["CLAUDE_AUTO_COOP_MEMBER"]
        self.assertEqual(str(uuid.UUID(member)), member)
        self.assertNotEqual(member, "inherited")
        for generation, call in enumerate(calls, 1):
            env = call["cooperation"]
            self.assertEqual(env["CLAUDE_AUTO_COOP_MEMBER"], member)
            self.assertEqual(env["CLAUDE_AUTO_COOP_GENERATION"], str(generation))
            self.assertEqual(env["CLAUDE_AUTO_COOP_DB"], db)
            self.assertEqual(env.get("CLAUDE_AUTO_COOP_CONTINUATION"), "1" if generation > 1 else None)
            at = call["argv"].index("--plugin-dir")
            self.assertEqual(call["argv"][at + 1], plugin)
        self.assertEqual(calls[0]["run"], calls[1]["run"])
        self.assertIsNone(calls[-1]["run"], "Cooperation survives the handoff limit")
        with open(os.path.join(self.state, "closed")) as f:
            self.assertEqual(json.load(f), {"db": db, "request": {"op": "close", "member": member, "generation": 3}, "isolated": 1})
        self.assertEqual(self.run_folders(), [])

    def test_cooperation_bootstrap_is_not_a_member_or_continuation(self):
        self.cooperation_plugin()
        result = self.wrap("task", FAKE_MODE="bootstrap_then_handoff", CLAUDE_AUTO_BOOTSTRAP="1",
                           CLAUDE_AUTO_COOPERATE="1", CLAUDE_AUTO_COOP_MEMBER="inherited",
                           CLAUDE_AUTO_COOP_GENERATION="90", CLAUDE_AUTO_COOP_CONTINUATION="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        bootstrap, work, continuation = self.calls()
        self.assertEqual(bootstrap["cooperation"], {})
        self.assertNotIn("--plugin-dir", bootstrap["argv"])
        self.assertEqual(work["cooperation"]["CLAUDE_AUTO_COOP_GENERATION"], "1")
        self.assertNotIn("CLAUDE_AUTO_COOP_CONTINUATION", work["cooperation"])
        self.assertEqual(continuation["cooperation"]["CLAUDE_AUTO_COOP_GENERATION"], "2")
        self.assertEqual(continuation["cooperation"]["CLAUDE_AUTO_COOP_CONTINUATION"], "1")
        self.assertEqual(work["cooperation"]["CLAUDE_AUTO_COOP_MEMBER"], continuation["cooperation"]["CLAUDE_AUTO_COOP_MEMBER"])

    def test_cooperation_initial_interactive_and_resume_prompts_are_not_continuations(self):
        self.cooperation_plugin()
        members = set()
        for args in ([], ["--resume", "existing"], ["--resume=existing", "new task"]):
            with self.subTest(args=args):
                shutil.rmtree(self.state), os.makedirs(self.state)
                result = self.wrap(*args, FAKE_MODE="exit7", CLAUDE_AUTO_COOPERATE="1",
                                   CLAUDE_AUTO_COOP_CONTINUATION="1", HOME=self.tmp)
                self.assertEqual(result.returncode, 7, result.stderr)
                env = self.calls()[0]["cooperation"]
                self.assertNotIn("CLAUDE_AUTO_COOP_CONTINUATION", env)
                self.assertEqual(env["CLAUDE_AUTO_COOP_GENERATION"], "1")
                self.assertEqual(env["CLAUDE_AUTO_COOP_DB"], os.path.join(self.tmp, ".claude/cooperation/registry.sqlite3"))
                members.add(env["CLAUDE_AUTO_COOP_MEMBER"])
        self.assertEqual(len(members), 3)

    def test_cooperation_missing_plugin_fails_only_for_opted_in_interactive(self):
        result = self.wrap("task", CLAUDE_AUTO_COOPERATE="1")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("cooperation", result.stderr)
        self.assertIn("nothing was started", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.run_folders(), [])
        result = self.wrap("task", FAKE_MODE="exit7")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertNotIn("--plugin-dir", self.calls()[0]["argv"])
        self.assertFalse(os.path.exists(os.path.join(self.state, "closed")))

    def test_cooperation_missing_state_contract_fails_before_launch(self):
        plugin = self.cooperation_plugin()
        os.remove(os.path.join(plugin, "types", "index.d.ts"))
        result = self.wrap("task", FAKE_MODE="exit7", CLAUDE_AUTO_COOPERATE="1")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("types/index.d.ts", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_cooperation_passthrough_stays_unchanged_without_plugin(self):
        for args in (["-p", "task"], ["--print", "task"], ["--version"], ["mcp", "list"]):
            with self.subTest(args=args):
                shutil.rmtree(self.state), os.makedirs(self.state)
                result = self.wrap(*args, FAKE_MODE="exit7", CLAUDE_AUTO_COOPERATE="1")
                self.assertEqual(result.returncode, 7, result.stderr)
                self.assertEqual(self.calls()[0]["argv"], args)
                self.assertNotIn("CLAUDE_AUTO_COOP_MEMBER", self.calls()[0]["cooperation"])
                self.assertEqual(self.run_folders(), [])

    def test_cooperation_rejects_relative_database_before_launch(self):
        self.cooperation_plugin()
        result = self.wrap("task", CLAUDE_AUTO_COOPERATE="1", CLAUDE_AUTO_COOP_DB="relative.sqlite3")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("absolute", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.run_folders(), [])

    def test_cooperation_cleanup_failure_preserves_child_exit(self):
        plugin = self.cooperation_plugin()
        write_script(os.path.join(plugin, "scripts", "registry.py"), 'raise RuntimeError("cleanup failed")')
        result = self.wrap("task", FAKE_MODE="exit7", CLAUDE_AUTO_COOPERATE="1")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(self.run_folders(), [])

    def test_exit_code_passes_through_and_nothing_is_relaunched(self):
        r = self.wrap("--model", "opus", FAKE_MODE="exit7")
        self.assertEqual(r.returncode, 7, r.stderr)
        c = self.calls()
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0]["argv"][0], "--settings")
        self.assertEqual(c[0]["argv"][2:], ["--model", "opus"])
        self.assertTrue(c[0]["run"] and c[0]["run"].startswith(self.base))
        self.assertEqual([d for d in os.listdir(self.base) if d.startswith("run-")], [])      # run folder removed

    def second_launch(self, *args, **env):
        r = self.wrap(*args, FAKE_MODE="handoff", **env)
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()
        self.assertEqual(len(c), 2, r.stderr)
        return c[1]["argv"][2:-2]

    def test_handoff_keeps_the_model_and_effort_of_the_closed_session(self):
        # started without flags, changed with /model and /effort later: the transcript is the only place that knows
        self.assertEqual(self.second_launch("do the task", FAKE_MODEL="claude-opus-5-5", FAKE_EFFORT="high"),
                         ["--model", "claude-opus-5-5", "--effort", "high"])

    def test_handoff_replaces_the_model_and_effort_of_the_first_command(self):
        for first in (["--model", "opus", "--effort", "low"], ["--model=opus", "--effort=low"]):
            with self.subTest(first=first):
                shutil.rmtree(self.state), os.makedirs(self.state)
                self.assertEqual(
                    self.second_launch(*first, "--verbose", FAKE_MODEL="claude-sonnet-5-5", FAKE_EFFORT="max"),
                    ["--verbose", "--model", "claude-sonnet-5-5", "--effort", "max"])

    def test_handoff_keeps_the_first_command_when_the_transcript_has_no_model_or_effort(self):
        self.assertEqual(self.second_launch("--model", "opus", "--effort", "low"), ["--model", "opus", "--effort", "low"])
        shutil.rmtree(self.state), os.makedirs(self.state)
        self.assertEqual(self.second_launch("--model", "opus", FAKE_EFFORT="high"), ["--model", "opus", "--effort", "high"])

    def test_explicit_next_args_win_over_the_closed_session(self):
        self.assertEqual(self.second_launch("--model", "opus", CLAUDE_AUTO_NEXT_ARGS="--model haiku",
                                            FAKE_MODEL="claude-sonnet-5-5", FAKE_EFFORT="high"), ["--model", "haiku"])

    def test_settings_file_has_the_hooks_with_a_quoted_command(self):
        self.wrap(FAKE_MODE="exit7")
        s = json.loads(self.calls()[0]["settings"])
        self.assertEqual(sorted(s["hooks"]), ["PostToolUse", "PreToolUse", "Stop", "SubagentStart", "SubagentStop"])
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

    def test_what_the_subagents_left_in_the_run_folder_does_not_reach_the_next_session(self):
        r = self.wrap("do the task", FAKE_MODE="handoff_after_subagents")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()
        self.assertEqual(len(c), 2, r.stderr)               # the old marker did not hold the handoff back
        self.assertEqual(c[0]["run"], c[1]["run"])          # the run folder is shared by the chained sessions
        for leftover in ("agents", "deferred"):
            self.assertNotIn(leftover, c[1]["run_files"])

    def run_folders(self):
        return [d for d in os.listdir(self.base) if d.startswith("run-")]

    def test_budget_hooks_survive_bootstrap_and_explicit_anchor_continuations(self):
        cases = (("bootstrap_then_handoff", {"CLAUDE_AUTO_BOOTSTRAP": "1"}, 3),
                 ("handoff", {"CLAUDE_AUTO_ANCHOR_ID": "anchor-123"}, 2))
        for mode, env, expected in cases:
            with self.subTest(mode=mode):
                shutil.rmtree(self.state), os.makedirs(self.state)
                result = self.wrap("--model", "sonnet", "task", FAKE_MODE=mode, **env)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = self.calls()
                self.assertEqual(len(calls), expected)
                for call in calls:
                    hooks = json.loads(call["settings"])["hooks"]
                    self.assertTrue({"Stop", "PostToolUse", "PreToolUse"}.issubset(hooks))
                    command = hooks["Stop"][0]["hooks"][0]["command"]
                    for event in ("PostToolUse", "PreToolUse"):
                        self.assertEqual(hooks[event][0]["matcher"], "*")
                        self.assertEqual(hooks[event][0]["hooks"][0]["command"], command)

    def test_handoff_can_fork_a_configured_immutable_anchor(self):
        r = self.wrap("--model", "opus", "do the task", FAKE_MODE="handoff", CLAUDE_AUTO_ANCHOR_ID="anchor-123")
        self.assertEqual(r.returncode, 0, r.stderr)
        second = self.calls()[1]["argv"]
        self.assertEqual(second[2:-2], ["--model", "opus", "--resume", "anchor-123", "--fork-session"])
        self.assertEqual(second[-2], "--")
        self.assertIn("HANDOFF.md", second[-1])

    def test_default_bootstrap_keeps_delimited_prefix_arguments(self):
        args = ["--model", "opus", "--mcp-config", "/mcp.json", "--plugin-dir", "/plugin", "--add-dir", "/src", "--", "do work"]
        r = self.wrap(*args, FAKE_MODE="bootstrap", CLAUDE_AUTO_BOOTSTRAP="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()
        prefix = args[:-2]
        self.assertEqual(c[0]["argv"][2:-2], prefix)
        self.assertEqual(c[1]["argv"][2:-2], prefix + ["--resume", "anchor-123", "--fork-session"])
        self.assertEqual(c[1]["argv"][-2:], ["--", "do work"])

    def test_bootstrap_keeps_plain_prompt_without_flag_values(self):
        r = self.wrap("--model", "sonnet", "task", FAKE_MODE="bootstrap", CLAUDE_AUTO_BOOTSTRAP="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls()[1]["argv"][-1], "task")

    def test_stop_in_the_bootstrapped_work_session_creates_a_normal_handoff(self):
        r = self.wrap("--model", "sonnet", "task", FAKE_MODE="bootstrap_then_handoff", CLAUDE_AUTO_BOOTSTRAP="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()
        self.assertEqual(len(c), 3, r.stderr)
        self.assertEqual(c[2]["argv"][2:-2], ["--model", "sonnet", "--resume", "anchor-123", "--fork-session"])
        self.assertEqual(c[2]["argv"][-2], "--")
        self.assertIn("HANDOFF.md", c[2]["argv"][-1])

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

    def test_automatic_resume_preserves_the_users_response_format(self):
        for count in (0, 1, 12, 13):
            with self.subTest(pending=count):
                prompt = self.m.new_session_prompt({
                    "handoff": "/n/HANDOFF.md", "tokens": 151000,
                    "pending": ["/n/pending/f%d.txt" % i for i in range(count)],
                })
                self.assertIn("reia imediat lucrul", prompt)
                self.assertIn("Dacă pasul următor este ireversibil sau cere decizia mea", prompt)
                self.assertTrue(prompt.endswith(
                    "Aceasta este continuarea aceleiași sarcini, nu o cerere de rezumat al transferului. "
                    "Păstrează cerințele utilizatorului pentru răspunsul final, inclusiv formatul exact. "
                    "Dacă utilizatorul a cerut doar un anumit text, răspunsul final conține numai acel text, "
                    "fără rezumat, explicații sau raport suplimentar despre transfer."))

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
        self.assertEqual(sorted(plain["hooks"]), ["PostToolUse", "PreToolUse", "Stop", "SubagentStart", "SubagentStop"])
        user = {"env": {"A": "1"}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "u"}]}],
                                              "PreToolUse": [{"matcher": "Bash", "hooks": []}], "PostToolUse": "oops"}}
        self.m.write_settings(p, user)
        s = json.load(open(p))
        self.assertEqual(s["env"], {"A": "1"})
        self.assertEqual(s["hooks"]["PreToolUse"][0], user["hooks"]["PreToolUse"][0])
        self.assertEqual(len(s["hooks"]["PreToolUse"]), 2)
        self.assertEqual(s["hooks"]["PreToolUse"][1]["matcher"], "*")
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


class ResumeFlags(unittest.TestCase):
    """A session picked with --resume, --continue and the like starts as typed, and no later session of the run picks it again."""
    wrap, calls = Wrapper.wrap, Wrapper.calls
    PICKS = (["--resume", "s-1"], ["-r", "s-1"], ["--resume=s-1"], ["--resume"], ["-c"], ["--continue"],
             ["--from-pr", "12"], ["--from-pr=12"], ["--teleport", "t-1"], ["--session-id", "11111111-2222-3333-4444-555555555555"])

    def setUp(self):
        Wrapper.setUp(self)
        self.env["CLAUDE_AUTO_BOOTSTRAP"] = "1"       # the default: a warm-up session first, unless the user picks a session

    def fresh_state(self):
        shutil.rmtree(self.state)
        os.makedirs(self.state)

    def test_selects_session_and_session_args(self):
        m = load()
        for args, picks, kept in (
                ([], False, []), (["fix the bug"], False, []), (["--model", "opus"], False, ["--model", "opus"]),
                (["--resume", "s-1"], True, []), (["--model", "opus", "-r", "s-1"], True, ["--model", "opus"]),
                (["--resume=s-1", "--verbose"], True, ["--verbose"]), (["--resume"], True, []), (["-c", "--chrome"], True, ["--chrome"]),
                (["--from-pr", "12"], True, []), (["--session-id", "u"], True, []), (["--teleport"], True, []),
                (["--", "--resume", "s-1"], False, []), (["--model", "opus", "--", "-c"], False, ["--model", "opus"])):
            with self.subTest(args=args):
                self.assertEqual(m.selects_session(args), picks)
                self.assertEqual(m.session_args(args), kept)
        # the delimited form keeps every other flag, and the optional value of the picking flag goes with it
        self.assertEqual(m.session_args(["--add-dir", "/src", "--resume", "s-1", "--model", "opus", "--", "go"]),
                         ["--add-dir", "/src", "--model", "opus"])
        self.assertEqual(m.session_args(["--resume", "--model", "opus", "--", "go"]), ["--model", "opus"])

    def test_the_first_run_gets_the_picking_flags_as_typed_with_the_default_bootstrap(self):
        for picks in self.PICKS:
            for args in (picks, ["--model", "opus"] + picks, picks + ["--model", "opus"], picks + ["--", "go on"]):
                with self.subTest(args=args):
                    self.fresh_state()
                    r = self.wrap(*args)
                    self.assertEqual(r.returncode, 0, r.stderr)
                    c = self.calls()
                    self.assertEqual(len(c), 1, r.stderr)
                    self.assertEqual(c[0]["argv"][2:], args)

    def test_the_handoff_after_a_picked_session_starts_a_new_one_with_the_note(self):
        for picks in self.PICKS:
            for args in (["--model", "opus"] + picks, ["--model", "opus"] + picks + ["--", "go on"]):
                with self.subTest(args=args):
                    self.fresh_state()
                    r = self.wrap(*args, FAKE_MODE="handoff")
                    self.assertEqual(r.returncode, 0, r.stderr)
                    c = self.calls()
                    self.assertEqual(len(c), 2, r.stderr)
                    self.assertEqual(c[0]["argv"][2:], args)
                    self.assertEqual(c[1]["argv"][2:-2], ["--model", "opus"])
                    self.assertEqual(c[1]["argv"][-2], "--")
                    self.assertIn("HANDOFF.md", c[1]["argv"][-1])

    def test_resume_fork_is_kept_only_on_the_first_launch(self):
        for delimited in (False, True):
            for fork in (False, True):
                with self.subTest(delimited=delimited, fork=fork):
                    self.fresh_state()
                    args = ["--model", "opus", "--resume", "s-1"]
                    if fork:
                        args += ["--fork-session"]
                    if delimited:
                        args += ["--", "go on"]
                    r = self.wrap(*args, FAKE_MODE="handoff")
                    self.assertEqual(r.returncode, 0, r.stderr)
                    c = self.calls()
                    self.assertEqual(len(c), 2, r.stderr)
                    self.assertEqual(c[0]["argv"][2:], args)
                    self.assertEqual(c[1]["argv"][2:-2], ["--model", "opus"])
                    self.assertIn("HANDOFF.md", c[1]["argv"][-1])

    def test_a_prompt_that_looks_like_a_picking_flag_keeps_the_bootstrap(self):
        r = self.wrap("--model", "sonnet", "--", "--resume", FAKE_MODE="bootstrap")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()
        self.assertEqual(len(c), 2, r.stderr)
        self.assertEqual(c[0]["argv"][2:], ["--model", "sonnet", "--", "Răspunde exact: ANCHOR_READY"])
        self.assertEqual(c[1]["argv"][2:], ["--model", "sonnet", "--resume", "anchor-123", "--fork-session", "--", "--resume"])


class SystemPromptRule(unittest.TestCase):
    """The variant-check rule appended to the system prompt of every session claude-auto starts."""
    wrap, calls = Wrapper.wrap, Wrapper.calls

    def setUp(self):
        Wrapper.setUp(self)
        self.env.pop("CLAUDE_AUTO_RULE", None)       # the default: on

    def test_rule_args_for_every_switch_and_own_flag(self):
        # t = 2 over the only two inputs, exhaustive (6 x 5 = 30 cases): the switch and the user's own system prompt flag
        m = load()
        rule = ["--append-system-prompt", m.VARIANT_RULE]
        own = [([], False), (["--append-system-prompt", "mine"], True), (["--append-system-prompt=mine"], True),
               (["--append-system-prompt-file", "f.txt"], True),
               (["--", "--append-system-prompt", "mine"], False)]      # after `--` it is prompt text, not a flag
        for switch, off in ((None, False), ("on", False), ("ON", False), ("off", True), ("OFF", True), ("0", True)):
            for flags, has_own in own:
                with self.subTest(switch=switch, flags=flags), mock.patch.dict(os.environ):
                    os.environ.pop("CLAUDE_AUTO_RULE", None)
                    if switch is not None:
                        os.environ["CLAUDE_AUTO_RULE"] = switch
                    self.assertEqual(m.rule_args(["--model", "opus"] + flags), [] if off or has_own else rule)
        with mock.patch.dict(os.environ):                              # the flag may be in either list of a run
            os.environ.pop("CLAUDE_AUTO_RULE", None)
            self.assertEqual(m.rule_args(["--model", "opus"], ["--append-system-prompt", "mine"]), [])
            self.assertEqual(m.rule_args(["--append-system-prompt", "mine"], []), [])
            self.assertEqual(m.rule_args(["--model", "opus"], []), rule)

    def test_every_session_gets_the_rule_before_the_flags_and_the_prompt(self):
        m = load()
        self.wrap("--model", "opus", "do the task", FAKE_MODE="handoff")
        c = self.calls()
        self.assertEqual(len(c), 2)
        for call in c:
            self.assertEqual(call["argv"][0], "--settings")
            self.assertEqual(call["argv"][2:4], ["--append-system-prompt", m.VARIANT_RULE])
            self.assertEqual(call["argv"].count("--append-system-prompt"), 1)
        self.assertEqual(c[0]["argv"][4:], ["--model", "opus", "do the task"])
        self.assertEqual(c[1]["argv"][4:-2], ["--model", "opus"])
        self.assertEqual(c[1]["argv"][-2], "--")

    def test_off_and_the_users_own_flag_leave_the_arguments_alone(self):
        self.wrap("--model", "opus", FAKE_MODE="exit7", CLAUDE_AUTO_RULE="off")
        self.assertEqual(self.calls()[0]["argv"][2:], ["--model", "opus"])
        shutil.rmtree(self.state), os.makedirs(self.state)
        self.wrap("--append-system-prompt", "mine", "--model", "opus", FAKE_MODE="handoff")
        c = self.calls()
        self.assertEqual(c[0]["argv"][2:], ["--append-system-prompt", "mine", "--model", "opus"])
        self.assertNotIn("--append-system-prompt", c[1]["argv"])     # decided per run: the follow-up gets no rule either

    def test_passthrough_stays_plain_with_the_rule_on(self):
        self.wrap("-p", "say hi", FAKE_MODE="exit7")
        self.assertEqual(self.calls()[0]["argv"], ["-p", "say hi"])


class ReloadedSkills(unittest.TestCase):
    """CLAUDE_AUTO_SKILLS: which skills of the closed session make_context.py asks the new one to load again."""
    LOADED = "apana:logic-test-debug,android-cli,plugin-authoring"     # the two name shapes of real sessions: plugin:skill and plain

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.stub = write_script(os.path.join(cls.tmp, "mc_skills.py"), """
            import json, os, sys
            a = sys.argv[1:]
            open(os.environ["STUB_ARGV"], "a").write(json.dumps(a) + "\\n")
            if "--list-skills" in a:
                if os.environ.get("STUB_LIST_FAIL"):
                    sys.stderr.write("boom"); sys.exit(1)
                names = [n for n in os.environ.get("STUB_SKILLS", "").split(",") if n]
                for n in names:
                    print("skill: %s | 100 characters" % n)
                print("skills loaded: %d | %d characters of skill text" % (len(names), 100 * len(names)) if names else "skills loaded: none")
                sys.exit(0)
            os.makedirs(a[1], exist_ok=True); open(os.path.join(a[1], "HANDOFF.md"), "w").write("# note")
            """)
        cls.m = load()
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, True)

    def hand_off(self, want, loaded=None, list_fails=False):
        """(argv of every make_context.py call, auto.log, whether HANDOFF.md was written) for one hand-off with CLAUDE_AUTO_SKILLS=want."""
        type(self).n += 1
        root = os.path.join(self.tmp, "r%d" % self.n)
        run = os.path.join(root, "run")
        os.makedirs(run)
        env = {"CLAUDE_AUTO_DIR": os.path.join(root, "base"), "CLAUDE_AUTO_TOKENS": "1", "CLAUDE_AUTO_RUN": run,
               "CLAUDE_AUTO_MAKE_CONTEXT": self.stub, "STUB_ARGV": os.path.join(root, "argv"),
               "STUB_SKILLS": self.LOADED if loaded is None else loaded}
        if list_fails:
            env["STUB_LIST_FAIL"] = "1"
        if want is not None:
            env["CLAUDE_AUTO_SKILLS"] = want
        payload = {"hook_event_name": "PostToolUse", "session_id": "s", "cwd": "/w",
                   "transcript_path": transcript(os.path.join(root, "t.jsonl"), 500)}
        with mock.patch.dict(os.environ, env):
            if want is None:
                os.environ.pop("CLAUDE_AUTO_SKILLS", None)
            self.m.handle(payload)
        while self.m.HELD:
            self.m.HELD.pop().close()
        calls = [json.loads(line) for line in open(env["STUB_ARGV"])]
        log = os.path.join(root, "base", "auto.log")
        return calls, (open(log).read() if os.path.isfile(log) else ""), os.path.isfile(json.load(open(os.path.join(run, "signal.json")))["handoff"])

    def options(self, calls):
        """The options after SESSION and OUT in the call that writes the handoff."""
        made = [c for c in calls if "--list-skills" not in c]
        self.assertEqual(len(made), 1)
        return made[0][2:]

    def test_no_skills_by_default_and_for_every_spelling_of_none(self):
        for want in (None, "", "   ", "none", "None", "NONE", " none "):
            with self.subTest(want=want):
                calls, log, written = self.hand_off(want)
                self.assertEqual(self.options(calls), ["--no-skills"])
                self.assertEqual(len(calls), 1, "the skills are not listed when none are wanted")
                self.assertTrue(written)

    def test_all_passes_no_skills_option(self):
        for want in ("all", "All", "ALL", " all "):
            with self.subTest(want=want):
                calls, log, written = self.hand_off(want)
                self.assertEqual(self.options(calls), [])
                self.assertEqual(len(calls), 1)
                self.assertTrue(written)

    def test_named_skills_keep_their_order_and_both_name_shapes(self):
        for want, expect in (("apana:logic-test-debug", "apana:logic-test-debug"), ("android-cli", "android-cli"),
                             ("android-cli,apana:logic-test-debug", "android-cli,apana:logic-test-debug"),
                             (" android-cli , android-cli ,, plugin-authoring ", "android-cli,plugin-authoring"),
                             (self.LOADED, self.LOADED)):
            with self.subTest(want=want):
                calls, log, written = self.hand_off(want)
                self.assertEqual(self.options(calls), ["--skills", expect])
                self.assertTrue(any("--list-skills" in c for c in calls))
                self.assertNotIn("left out", log)
                self.assertTrue(written)

    def test_a_name_the_session_did_not_load_is_left_out_and_logged(self):
        calls, log, written = self.hand_off("android-cli,ghost")
        self.assertEqual(self.options(calls), ["--skills", "android-cli"])
        self.assertIn("left out: ghost", log)
        self.assertTrue(written)

    def test_names_match_whole_so_a_bare_name_is_not_the_plugin_skill(self):
        calls, log, written = self.hand_off("logic-test-debug,apana")
        self.assertEqual(self.options(calls), ["--no-skills"])
        self.assertIn("left out: logic-test-debug, apana", log)
        self.assertTrue(written)

    def test_nothing_left_after_the_filter_means_no_skills(self):
        for loaded in ("", "other-skill"):
            with self.subTest(loaded=loaded):
                calls, log, written = self.hand_off("android-cli", loaded=loaded)
                self.assertEqual(self.options(calls), ["--no-skills"])
                self.assertIn("left out: android-cli", log)
                self.assertTrue(written)

    def test_a_failing_list_does_not_cost_the_handoff(self):
        calls, log, written = self.hand_off("android-cli", list_fails=True)
        self.assertEqual(self.options(calls), ["--no-skills"])
        self.assertIn("--list-skills exit 1", log)
        self.assertTrue(written)


if __name__ == "__main__":
    unittest.main(verbosity=1)
