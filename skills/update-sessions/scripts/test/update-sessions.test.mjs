// Tests of the command flow of update-sessions with a fake machine: no terminal is touched, no process is started, the clock is fake.
// The screens the fake iTerm2 returns are built here in the shapes the sessions.test.mjs fixtures show (a box of two ── lines around the ❯ row, the echo above it).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ItermError, createIterm } from "../iterm.mjs";
import { main } from "../update-sessions.mjs";

const B = "─".repeat(40);
const NBSP = " ";
const boxed = (above, text = "") => `${above}\n${B}\n❯${NBSP}${text}\n${B}\n  [Sonnet 5.5] │ project git:(main*) \n  ⏵⏵ bypass permissions on (shift+tab to cycle) \n\n\n\n`;
const pairOf = (p, s) => `❯ /reload-plugins\n  ⎿  Reloaded: ${p} plugins · ${s} skills · 11 agents · 2 hooks · 0 plugin MCP servers · 0 plugin LSP servers`;

/**
 * A fake laptop. spec = { pid, tty, name, status, sessionId?, text?, above?, onType?: "reload" | "ignore", delayReads?, pair?, matches?, noRegistry? }.
 * Typing into an "reload" session makes the echo + Reloaded: pair appear above its box after `delayReads` reads (default 1).
 */
function world(specs, { afterWrite, itermError, updateFails } = {}) {
  const log = [];
  const writes = [];
  const cmds = [];
  let clock = 0;
  let version = "7.0.0";
  const byTty = (tty) => specs.find((s) => `/dev/${s.tty}` === tty);
  const screens = new Map(specs.map((s) => { s.above ??= "older output"; return [`/dev/${s.tty}`, boxed(s.above, s.text ?? "")]; }));
  const pending = new Map();
  const iterm = {
    sessions() {
      if (itermError) throw itermError;
      return specs.flatMap((s) => Array.from({ length: s.matches ?? 1 }, () => ({ tty: `/dev/${s.tty}`, name: s.name })));
    },
    read(tty) {
      log.push(`read:${tty}`);
      const p = pending.get(tty);
      if (p && --p.remaining <= 0) {
        const s = byTty(tty);
        s.above += `\n${s.pair ?? pairOf(...(s.counts ?? [5, 51]))}`;
        screens.set(tty, boxed(s.above));
        pending.delete(tty);
      }
      return screens.get(tty);
    },
    write(tty, text) {
      log.push(`write:${tty}`);
      writes.push({ tty, text });
      const s = byTty(tty);
      if ((s.onType ?? "reload") === "reload") pending.set(tty, { remaining: s.delayReads ?? 1 });
      afterWrite?.(tty, screens);
    },
  };
  const deps = {
    home: "/Users/me",
    runCmd(cmd, args, { cwd }) {
      cmds.push(`${[cmd, ...args].join(" ")} @${cwd}`);
      if (args.join(" ") === "plugin update apana@apana-private") { if (updateFails) return { status: 1, stdout: "", stderr: "boom: marketplace unreachable" }; version = "7.0.1"; }
      return { status: 0, stdout: "ok", stderr: "" };
    },
    installed: () => ({ version, installPath: `/Users/me/.claude/plugins/cache/apana-private/apana/${version}` }),
    psText: () => "  PID  PPID TTY      COMMAND\n" + specs.map((s) => `${String(s.pid).padStart(5)}     1 ${s.tty}  /Users/me/.nvm/bin/claude --settings x`).join("\n") + "\n  999     1 ??       /usr/bin/something-else\n",
    registry: () => new Map(specs.filter((s) => !s.noRegistry).map((s) => [s.pid, { status: s.status, name: s.name, sessionId: s.sessionId ?? `sid-${s.pid}` }])),
    iterm,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { deps, log, writes, cmds, clock: () => clock };
}

const idle = (pid, name, extra = {}) => ({ pid, tty: `ttys00${pid % 10}`, name, status: "idle", ...extra });
const rowOf = (text, name) => text.split("\n").find((l) => l.startsWith(name + " "));

describe("main: the whole flow", () => {
  it("updates on disk from the home folder, reloads every idle session with an empty prompt one at a time, and the invoking session last as queued", async () => {
    const w = world([{ pid: 1, tty: "ttys001", name: "me", status: "busy", sessionId: "me-id" }, idle(2, "alpha", { counts: [6, 53] }), idle(3, "bravo")]);
    const { code, text } = await main(["--self", "me-id"], w.deps);
    assert.deepEqual(w.cmds, ["claude plugin marketplace update apana-private @/Users/me", "claude plugin update apana@apana-private @/Users/me"]);
    assert.deepEqual(w.writes.map((x) => x.tty), ["/dev/ttys002", "/dev/ttys003", "/dev/ttys001"], "the invoking session is typed after all the others");
    for (const x of w.writes) assert.equal(x.text, "/reload-plugins");
    w.log.forEach((entry, i) => { if (entry.startsWith("write:")) assert.equal(w.log[i - 1], entry.replace("write:", "read:"), `the prompt of ${entry} is read right before it is typed into`); });
    assert.equal(code, 0);
    assert.match(text, /^apana: 7\.0\.0 -> 7\.0\.1$/m);
    assert.match(rowOf(text, "alpha"), /^alpha\s+ttys002\s+reloaded\s+Reloaded: 6 plugins · 53 skills · 11 agents · 2 hooks$/);
    assert.match(rowOf(text, "bravo"), /^bravo\s+ttys003\s+reloaded\s+Reloaded: 5 plugins · 51 skills · 11 agents · 2 hooks$/);
    assert.match(rowOf(text, "me"), /^me\s+ttys001\s+queued\s+this session: runs right after this reply$/);
  });

  it("skips what it must not type into, says why with the command to type by hand, and never reads or writes the screen of a busy, waiting or unknown session", async () => {
    const w = world([
      idle(1, "texty", { text: "aplică redenumirea" }),
      idle(2, "busy", { status: "busy" }),
      idle(3, "waits", { status: "waiting" }),
      idle(4, "nofile", { noRegistry: true }),
      idle(5, "twice", { matches: 2 }),
      idle(6, "noterm", { matches: 0 }),
    ]);
    const { code, text } = await main([], w.deps);
    assert.equal(code, 3);
    assert.deepEqual(w.writes, []);
    assert.match(rowOf(text, "texty"), /skipped\s+prompt has text: send or clear it, then type \/reload-plugins$/);
    assert.match(rowOf(text, "busy"), /skipped\s+busy: type \/reload-plugins when it is idle$/);
    assert.match(rowOf(text, "waits"), /skipped\s+waiting for your answer in the session: answer there, then type \/reload-plugins$/);
    assert.match(rowOf(text, "pid 4"), /skipped\s+no registry file/);
    assert.match(rowOf(text, "twice"), /skipped\s+.*2 iTerm2 sessions/);
    assert.match(rowOf(text, "noterm"), /skipped\s+.*not an iTerm2 session/);
    assert.deepEqual(w.log, ["read:/dev/ttys001"], "only the idle session with exactly one terminal had its screen read");
  });

  it("skips a session whose prompt got text while the earlier sessions were being processed, because its screen is read again right before its turn", async () => {
    const w = world([idle(1, "alpha"), idle(2, "bravo")], { afterWrite: (tty, screens) => { if (tty === "/dev/ttys001") screens.set("/dev/ttys002", boxed("older output", "half a sentence")); } });
    const { code, text } = await main([], w.deps);
    assert.deepEqual(w.writes.map((x) => x.tty), ["/dev/ttys001"]);
    assert.match(rowOf(text, "bravo"), /skipped\s+prompt has text/);
    assert.equal(code, 3);
  });

  it("waits for the echo + Reloaded: pair that shows up on a later poll, polling once a second", async () => {
    const w = world([idle(1, "alpha", { delayReads: 4 })]);
    const { code, text } = await main([], w.deps);
    assert.equal(code, 0);
    assert.match(rowOf(text, "alpha"), /reloaded/);
    assert.equal(w.clock(), 4000);
  });

  it("reports typed, not confirmed after the time limit, with exit 3 and the command to check by hand: the session got the command but nothing proves it ran", async () => {
    const w = world([idle(1, "alpha", { onType: "ignore" })]);
    const { code, text } = await main([], w.deps);
    assert.equal(code, 3);
    assert.match(rowOf(text, "alpha"), /typed, not confirmed\s+.*\/reload-plugins/);
    assert.equal(w.writes.length, 1, "typed once, never again");
    assert.ok(w.clock() >= 20000 && w.clock() <= 21000, `waited ${w.clock()} ms`);
  });

  it("does not take a Reloaded: line that was already above the box before the typing as the proof", async () => {
    const old = `older output\n${pairOf(5, 51)}`;
    const ignored = world([idle(1, "alpha", { above: old, onType: "ignore" })]);
    assert.match(rowOf((await main([], ignored.deps)).text, "alpha"), /typed, not confirmed/);
    const ran = world([idle(1, "alpha", { above: old })]);
    assert.match(rowOf((await main([], ran.deps)).text, "alpha"), /reloaded/);
  });

  it("shows a held reload as held with the --force command, and exits 3 because the reload is not fully applied", async () => {
    const w = world([idle(1, "alpha", { pair: `${pairOf(5, 51)}\n  ⎿  This reload changes MCP tools. Run /reload-plugins --force to apply.` })]);
    const { code, text } = await main([], w.deps);
    assert.equal(code, 3);
    assert.match(rowOf(text, "alpha"), /held\s+.*\/reload-plugins --force/);
  });

  it("skips the invoking session as any other when its prompt has text", async () => {
    const w = world([{ pid: 1, tty: "ttys001", name: "me", status: "busy", sessionId: "me-id", text: "typing now" }]);
    const { code, text } = await main(["--self", "me-id"], w.deps);
    assert.equal(code, 3);
    assert.deepEqual(w.writes, []);
    assert.match(rowOf(text, "me"), /skipped\s+prompt has text/);
  });
});

describe("main: the update on disk", () => {
  it("stops with exit 4 naming the command that failed and what it returned, and touches no session", async () => {
    const w = world([idle(1, "alpha")], { updateFails: true });
    const { code, text } = await main([], w.deps);
    assert.equal(code, 4);
    assert.match(text, /claude plugin update apana@apana-private/);
    assert.match(text, /boom: marketplace unreachable/);
    assert.deepEqual(w.log, []);
  });

  it("keeps going when the plugin is already at the latest version: the sessions may still be behind", async () => {
    const w = world([idle(1, "alpha")]);
    w.deps.runCmd = (cmd, args) => { w.cmds.push(args.join(" ")); return { status: 0, stdout: "already at the latest version", stderr: "" }; };
    const { code, text } = await main([], w.deps);
    assert.equal(code, 0);
    assert.match(text, /^apana: 7\.0\.0 \(unchanged\)$/m);
    assert.equal(w.writes.length, 1);
  });
});

describe("main: --dry-run and the arguments", () => {
  it("runs no update, types nothing, and shows what each session would get", async () => {
    const w = world([{ pid: 1, tty: "ttys001", name: "me", status: "busy", sessionId: "me-id" }, idle(2, "alpha"), idle(3, "texty", { text: "x" })]);
    const { code, text } = await main(["--self", "me-id", "--dry-run"], w.deps);
    assert.deepEqual(w.cmds, []);
    assert.deepEqual(w.writes, []);
    assert.match(text, /^apana: 7\.0\.0 on disk \(dry run: no update\)$/m);
    assert.match(rowOf(text, "alpha"), /would reload/);
    assert.match(rowOf(text, "me"), /would queue/);
    assert.match(rowOf(text, "texty"), /skipped\s+prompt has text/);
    assert.equal(code, 3);
  });

  it("exits 2 with the usage for an unknown option or a --self without a value", async () => {
    for (const argv of [["--bogus"], ["--self"], ["stray"]]) {
      const w = world([idle(1, "alpha")]);
      const { code, text } = await main(argv, w.deps);
      assert.equal(code, 2, argv.join(" "));
      assert.match(text, /usage: node update-sessions\.mjs \[--self <sessionId>\] \[--dry-run\]/);
      assert.deepEqual(w.cmds, []);
    }
  });

  it("exits 5 with the message of iTerm2 when it cannot be read, and touches no session", async () => {
    const w = world([idle(1, "alpha")], { itermError: new ItermError("iTerm2 is not running") });
    const { code, text } = await main(["--dry-run"], w.deps);
    assert.equal(code, 5);
    assert.match(text, /iTerm2 is not running/);
    assert.deepEqual(w.writes, []);
  });
});

describe("iterm.mjs", () => {
  const fake = (result) => { const calls = []; return { calls, run: (args) => { calls.push(args); return typeof result === "function" ? result(args) : result; } }; };

  it("lists the sessions as tty and name, and passes the tty and the text as arguments, never inside the script", () => {
    const f = fake({ status: 0, stdout: "/dev/ttys001\tRăspuns (claude)\n/dev/ttys003\t◐ Claude Code\n", stderr: "" });
    const it = createIterm(f.run);
    assert.deepEqual(it.sessions(), [{ tty: "/dev/ttys001", name: "Răspuns (claude)" }, { tty: "/dev/ttys003", name: "◐ Claude Code" }]);
    it.read("/dev/ttys001");
    it.write("/dev/ttys001", "/reload-plugins");
    const [, readCall, writeCall] = f.calls;
    assert.equal(readCall[0], "-e");
    assert.deepEqual(readCall.slice(2), ["/dev/ttys001"]);
    assert.deepEqual(writeCall.slice(2), ["/dev/ttys001", "/reload-plugins"]);
    for (const call of f.calls) assert.ok(!call[1].includes("ttys001") && !call[1].includes("reload-plugins"), "the script text is fixed");
    assert.match(writeCall[1], /write text/);
  });

  it("separates the tty from the name with the character 9, not the word tab: inside `tell application \"iTerm2\"` that word is the iTerm2 class and prints as the text \"tab\" (seen on the real machine, where every session then matched no tty)", () => {
    const f = fake({ status: 0, stdout: "", stderr: "" });
    createIterm(f.run).sessions();
    const script = f.calls[0][1];
    assert.match(script, /ASCII character 9/);
    assert.doesNotMatch(script.replace(/--.*$/gm, ""), /\btab\b(?! of| in)/);
  });

  it("never launches iTerm2: every script first asks whether it is running", () => {
    const f = fake({ status: 0, stdout: "", stderr: "" });
    const it = createIterm(f.run);
    it.sessions(); it.read("/dev/ttys001"); it.write("/dev/ttys001", "x");
    for (const call of f.calls) assert.match(call[1], /is running/);
  });

  it("names the Automation setting when macOS refuses the Apple events, and gives the other errors as they are", () => {
    const refused = createIterm(fake({ status: 1, stdout: "", stderr: "execution error: Not authorized to send Apple events to iTerm2. (-1743)" }).run);
    assert.throws(() => refused.sessions(), (e) => e instanceof ItermError && /System Settings/.test(e.message) && /Privacy & Security/.test(e.message) && /Automation/.test(e.message));
    const other = createIterm(fake({ status: 1, stdout: "", stderr: "execution error: Can't get session 4. (-1728)" }).run);
    assert.throws(() => other.read("/dev/ttys004"), (e) => e instanceof ItermError && /Can't get session 4/.test(e.message));
  });
});
