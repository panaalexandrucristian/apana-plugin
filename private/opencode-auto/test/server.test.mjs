import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fakeCtx, tempDir } from "../../opencode/test/support/fake-ctx.mjs";
import { ceilingOf, contextOf, continuation, createAuto, DEFAULTS, limitsOf, parseHandoff, refusalAfter, setupAuto, settingsOf, unquote, windowOf } from "../server.mjs";

const MODEL = { id: "m", providerID: "p", variant: "default" };
const BIG = [{ id: "m", providerID: "p", limit: { context: 1_000_000, output: 4000 } }];
const SMALL = [{ id: "m", providerID: "p", limit: { context: 100_000, output: 4000 } }];
const NOTE = "Citește /out/HANDOFF.md mai întâi cu unealta read/Read, offset=1, limit=314; apoi urmează instrucțiunile din el.";
const BUILT = `source inventory verified: 0 attachments\nready: /out/HANDOFF.md\nstart the new session with:\n  opencode --prompt '${NOTE}'\n`;
const LISTED = (...names) => `${names.map((n) => `skill: ${n} | 100 characters`).join("\n")}\nskills loaded: ${names.length} | 100 characters of skill text\n`;

const flush = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const marked = (auto = { tokens: 200_000 }, extra = {}) => ({ agent: "build", model: MODEL, metadata: { apana: { auto } }, ...extra });

/** One auto instance over a fake context. `handler` answers make_context.py; `t` stops the event loop when the test ends. */
function setup(t, { models = BIG, sessions = {}, enabled = true, handler, root = marked() } = {}) {
  const dir = tempDir("apana-auto-");
  const directory = tempDir("apana-ws-");
  const located = (session) => ({ location: { directory }, ...session });
  const fake = fakeCtx({ directory, models, sessions: Object.fromEntries(Object.entries({ ses_root: root, ...sessions }).map(([id, s]) => [id, located(s)])) });
  if (enabled) {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "enabled"), "");
  }
  const runs = [];
  const logs = [];
  const clock = { t: 1_000_000 };
  const answer = handler ?? ((args) => ({ code: 0, stdout: args.includes("--list-skills") ? LISTED() : BUILT, stderr: "" }));
  const auto = createAuto(fake.ctx, {
    stateDir: join(dir, "state"),
    dataDir: join(dir, "data"),
    db: "/db/opencode.db",
    script: "/s/make_context.py",
    now: () => clock.t,
    log: (message) => logs.push(message),
    waitMs: 40,
    run: async (args) => {
      runs.push(args);
      return answer(args, { runs, fake });
    },
  });
  const controller = new AbortController();
  auto.start(controller.signal);
  t.after(() => controller.abort());
  const stepEnded = (sessionID, total, where = directory) => ({
    type: "session.step.ended",
    location: { directory: where },
    data: { sessionID, tokens: { input: total - 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
  });
  const step = async (total, sessionID = "ses_root", where) => {
    fake.emit(stepEnded(sessionID, total, where));
    await flush();
  };
  const tool = (sessionID = "ses_root") => auto.beforeTool({ sessionID, tool: "read", input: {} });
  return { auto, fake, runs, logs, clock, dir, directory, step, tool, stepEnded, built: () => runs.filter((a) => !a.includes("--list-skills")) };
}

describe("the numbers", () => {
  it("counts the context the way OpenCode counts it for its compaction, and ignores a step without usage", () => {
    assert.equal(contextOf({ input: 1000, output: 50, reasoning: 5, cache: { read: 300, write: 20 } }), 1375);
    assert.equal(contextOf({ input: 1000, output: 50 }), 1050);
    assert.equal(contextOf(undefined), null);
    assert.equal(contextOf({ input: 1000 }), null);
  });
  it("reads the window from the model's limit: the smaller of input and context when both are set", () => {
    assert.equal(windowOf({ context: 200_000, input: 160_000, output: 32_000 }), 160_000);
    assert.equal(windowOf({ context: 1_048_576, output: 1000 }), 1_048_576);
    assert.equal(windowOf({ context: 262_144, input: 1_048_576 }), 262_144);
    assert.equal(windowOf({ context: 0 }), null);
    assert.equal(windowOf(undefined), null);
  });
  it("puts the compaction ceiling at window - max(15%, 16k), and 16k only for a window of 32k or more", () => {
    assert.equal(ceilingOf(100_000), 84_000);
    assert.equal(ceilingOf(128_000), 108_800);
    assert.equal(ceilingOf(200_000), 170_000);
    assert.equal(ceilingOf(1_000_000), 850_000);
    assert.equal(ceilingOf(20_000), 17_000);
  });
  it("keeps the handoff below the ceiling: 200k and 185k for a large window, 69k for a 100k window, the settings when the window is unknown", () => {
    const d = settingsOf({});
    assert.deepEqual(limitsOf(d, 1_000_000), { step: 200_000, tool: 185_000 });
    assert.deepEqual(limitsOf(d, 100_000), { step: 69_000, tool: 69_000 });
    assert.deepEqual(limitsOf(d, 200_000), { step: 155_000, tool: 155_000 });
    assert.deepEqual(limitsOf(d, null), { step: 200_000, tool: 185_000 });
    assert.deepEqual(limitsOf(settingsOf({ tokens: 50_000, margin: 0 }), 1_000_000), { step: 50_000, tool: 50_000 });
  });
  it("checks each setting on its own and falls back to the default", () => {
    assert.deepEqual(settingsOf(null), { ...DEFAULTS, dir: null, chain: 0 });
    const s = settingsOf({ tokens: 50_000, margin: 99_999_999, deferExtra: -1, cooldown: 1.5, max: "3", skills: "a;b", dir: "relative", chain: 2 });
    assert.deepEqual(s, { tokens: 50_000, margin: 15_000, deferExtra: 30_000, cooldown: 60, max: 0, skills: "none", dir: null, chain: 2 });
    assert.equal(settingsOf({ skills: "caveman,review-plan", dir: "/notes" }).skills, "caveman,review-plan");
    assert.equal(settingsOf({ dir: "/notes" }).dir, "/notes");
  });
});

describe("what make_context.py prints", () => {
  it("gives the note and the prompt it suggests, unquoted as Python quotes them", () => {
    assert.deepEqual(parseHandoff(BUILT), { ready: "/out/HANDOFF.md", prompt: NOTE });
    assert.equal(unquote(`'it'"'"'s here'`), "it's here");
    assert.equal(unquote("plain"), "plain");
    assert.equal(unquote("'open"), null);
  });
  it("is null when the note or the prompt is missing", () => {
    assert.equal(parseHandoff("ready: /out/HANDOFF.md\n"), null);
    assert.equal(parseHandoff(`start the new session with:\n  opencode --prompt '${NOTE}'\n`), null);
  });
  it("tells the new session to keep working, and names the subagents that were still running", () => {
    const text = continuation(200_000, ["ses_kid1", "ses_kid2"]);
    assert.match(text, /~200k tokeni/);
    assert.match(text, /Excepție de la regula/);
    assert.match(text, /ses_kid1, ses_kid2/);
    assert.doesNotMatch(continuation(199_500, []), /Subagenții/);
    assert.match(continuation(199_500, []), /~200k tokeni/);
  });
});

describe("the handoff at the end of a step", () => {
  it("starts at exactly the threshold, not one token before", async (t) => {
    const s = setup(t);
    await s.step(199_999);
    assert.equal(s.fake.calls.interrupt.length, 0);
    assert.equal(s.fake.calls.create.length, 0);
    await s.step(200_000);
    assert.equal(s.fake.calls.create.length, 1);
  });
  it("creates the new session like the old one, with the note and the continuation, and writes `next` on the old one", async (t) => {
    const s = setup(t, { root: marked({ tokens: 200_000, skills: "none" }, { metadata: { keep: 1, apana: { auto: { tokens: 200_000, skills: "none" } } } }) });
    await s.step(210_000);
    assert.deepEqual(s.fake.calls.interrupt, [{ sessionID: "ses_root", resume: false }]);
    const [created] = s.fake.calls.create;
    assert.equal(created.agent, "build");
    assert.deepEqual(created.model, MODEL);
    assert.deepEqual(created.location, { directory: s.directory });
    assert.deepEqual(created.metadata, { keep: 1, apana: { auto: { tokens: 200_000, skills: "none", chain: 1 } } }, "the mark travels on, one step further along the chain, and there is no `next`");
    const [prompt] = s.fake.calls.prompt;
    assert.equal(prompt.sessionID, "ses_new1");
    assert.ok(prompt.text.startsWith(NOTE));
    assert.match(prompt.text, /~210k tokeni/);
    assert.deepEqual(s.fake.calls.update, [{ sessionID: "ses_root", metadata: { keep: 1, apana: { auto: { tokens: 200_000, skills: "none" }, next: "ses_new1" } } }]);
    assert.match(s.logs.at(-1), /ses_root: 210000 tokens; handoff \(step\) to ses_new1, note \/out\/HANDOFF.md/);
  });
  it("writes the note into a durable folder of the plugin's own data and asks for the session by id", async (t) => {
    const s = setup(t);
    await s.step(200_000);
    const [args] = s.built();
    assert.deepEqual(args.slice(0, 2), ["--opencode", "/db/opencode.db"]);
    assert.ok(args[2].startsWith(join(s.dir, "data", "handoffs", "auto") + "/"), args[2]);
    assert.deepEqual(args.slice(3), ["--session", "ses_root", "--no-skills"]);
  });
  it("stops the session before it reads it, so that the note holds the final state", async (t) => {
    const s = setup(t);
    const order = [];
    const interrupt = s.fake.ctx.session.interrupt;
    s.fake.ctx.session.interrupt = async (input) => {
      order.push("interrupt");
      return interrupt(input);
    };
    const run = s.runs.push.bind(s.runs);
    s.runs.push = (args) => (order.push(args.includes("--list-skills") ? "list" : "build"), run(args));
    await s.step(200_000);
    assert.deepEqual(order, ["interrupt", "list", "build"]);
  });
  it("does not wait for an event when there was nothing to interrupt, and goes on after a timeout when the event never comes", async (t) => {
    const idle = setup(t);
    idle.fake.state.interruptResult = { interrupted: false };
    await idle.step(200_000);
    assert.equal(idle.fake.calls.create.length, 1);
    const silent = setup(t);
    silent.fake.state.interruptEvent = false;
    await silent.step(200_000);
    assert.equal(silent.fake.calls.create.length, 0, "still waiting for execution.interrupted");
    await sleep(120);
    await flush();
    assert.equal(silent.fake.calls.create.length, 1);
  });
  it("reads the metadata again after the note is written: the TUI or the user may have changed it meanwhile", async (t) => {
    const s = setup(t, {
      handler: (args, { fake }) => {
        fake.sessions.get("ses_root").metadata.late = "added while the note was written";
        return { code: 0, stdout: args.includes("--list-skills") ? LISTED() : BUILT, stderr: "" };
      },
    });
    await s.step(200_000);
    assert.equal(s.fake.calls.create[0].metadata.late, "added while the note was written");
    assert.equal(s.fake.calls.update[0].metadata.late, "added while the note was written");
  });
  it("uses the 100k window of the model: the handoff starts at 69,000, not at 200,000", async (t) => {
    const s = setup(t, { models: SMALL });
    await s.step(68_999);
    assert.equal(s.fake.calls.create.length, 0);
    await s.step(69_000);
    assert.equal(s.fake.calls.create.length, 1);
  });
  // A session that runs the default model has no `model` of its own (measured on 2.3.2); the model of its steps is announced by `session.step.started`.
  const started = (s, sessionID) => {
    s.fake.emit({ type: "session.step.started", location: { directory: s.directory }, data: { sessionID, model: MODEL } });
    return flush();
  };
  const unmodelled = () => marked({ tokens: 200_000 }, { model: undefined });
  it("takes the window from the model of the session's last step when the session has no model of its own", async (t) => {
    const s = setup(t, { models: SMALL, root: unmodelled() });
    await started(s, "ses_root");
    await s.step(68_999);
    assert.equal(s.fake.calls.create.length, 0);
    await s.step(69_000);
    assert.equal(s.fake.calls.create.length, 1);
  });
  it("keeps the settings of the mark when the session has no model and no step has announced one", async (t) => {
    const s = setup(t, { models: SMALL, root: unmodelled() });
    await s.step(150_000);
    assert.equal(s.fake.calls.create.length, 0);
  });
  it("does not give a session the model that another session's step announced", async (t) => {
    const s = setup(t, { models: SMALL, root: unmodelled() });
    await started(s, "ses_other");
    await s.step(150_000);
    assert.equal(s.fake.calls.create.length, 0);
  });
  it("uses the configured threshold and the other settings of the mark", async (t) => {
    const s = setup(t, { root: marked({ tokens: 120_000, margin: 10_000 }) });
    await s.step(119_999);
    assert.equal(s.fake.calls.create.length, 0);
    await s.step(120_000);
    assert.equal(s.fake.calls.create.length, 1);
  });
  it("hands off only once for events that arrive together", async (t) => {
    const s = setup(t);
    s.fake.emit(s.stepEnded("ses_root", 205_000));
    s.fake.emit(s.stepEnded("ses_root", 206_000));
    s.fake.emit(s.stepEnded("ses_root", 207_000));
    await flush();
    assert.equal(s.fake.calls.create.length, 1);
    assert.equal(s.fake.calls.interrupt.length, 1);
    await s.step(220_000);
    assert.equal(s.fake.calls.create.length, 1, "the session was handed off and stays so");
  });
});

describe("the handoff before a tool call", () => {
  it("lets the call through at 184,999 and refuses it from 185,000, handing off at the same time", async (t) => {
    const s = setup(t);
    await s.step(184_999);
    assert.equal(await s.tool(), undefined);
    assert.equal(s.fake.calls.create.length, 0);
    await s.step(185_000);
    assert.equal(s.fake.calls.create.length, 0, "185,000 is below the threshold of the end of a step");
    await assert.rejects(s.tool(), /nearly full.*handed off/);
    await flush();
    assert.equal(s.fake.calls.create.length, 1);
    assert.match(s.logs.at(-1), /handoff \(tool\)/);
  });
  it("refuses the parallel calls of the same step and every later one without a second handoff", async (t) => {
    const s = setup(t);
    await s.step(190_000);
    const results = await Promise.allSettled([s.tool(), s.tool(), s.tool()]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected", "rejected"]);
    await flush();
    await assert.rejects(s.tool(), /handed off to a new session, ses_new1/);
    assert.equal(s.fake.calls.create.length, 1);
  });
  it("says only that a handoff is under way while the new session does not exist yet", async (t) => {
    const s = setup(t, { handler: (args) => (args.includes("--list-skills") ? { code: 0, stdout: LISTED(), stderr: "" } : new Promise(() => {})) });
    await s.step(200_000);
    const refused = await s.tool().then(() => null, (error) => error.message);
    assert.match(refused, /nearly full, so this session is being handed off/);
    assert.doesNotMatch(refused, /ses_/);
  });
  it("names the new session once it exists, in every later refusal, with the commands that open it", async (t) => {
    // A user who goes on in the old session (a window that did not follow) gets these refusals, and the old model read them as "no handoff" (2026-11-21).
    const s = setup(t);
    await s.step(200_000);
    for (let i = 0; i < 2; i += 1) await assert.rejects(s.tool(), (error) => error.message === refusalAfter("ses_new1"));
    const text = refusalAfter("ses_new1");
    assert.match(text, /handed off to a new session, ses_new1, which continues the work/);
    assert.ok(text.includes("`opencode-auto -s ses_new1`") && text.includes("`opencode -s ses_new1`"), text);
    assert.match(text, /Do not retry this call/);
  });
  it("does not name a new session whose prompt could not be sent: it was removed, and the retry says only that a handoff is under way", async (t) => {
    let hang = false;
    const s = setup(t, { handler: (args) => (args.includes("--list-skills") ? { code: 0, stdout: LISTED(), stderr: "" } : hang ? new Promise(() => {}) : { code: 0, stdout: BUILT, stderr: "" }) });
    s.fake.state.promptError = new Error("provider down");
    await s.step(200_000);
    assert.deepEqual(s.fake.calls.remove, [{ sessionID: "ses_new1" }]);
    s.clock.t += 60_000;
    hang = true;
    await s.step(201_000); // the retry, whose note is still being written
    const refused = await s.tool().then(() => null, (error) => error.message);
    assert.match(refused, /nearly full, so this session is being handed off/);
    assert.doesNotMatch(refused, /ses_new1/);
  });
  it("lets a call through again when the handoff failed", async (t) => {
    const s = setup(t, { handler: () => ({ code: 1, stdout: "", stderr: "boom" }) });
    await s.step(190_000);
    await assert.rejects(s.tool(), /nearly full/);
    await flush();
    assert.equal(s.fake.calls.create.length, 0);
    assert.equal(await s.tool(), undefined, "nothing is being handed off, so the tool runs");
  });
  it("does nothing for a session it has not seen a step of, and when it is switched off", async (t) => {
    const s = setup(t);
    assert.equal(await s.tool(), undefined);
    const off = setup(t, { enabled: false });
    await off.step(300_000);
    assert.equal(await off.tool(), undefined);
    assert.equal(off.fake.calls.create.length, 0);
  });
});

describe("which sessions it touches", () => {
  const cases = {
    "a session without the mark": { sessions: { ses_other: { agent: "build", model: MODEL } }, id: "ses_other" },
    "a subagent, which inherits its parent's mark": { sessions: { ses_other: marked({ tokens: 200_000 }, { parentID: "ses_root" }) }, id: "ses_other" },
    "a session that was already handed off": { sessions: { ses_other: marked(undefined, { metadata: { apana: { auto: { tokens: 200_000 }, next: "ses_x" } } }) }, id: "ses_other" },
    "a session with a mark that is not an object": { sessions: { ses_other: marked(undefined, { metadata: { apana: { auto: true } } }) }, id: "ses_other" },
  };
  for (const [name, { sessions, id }] of Object.entries(cases)) {
    it(`leaves ${name} alone, at 250,000 tokens`, async (t) => {
      const s = setup(t, { sessions });
      await s.step(250_000, id);
      assert.equal(await s.tool(id), undefined);
      assert.equal(s.fake.calls.interrupt.length, 0);
      assert.equal(s.fake.calls.create.length, 0);
    });
  }
  it("leaves a session of another location to the instance of that location", async (t) => {
    const s = setup(t);
    await s.step(250_000, "ses_root", "/another/project");
    assert.equal(s.fake.calls.create.length, 0);
    assert.equal(s.fake.calls.interrupt.length, 0);
  });
  it("does nothing without the `enabled` file, and starts again as soon as it is there", async (t) => {
    const s = setup(t, { enabled: false });
    await s.step(250_000);
    assert.equal(s.fake.calls.create.length, 0);
    mkdirSync(join(s.dir, "state"), { recursive: true });
    writeFileSync(join(s.dir, "state", "enabled"), "");
    await s.step(251_000);
    assert.equal(s.fake.calls.create.length, 1);
  });
  it("ignores a step whose event carries no usage", async (t) => {
    const s = setup(t);
    s.fake.emit({ type: "session.step.ended", location: { directory: s.directory }, data: { sessionID: "ses_root" } });
    await flush();
    assert.equal(s.fake.calls.create.length, 0);
    assert.equal(await s.tool(), undefined);
  });
});

describe("subagents", () => {
  const spawn = (s, id, parent = "ses_root") => s.fake.emit({ type: "session.created", data: { sessionID: id, parentID: parent } });
  const state = (s, id, type) => s.fake.emit({ type: `session.execution.${type}`, data: { sessionID: id } });

  it("holds the handoff back while a subagent runs, up to 30,000 tokens over the threshold, then goes on and names it", async (t) => {
    const s = setup(t);
    spawn(s, "ses_kid");
    state(s, "ses_kid", "started");
    await flush();
    await s.step(200_000);
    await s.step(229_999);
    assert.equal(s.fake.calls.create.length, 0);
    assert.equal(s.logs.filter((l) => /deferred/.test(l)).length, 1, "said once, not at every step");
    await s.step(230_000);
    assert.equal(s.fake.calls.create.length, 1);
    assert.match(s.fake.calls.prompt[0].text, /ses_kid/);
    assert.match(s.logs.at(-1), /subagents left running: ses_kid/);
  });
  it("does not wait for a subagent that has finished", async (t) => {
    const s = setup(t);
    spawn(s, "ses_kid");
    state(s, "ses_kid", "started");
    state(s, "ses_kid", "succeeded");
    await flush();
    await s.step(200_000);
    assert.equal(s.fake.calls.create.length, 1);
    assert.doesNotMatch(s.fake.calls.prompt[0].text, /Subagenții/);
  });
  it("counts a subagent of a subagent, and ignores the ones of another session", async (t) => {
    const s = setup(t);
    spawn(s, "ses_kid");
    spawn(s, "ses_grandkid", "ses_kid");
    spawn(s, "ses_stranger", "ses_elsewhere");
    state(s, "ses_grandkid", "started");
    state(s, "ses_stranger", "started");
    await flush();
    await s.step(210_000);
    assert.equal(s.fake.calls.create.length, 0, "the grandchild still runs");
    state(s, "ses_grandkid", "interrupted");
    await flush();
    await s.step(211_000);
    assert.equal(s.fake.calls.create.length, 1, "the stranger's subagent is not ours to wait for");
  });
  it("does not hold a tool call back for them: the tool refusal and the handoff follow the same rule", async (t) => {
    const s = setup(t);
    spawn(s, "ses_kid");
    state(s, "ses_kid", "started");
    await flush();
    await s.step(190_000);
    assert.equal(await s.tool(), undefined, "deferred, so the tool runs");
    assert.equal(s.fake.calls.create.length, 0);
  });
});

describe("how often, how many, and what a failure does", () => {
  it("waits for the cooldown between two handoffs and then allows the next", async (t) => {
    const s = setup(t, { sessions: { ses_two: marked() } });
    await s.step(200_000);
    await s.step(200_000, "ses_two");
    assert.equal(s.fake.calls.create.length, 1);
    assert.match(s.logs.join("\n"), /younger than 60s; skipped/);
    s.clock.t += 60_000;
    await s.step(200_001, "ses_two");
    assert.equal(s.fake.calls.create.length, 2);
  });
  it("stops at the limit of handoffs along a chain, and counts the chain", async (t) => {
    const stopped = setup(t, { root: marked({ tokens: 200_000, max: 2, chain: 2 }) });
    await stopped.step(250_000);
    assert.equal(stopped.fake.calls.create.length, 0);
    const allowed = setup(t, { root: marked({ tokens: 200_000, max: 2, chain: 1 }) });
    await allowed.step(250_000);
    assert.equal(allowed.fake.calls.create[0].metadata.apana.auto.chain, 2);
  });
  it("leaves the session as it was when make_context.py fails, and tries again only after a minute", async (t) => {
    let fail = true;
    const s = setup(t, { handler: (args) => (fail && !args.includes("--list-skills") ? { code: 1, stdout: "", stderr: "step failed: boom" } : { code: 0, stdout: args.includes("--list-skills") ? LISTED() : BUILT, stderr: "" }) });
    await s.step(200_000);
    assert.equal(s.fake.calls.create.length, 0);
    assert.equal(s.fake.calls.update.length, 0);
    assert.match(s.logs.at(-1), /handoff failed \(make_context.py exit 1: step failed: boom\); a retry waits 60s/);
    const attempts = s.built().length;
    s.clock.t += 59_000;
    await s.step(201_000);
    assert.equal(s.built().length, attempts, "too soon");
    s.clock.t += 1_000;
    fail = false;
    await s.step(202_000);
    assert.equal(s.fake.calls.create.length, 1);
  });
  it("fails, without a second session, when the output has no note or no prompt", async (t) => {
    const s = setup(t, { handler: () => ({ code: 0, stdout: "ready: /out/HANDOFF.md\n", stderr: "" }) });
    await s.step(200_000);
    assert.equal(s.fake.calls.create.length, 0);
    assert.match(s.logs.at(-1), /handoff failed/);
  });
  it("removes the new session when its prompt cannot be sent, and does not write `next`", async (t) => {
    const s = setup(t);
    s.fake.state.promptError = new Error("provider down");
    await s.step(200_000);
    assert.deepEqual(s.fake.calls.remove, [{ sessionID: "ses_new1" }]);
    assert.equal(s.fake.calls.update.length, 0);
    assert.match(s.logs.at(-1), /handoff failed \(provider down\)/);
  });
  it("keeps the new session and does not hand off again when only `next` could not be written", async (t) => {
    const s = setup(t);
    s.fake.state.updateError = new Error("read only");
    await s.step(200_000);
    assert.equal(s.fake.calls.remove.length, 0);
    assert.match(s.logs.join("\n"), /the new session ses_new1 is running but `next` was not written \(read only\)/);
    s.clock.t += 120_000;
    await s.step(210_000);
    assert.equal(s.fake.calls.create.length, 1);
  });
  it("does not start when the session cannot be interrupted", async (t) => {
    const s = setup(t);
    s.fake.ctx.session.interrupt = async () => {
      throw new Error("no such session");
    };
    await s.step(200_000);
    assert.equal(s.runs.length, 0);
    assert.equal(s.fake.calls.create.length, 0);
    assert.match(s.logs.at(-1), /handoff failed \(no such session\)/);
  });
});

describe("the skills of the new session", () => {
  const withSkills = (list, want) => ({ root: marked({ tokens: 200_000, ...(want ? { skills: want } : {}) }), handler: (args) => ({ code: 0, stdout: args.includes("--list-skills") ? list : BUILT, stderr: "" }) });
  it("reloads none by default", async (t) => {
    const s = setup(t, withSkills(LISTED("review-plan")));
    await s.step(200_000);
    assert.deepEqual(s.runs[0].slice(-3), ["--session", "ses_root", "--list-skills"]);
    assert.equal(s.built()[0].at(-1), "--no-skills");
  });
  it("always reloads caveman when the session loaded it, which stays on until the user ends it", async (t) => {
    const s = setup(t, withSkills(LISTED("caveman", "review-plan")));
    await s.step(200_000);
    assert.deepEqual(s.built()[0].slice(-2), ["--skills", "caveman"]);
  });
  it("reloads the named ones the session loaded, leaves out those it did not, and adds caveman", async (t) => {
    const s = setup(t, withSkills(LISTED("caveman", "review-plan"), "review-plan,scope"));
    await s.step(200_000);
    assert.deepEqual(s.built()[0].slice(-2), ["--skills", "review-plan,caveman"]);
  });
  it("reloads all of them without asking which, and none when the listing fails", async (t) => {
    const all = setup(t, withSkills(LISTED("review-plan"), "all"));
    await all.step(200_000);
    assert.equal(all.runs.length, 1, "no listing");
    assert.ok(!all.runs[0].includes("--skills") && !all.runs[0].includes("--no-skills"));
    const broken = setup(t, { root: marked({ tokens: 200_000, skills: "review-plan" }), handler: (args) => (args.includes("--list-skills") ? { code: 1, stdout: "", stderr: "x" } : { code: 0, stdout: BUILT, stderr: "" }) });
    await broken.step(200_000);
    assert.equal(broken.built()[0].at(-1), "--no-skills");
    assert.equal(broken.fake.calls.create.length, 1, "a failed listing does not cost the handoff");
  });
});

describe("two instances of one directory", () => {
  /** Two instances over two contexts that name the same directory, the same marked session and one state folder. */
  function twoInstances(t, handler) {
    const directory = tempDir("apana-ws-");
    const dir = tempDir("apana-auto-");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "enabled"), "");
    const make = () => {
      const fake = fakeCtx({ directory, models: BIG, sessions: { ses_root: { ...marked({ tokens: 200_000, cooldown: 0 }), location: { directory } } } });
      const answer = (args) => ({ code: 0, stdout: args.includes("--list-skills") ? LISTED() : BUILT, stderr: "" });
      const auto = createAuto(fake.ctx, { stateDir: join(dir, "state"), dataDir: join(dir, "data"), db: "/db/opencode.db", script: "/s/make_context.py", now: () => 1_000_000, log: () => {}, waitMs: 40, run: async (args) => (handler ? handler(args, answer) : answer(args)) });
      const controller = new AbortController();
      auto.start(controller.signal);
      t.after(() => controller.abort());
      return { fake, auto };
    };
    const [a, b] = [make(), make()];
    const step = async (...targets) => {
      for (const target of targets) target.fake.emit({ type: "session.step.ended", location: { directory }, data: { sessionID: "ses_root", tokens: { input: 200_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } });
      await flush();
    };
    return { a, b, step, created: () => a.fake.calls.create.length + b.fake.calls.create.length };
  }

  it("hand a session off once, not once for each instance", async (t) => {
    const p = twoInstances(t);
    await p.step(p.a, p.b);
    assert.equal(p.created(), 1);
  });
  it("refuse the tool calls of a session that the other instance handed off, and name the new session it made", async (t) => {
    const p = twoInstances(t);
    await p.step(p.a);
    await assert.rejects(p.b.auto.beforeTool({ sessionID: "ses_root", tool: "read", input: {} }), (error) => error.message === refusalAfter("ses_new1"));
  });
  it("give back what a disposed instance was still handing off, so the other can do it", async (t) => {
    let calls = 0;
    const p = twoInstances(t, (args, answer) => (++calls === 1 ? new Promise(() => {}) : answer(args)));
    await p.step(p.a);
    assert.equal(p.created(), 0, "the first instance is stuck in its handoff");
    p.a.auto.dispose();
    await p.step(p.b);
    assert.equal(p.b.fake.calls.create.length, 1);
  });
  it("keep what a disposed instance had finished: the session is not handed off a second time", async (t) => {
    const p = twoInstances(t);
    await p.step(p.a);
    assert.equal(p.created(), 1);
    p.a.auto.dispose();
    await p.step(p.b);
    assert.equal(p.created(), 1);
  });
  it("share a failure: the instance that did not try does not try within the wait that follows it", async (t) => {
    const tried = [];
    const p = twoInstances(t, (args, answer) => {
      if (args.includes("--list-skills")) return answer(args);
      tried.push(args);
      return { code: 1, stdout: "", stderr: "boom" };
    });
    await p.step(p.a);
    assert.equal(tried.length, 1);
    await p.step(p.b);
    assert.equal(tried.length, 1, "the second instance leaves the session alone until the wait is over");
    assert.equal(p.created(), 0);
  });
});

describe("setup", () => {
  it("registers the tool hook and one subscription, and removes both when it is disposed", async () => {
    const fake = fakeCtx({ models: BIG });
    const auto = await setupAuto(fake.ctx, {}, { stateDir: tempDir("apana-auto-"), dataDir: tempDir("apana-auto-") });
    assert.equal(fake.hooks.get("tool.execute.before").length, 1);
    assert.equal(fake.subscribers.size, 1);
    await auto.dispose();
    assert.deepEqual(fake.disposed, ["tool.hook:execute.before"]);
    assert.equal(fake.subscribers.size, 0);
    assert.equal(fake.hooks.get("tool.execute.before").length, 0);
  });
  it("refuses to start, with nothing registered, when OpenCode lacks a call it needs", async () => {
    for (const missing of ["session.interrupt", "session.create", "event.subscribe", "tool.hook", "model.list"]) {
      const fake = fakeCtx({ missing: [missing] });
      await assert.rejects(setupAuto(fake.ctx, {}, {}), new RegExp(`does not offer ${missing}`));
      assert.equal(fake.hooks.size, 0);
      assert.equal(fake.subscribers.size, 0);
    }
  });
  it("takes the tool hook back when the subscription cannot be made", async () => {
    const fake = fakeCtx({ failAt: "event.subscribe" });
    await assert.rejects(setupAuto(fake.ctx, {}, {}), /injected failure at event\.subscribe/);
    assert.deepEqual(fake.disposed, ["tool.hook:execute.before"]);
    assert.equal(fake.hooks.get("tool.execute.before").length, 0);
  });
});
