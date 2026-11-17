import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { proposalPath, scopeStatus, statePath } from "../../claude-scope-hook/core.mjs";
import { ROOT } from "../catalog.mjs";
import { TEXT, adapterEnv, isOwnJevCall, localID } from "../modes.mjs";
import { setupApana } from "../plugin.mjs";
import { admit, fakeCtx, tempDir, userMessage } from "./support/fake-ctx.mjs";

const JEV = join(ROOT, "skills", "jev-decision-loop", "scripts", "jev.mjs");
const GO = "JEV which file to read (typesafe m, 300 ms)\noptions: a 0.90 | b 0.10\nVERDICT: GO a -- Read /r/a.kt";
const ASK = (extra = "") => `${extra}node ${JEV} <<'EOF'\ndecision: which file to read\ntask: t\na: Read /r/a.kt\nb: Grep x in /r\nEOF`;
const sid = "ses_a";

async function boot({ env: extraEnv = {}, ...options } = {}) {
  const fake = fakeCtx(options);
  const raw = { XDG_STATE_HOME: tempDir("apana-state-"), HOME: tempDir("apana-home-"), ...extraEnv };
  await setupApana(fake.ctx, raw);
  const env = adapterEnv(raw);
  const x = {
    fake,
    env,
    dir: fake.directory,
    status: (id = sid) => scopeStatus(localID(id), env),
    context: async (id, messages) => {
      const event = { sessionID: id, messages, system: [] };
      await fake.fire("session.context", event);
      return event.system.map((part) => part.text);
    },
    before: (tool, input = {}, id = sid) => fake.fire("tool.execute.before", { sessionID: id, tool, input, agent: "build", id: "call_1" }),
    after: (tool, input, text, id = sid, status = "completed") =>
      fake.fire("tool.execute.after", { sessionID: id, tool, input, status, id: "call_1", result: { content: [{ type: "text", text }] } }),
    idle: (background = [], id = sid) => fake.fire("session.experimental.idle", { sessionID: id, background }),
    ask: (command = ASK()) => x.before("shell", { command }),
  };
  return x;
}

async function startScope(x, task = "Fix login") {
  const m1 = await admit(x.fake, sid, "msg_1", `/apana:scope ${task}`);
  const notes = await x.context(sid, [m1]);
  return { m1, notes };
}

async function approveScope(x, m1) {
  const nonce = x.status().nonce;
  writeFileSync(
    proposalPath(localID(sid), x.env),
    JSON.stringify({ production_changes: [{ path: "src/login.js" }], test_changes: [{ path: "test/login.test.js", production_paths: ["src/login.js"] }], test_commands: ["node --test test/login.test.js"] }),
  );
  const m2 = await admit(x.fake, sid, "msg_2", `/apana:scope approve ${nonce}`);
  const notes = await x.context(sid, [m1, m2]);
  return { m2, notes, nonce };
}

describe("admission is not execution", () => {
  it("the prompt hook stores only the intent in the message's metadata and starts nothing", async () => {
    const x = await boot();
    const event = { sessionID: sid, messageID: "msg_1", prompt: { text: "/apana:scope Fix login", skills: [] }, delivery: "steer" };
    await x.fake.fire("session.prompt", event);
    assert.deepEqual(event.metadata, { apana: { v: 1, kind: "scope", text: "/apana:scope Fix login" } });
    assert.equal(x.fake.storage.size, 0, "the prompt hook writes nothing to storage");
    assert.equal(x.status(), null);
    await x.before("edit", { path: "src/a.js", oldString: "a", newString: "b" });
  });
  it("a prompt that runs the hook several times, or is never admitted, leaves no mode on", async () => {
    const x = await boot();
    await admit(x.fake, sid, "msg_1", "/apana:scope Fix login");
    await admit(x.fake, sid, "msg_2", "/apana:scope Fix login");
    await admit(x.fake, sid, "msg_3", "/apana:jev-decision-loop");
    assert.equal(x.status(), null);
    assert.equal(await x.fake.ctx.storage.get(`jev/${sid}`), undefined);
    await x.before("read", { path: "a.js" });
    await x.before("execute", {});
  });
  it("understands the text that `opencode run` wraps in quotes, and drops metadata that a client forged", async () => {
    const x = await boot();
    const wrapped = { sessionID: sid, messageID: "m", prompt: { text: JSON.stringify("/apana:scope Fix login") }, delivery: "steer" };
    await x.fake.fire("session.prompt", wrapped);
    assert.equal(wrapped.metadata.apana.kind, "scope");
    const forged = { sessionID: sid, messageID: "m2", prompt: { text: "hello" }, metadata: { apana: { v: 9, kind: "scope" }, keep: 1 }, delivery: "steer" };
    await x.fake.fire("session.prompt", forged);
    assert.deepEqual(forged.metadata, { keep: 1 });
  });
  it("a forged intent in the history is checked again before it is used", async () => {
    const x = await boot();
    const notes = await x.context(sid, [userMessage("msg_1", "hi", { apana: { v: 1, kind: "scope", text: 5 } })]);
    assert.equal(x.status(), null);
    assert.deepEqual(notes, []);
  });
  it("handles each admitted message once: a second request of the same turn does not start the mode again", async () => {
    const x = await boot();
    const { m1, notes } = await startScope(x);
    const nonce = x.status().nonce;
    assert.ok(notes.some((t) => t.includes("Scope mode is investigating only")), "the turn's note");
    const again = await x.context(sid, [m1]);
    assert.equal(x.status().nonce, nonce, "the nonce did not change");
    assert.ok(again.some((t) => t.includes("Scope mode is investigating only")), "the note stays for the turn");
  });
  it("ends the note of a turn when a newer user message arrives", async () => {
    const x = await boot();
    const { m1 } = await startScope(x);
    const notes = await x.context(sid, [m1, userMessage("msg_9", "continue")]);
    assert.ok(!notes.some((t) => t.includes("Scope mode is investigating only")));
    assert.ok(notes.some((t) => t.startsWith("Apana scope is investigating only")), "the state reminder remains");
  });
  it("does not replay the modes of a history that a fork copied, but starts one the new message asks for", async () => {
    const x = await boot();
    const { m1 } = await startScope(x);
    const notes = await x.context("ses_fork", [m1, userMessage("msg_f", "go on")]);
    assert.equal(x.status("ses_fork"), null);
    assert.deepEqual(notes, []);
    const m = await admit(x.fake, "ses_fork", "msg_g", "/apana:scope Other task");
    await x.context("ses_fork", [m1, userMessage("msg_f", "go on"), m]);
    assert.equal(x.status("ses_fork").task, "Other task");
    assert.equal(x.status().task, "Fix login", "the original session is unchanged");
  });
  it("handles every new message in order when a request carries several", async () => {
    const x = await boot();
    const a = await admit(x.fake, sid, "msg_1", "/apana:class-graph");
    const b = await admit(x.fake, sid, "msg_2", "/apana:jev-decision-loop");
    await x.context(sid, [userMessage("msg_0", "hello")]);
    await x.context(sid, [userMessage("msg_0", "hello"), a, b]);
    assert.equal(await x.fake.ctx.storage.get(`jev/${sid}`), true);
    const notes = await x.context(sid, [userMessage("msg_0", "hello"), a, b]);
    assert.ok(notes.some((t) => t.includes("class-graph is ON")));
  });
  it("lets an error of scope propagate, so that a gate that could not start does not look started", async () => {
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    const x = await boot({ env: { APANA_SCOPE_STATE_DIR: blocker } });
    const m1 = await admit(x.fake, sid, "msg_1", "/apana:scope Fix login");
    await assert.rejects(x.context(sid, [m1]));
    // The shared module reads an unusable state folder as a corrupt state, which refuses every gated tool (as in Claude Code).
    assert.equal(x.status()?.phase, undefined, "no scope phase started");
    await assert.rejects(x.before("edit", { path: "a.js", oldString: "a", newString: "b" }), /scope state is invalid or unsafe/);
  });
  it("tells the model when the skill id is held by another source, and starts nothing", async () => {
    const x = await boot({ skills: [{ id: "scope", path: "/other/SKILL.md" }] });
    const m1 = await admit(x.fake, sid, "msg_1", "/apana:scope Fix login");
    const notes = await x.context(sid, [m1]);
    assert.deepEqual(notes, [TEXT.notOwned("scope")]);
    assert.equal(x.status(), null);
  });
  it("tells the model what a scope command without a task or with several lines means (nothing was started)", async () => {
    const x = await boot();
    const m1 = await admit(x.fake, sid, "msg_1", "/apana:scope");
    assert.deepEqual(await x.context(sid, [m1]), [TEXT.scopeUsage]);
    const m2 = await admit(x.fake, sid, "msg_2", "/apana:scope Fix\nlogin");
    assert.ok((await x.context(sid, [m1, m2])).includes(TEXT.scopeUsage));
    assert.equal(x.status(), null);
  });
});

describe("scope", () => {
  it("is read-only while it investigates: reads, questions and the proposal are allowed, the rest is refused", async () => {
    const x = await boot();
    const { notes } = await startScope(x);
    assert.ok(notes.some((t) => t.includes(proposalPath(localID(sid), x.env))), "the proposal path reaches the model");
    for (const [tool, input] of [["read", { path: "a.js" }], ["glob", { pattern: "*" }], ["grep", { pattern: "x", include: "*.js" }], ["question", {}], ["skill", { id: "variant-check" }], ["webfetch", {}], ["write", { path: proposalPath(localID(sid), x.env), content: "{}" }]]) {
      await x.before(tool, input);
    }
    for (const [tool, input] of [["edit", { path: "src/a.js", oldString: "a", newString: "b" }], ["write", { path: "src/a.js", content: "" }], ["shell", { command: "git status" }], ["execute", {}], ["subagent", {}], ["some_mcp_tool", {}]]) {
      await assert.rejects(x.before(tool, input), /Apana scope: investigation is read-only/, tool);
    }
  });
  it("after the user's approval allows only the exact files and the exact test commands", async () => {
    const x = await boot();
    const { m1 } = await startScope(x);
    const { notes } = await approveScope(x, m1);
    assert.ok(notes.some((t) => t.startsWith("Scope approved. You may edit only these exact files: src/login.js, test/login.test.js")));
    assert.equal(x.status().phase, "approved");
    await x.before("edit", { path: join(x.dir, "src/login.js"), oldString: "a", newString: "b" });
    await x.before("edit", { path: "test/login.test.js", oldString: "a", newString: "b" }, sid);
    await x.before("shell", { command: "node --test test/login.test.js" });
    await x.before("shell", { command: "node --test test/login.test.js", workdir: x.dir });
    for (const [tool, input, why] of [
      ["edit", { path: "README.md", oldString: "a", newString: "b" }, /outside the approved exact-file scope/],
      ["write", { path: "src/new.js", content: "" }, /outside the approved exact-file scope/],
      ["shell", { command: "node --test test/login.test.js; touch pwn" }, /Bash is allowed only for an exact approved test command/],
      ["shell", { command: "node --test test/login.test.js", background: true }, /project directory and in the foreground/],
      ["shell", { command: "node --test test/login.test.js", workdir: tempDir() }, /project directory and in the foreground/],
      ["execute", {}, /Bash is allowed only/],
      ["subagent", {}, /Bash is allowed only/],
    ]) await assert.rejects(x.before(tool, input), why, `${tool} ${JSON.stringify(input)}`);
  });
  it("does not take an approval with the wrong nonce, and an invalid proposal grants nothing", async () => {
    const x = await boot();
    const { m1 } = await startScope(x);
    writeFileSync(proposalPath(localID(sid), x.env), JSON.stringify({ production_changes: [{ path: "src/login.js" }], test_changes: [] }));
    const wrong = await admit(x.fake, sid, "msg_2", "/apana:scope approve 00000000-0000-4000-8000-000000000000");
    const notes = await x.context(sid, [m1, wrong]);
    assert.ok(notes.some((t) => /not accepted/.test(t)));
    assert.equal(x.status().phase, "investigating");
    await assert.rejects(x.before("edit", { path: "src/login.js", oldString: "a", newString: "b" }), /investigation is read-only/);
  });
  it("a new scope task revokes the earlier approval", async () => {
    const x = await boot();
    const { m1 } = await startScope(x);
    const { m2 } = await approveScope(x, m1);
    const m3 = await admit(x.fake, sid, "msg_3", "/apana:scope Another task");
    await x.context(sid, [m1, m2, m3]);
    assert.equal(x.status().phase, "investigating");
    await assert.rejects(x.before("edit", { path: "src/login.js", oldString: "a", newString: "b" }), /investigation is read-only/);
  });
  it("reminds the model of its state in every request, also in a later turn, from the stored state", async () => {
    const x = await boot();
    const { m1 } = await startScope(x);
    const later = await x.context(sid, [m1, userMessage("msg_5", "and now?")]);
    const reminder = later.find((t) => t.startsWith("Apana scope is investigating only"));
    assert.ok(reminder.includes(x.status().nonce) && reminder.includes("/apana:scope approve"));
    const { m2 } = await approveScope(x, m1);
    const approved = await x.context(sid, [m1, m2, userMessage("msg_6", "next")]);
    assert.ok(approved.some((t) => t.startsWith("Apana scope is approved. Edit only: src/login.js, test/login.test.js. Shell only for exactly: node --test test/login.test.js")));
  });
  it("refuses everything when the session moved to another directory, and says so", async () => {
    const directories = {};
    const x = await boot({ directories });
    const { m1 } = await startScope(x);
    directories[sid] = tempDir("apana-moved-");
    await assert.rejects(x.before("read", { path: "a.js" }), /started in .* this session now works in another directory/);
    const notes = await x.context(sid, [m1, userMessage("msg_7", "go")]);
    assert.ok(notes.some((t) => t.includes("this session now works in another directory")));
  });
  it("refuses everything when its state cannot be read safely", async () => {
    const x = await boot();
    await startScope(x);
    writeFileSync(statePath(localID(sid), x.env), "{not json");
    await assert.rejects(x.before("read", { path: "a.js" }), /scope state is invalid or unsafe/);
  });
  it("does not gate a session that has no scope (a child session, another session)", async () => {
    const x = await boot();
    await startScope(x);
    await x.before("edit", { path: "src/a.js", oldString: "a", newString: "b" }, "ses_child");
    await x.before("subagent", {}, "ses_other");
  });
});

describe("Jev decision loop", () => {
  const start = async (x, id = sid) => {
    const m = await admit(x.fake, id, "msg_j1", "/apana:jev-decision-loop");
    await x.context(id, [m]);
    return m;
  };
  it("refuses a tool call that no decision allows, and Code Mode altogether", async () => {
    const x = await boot();
    await start(x);
    await assert.rejects(x.before("read", { path: "a.js" }), /No Jev decision allows this tool call/);
    await assert.rejects(x.before("execute", {}), /Code Mode \(`execute`\) is refused/);
    await assert.rejects(x.before("shell", { command: "ls" }), /No Jev decision allows/);
    await assert.rejects(x.before("skill", { id: "variant-check" }), /No Jev decision allows/);
  });
  it("lets the jev.mjs calls themselves through, with the two variables the skill documents", async () => {
    const x = await boot();
    await start(x);
    await x.ask(`node ${JEV} --check`);
    await x.ask();
    await x.ask(ASK("JEV_MODEL=typesafe/jev-1.13 "));
    await x.ask(ASK("JEV_PROVIDER=openrouter JEV_MODEL=x "));
    for (const command of [
      ASK("NODE_OPTIONS=--require=/tmp/x.js "),
      ASK("JEV_MODEL=$(id) "),
      ASK("JEV_MODEL=`id` "),
      `node "/tmp/$(id)/../..${JEV}" --check`,
      `cat ${JEV}`,
      `node /tmp/other/jev.mjs --check`,
      `node ${JEV} --check; rm -rf /`,
      ASK("A=1 "),
    ]) {
      await assert.rejects(x.ask(command), /No Jev decision allows/, command);
    }
    await assert.rejects(x.before("shell", { command: `node ${JEV} --check`, background: true }), /No Jev decision allows/, "background shell is not a synchronous jev.mjs call");
    await assert.rejects(x.before("shell", { command: "node skills/jev-decision-loop/scripts/jev.mjs --check", workdir: tempDir() }), /No Jev decision allows/, "relative path resolved against workdir");
  });
  it("recognises its own jev.mjs by path, in a relative form too", () => {
    assert.ok(isOwnJevCall(`node ${JEV} --check`, "/anywhere"));
    assert.ok(isOwnJevCall(`node skills/jev-decision-loop/scripts/jev.mjs --check`, ROOT));
    assert.ok(!isOwnJevCall(`node skills/jev-decision-loop/scripts/jev.mjs --check`, "/anywhere"));
    assert.ok(!isOwnJevCall(`node ${JEV} --check && ls`, ROOT));
    assert.ok(!isOwnJevCall(undefined, ROOT));
  });
  it("one GO allows exactly one call, then the next call is a new decision", async () => {
    const x = await boot();
    await start(x);
    await x.ask();
    await x.after("shell", { command: ASK() }, GO);
    await x.before("read", { path: "/r/a.kt" });
    await assert.rejects(x.before("read", { path: "/r/b.kt" }), /No Jev decision allows/);
  });
  it("of two parallel calls on one GO only one runs", async () => {
    const x = await boot();
    await start(x);
    await x.ask();
    await x.after("shell", { command: ASK() }, GO);
    const results = await Promise.allSettled([x.before("read", { path: "a" }), x.before("read", { path: "b" })]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  });
  it("gives no allowance for a decision Jev did not answer or answered STOP", async () => {
    const x = await boot();
    await start(x);
    await x.ask();
    await x.after("shell", { command: ASK() }, "JEV UNAVAILABLE: timeout\nVERDICT: UNSURE -- Jev did not answer, so nothing is decided.");
    await assert.rejects(x.before("read", { path: "a" }), /No Jev decision allows/);
    await x.after("shell", { command: ASK() }, "VERDICT: STOP -- gate in_scope is false");
    await assert.rejects(x.before("read", { path: "a" }), /No Jev decision allows/);
  });
  it("jev.mjs --off ends the mode completely: tools and Code Mode are allowed again", async () => {
    const x = await boot();
    await start(x);
    await x.ask(`node ${JEV} --off`);
    await x.before("read", { path: "a.js" });
    await x.before("execute", {});
    assert.equal(await x.fake.ctx.storage.get(`jev/${sid}`), undefined);
    await x.idle();
    assert.deepEqual(x.fake.calls.synthetic, []);
  });
  it("a --check from the model does not start a mode that the user stopped", async () => {
    const x = await boot();
    await start(x);
    await x.ask(`node ${JEV} --off`);
    await x.ask(`node ${JEV} --check`);
    await x.before("execute", {});
  });
  it("starts again for a later command after it was stopped, with no stale off marker", async () => {
    const x = await boot();
    await start(x);
    await x.ask(`node ${JEV} --off`);
    const m = await admit(x.fake, sid, "msg_j2", "/apana:jev-decision-loop");
    await x.context(sid, [m]);
    await assert.rejects(x.before("read", { path: "a" }), /No Jev decision allows/);
  });
  it("starts when the user attaches the skill, and when the model loads it", async () => {
    const x = await boot();
    const m = await admit(x.fake, sid, "msg_1", "use jev for everything", ["jev-decision-loop"]);
    await x.context(sid, [m]);
    await assert.rejects(x.before("read", { path: "a" }), /No Jev decision allows/);
    const y = await boot();
    await y.before("skill", { id: "jev-decision-loop" });
    await y.after("skill", { id: "jev-decision-loop" }, "skill text");
    await assert.rejects(y.before("read", { path: "a" }), /No Jev decision allows/);
  });
  it("is not started by a skill the model loads that is not Jev's, nor by compact-session", async () => {
    const x = await boot();
    await x.after("skill", { id: "compact-session" }, "text");
    await x.after("skill", { id: "variant-check" }, "text");
    await x.before("read", { path: "a" });
    assert.equal(await x.fake.ctx.storage.get(`compact/${sid}`), undefined);
  });
  it("leaves a child session alone", async () => {
    const x = await boot();
    await start(x);
    await x.before("read", { path: "a" }, "ses_child");
  });
  it("checks the end of a turn once, ignores an unadmitted prompt mid-continuation, and checks again on the next admitted prompt", async () => {
    const x = await boot();
    const m1 = await start(x);
    await x.idle();
    assert.equal(x.fake.calls.synthetic.length, 1);
    assert.match(x.fake.calls.synthetic[0].text, /No Jev decision covers ending this turn/);
    assert.equal(x.fake.calls.synthetic[0].sessionID, sid);
    await x.context(sid, [m1, userMessage("msg_syn", x.fake.calls.synthetic[0].text)]);
    // An unadmitted prompt runs the prompt hook while the continuation is active, and must not re-arm the stop block.
    await admit(x.fake, sid, "msg_rejected", "never admitted");
    await x.idle();
    assert.equal(x.fake.calls.synthetic.length, 1, "the second end of the turn is allowed");
    // Even if a continuation is interrupted before the second idle, the next admitted user message starts a fresh turn check.
    await x.idle();
    assert.equal(x.fake.calls.synthetic.length, 2);
    const mNext = await admit(x.fake, sid, "msg_next", "and one more thing");
    await x.context(sid, [m1, userMessage("msg_syn", x.fake.calls.synthetic[1].text), mNext]);
    await x.idle();
    assert.equal(x.fake.calls.synthetic.length, 3);
  });
  it("lets the turn end after a decision that picked the answer, or asking the user", async () => {
    const x = await boot();
    await start(x);
    const done = "decision: whether to give the final answer now\ntask: t\na: Answer the user: ok\nb: Read x\ngate done: The request is fully done.";
    await x.ask();
    await x.after("shell", { command: `node ${JEV} <<'EOF'\n${done}\nEOF` }, "VERDICT: GO a -- Answer the user: ok");
    await x.idle();
    assert.deepEqual(x.fake.calls.synthetic, []);
  });
  it("waits for work the session itself still runs, but not for work of a child session", async () => {
    const x = await boot();
    await start(x);
    await x.idle([{ kind: "shell", sessionID: sid, shellID: "s", command: "sleep" }]);
    assert.deepEqual(x.fake.calls.synthetic, []);
    await x.idle([{ kind: "subagent", sessionID: "ses_child", childSessionID: "ses_c2", agent: "general", description: "d" }]);
    assert.equal(x.fake.calls.synthetic.length, 1);
  });
  it("does not check anything when the mode is off", async () => {
    const x = await boot();
    await x.idle();
    assert.deepEqual(x.fake.calls.synthetic, []);
  });
});

describe("scope and Jev are separate modes", () => {
  it("scope does not start while Jev is on, in a command or in a message, and changes nothing", async () => {
    const x = await boot();
    const j = await admit(x.fake, sid, "msg_j", "/apana:jev-decision-loop");
    await x.context(sid, [j]);
    const m = await admit(x.fake, sid, "msg_s", "/apana:scope Fix login");
    const notes = await x.context(sid, [j, m]);
    assert.ok(notes.includes(TEXT.scopeVsJev));
    assert.equal(x.status(), null);
    await assert.rejects(x.fake.commands.find((c) => c.name === "apana:scope").execute({ sessionID: sid, delivery: "steer", prompt: { text: "Fix login" } }), /scope cannot start while the Jev decision loop is on/);
    assert.deepEqual(x.fake.calls.prompt, []);
    await assert.rejects(x.before("read", { path: "a" }), /No Jev decision allows/, "Jev is still on");
  });
  it("Jev does not start while scope is on: command, message, attached skill and a skill load by the model", async () => {
    const x = await boot();
    const { m1 } = await startScope(x);
    await assert.rejects(x.fake.commands.find((c) => c.name === "apana:jev-decision-loop").execute({ sessionID: sid, delivery: "steer", prompt: { text: "" } }), /Jev decision loop cannot start while scope is on/);
    const m = await admit(x.fake, sid, "msg_j", "/apana:jev-decision-loop");
    const notes = await x.context(sid, [m1, m]);
    assert.ok(notes.includes(TEXT.jevVsScope));
    assert.equal(await x.fake.ctx.storage.get(`jev/${sid}`), undefined);
    await assert.rejects(x.before("skill", { id: "jev-decision-loop" }), /Jev decision loop cannot start while scope is on/);
    await x.after("skill", { id: "jev-decision-loop" }, "text");
    assert.equal(await x.fake.ctx.storage.get(`jev/${sid}`), undefined);
    await x.before("read", { path: "a.js" });
  });
  it("neither mode widens the other: a scope that was on keeps refusing the shell that Jev's own call would need", async () => {
    const x = await boot();
    await startScope(x);
    await assert.rejects(x.ask(`node ${JEV} --off`), /Apana scope: investigation is read-only/);
  });
});

describe("class-graph reminders", () => {
  it("start with the bare command and are told to the model in every request, from the stored state", async () => {
    const x = await boot();
    const m = await admit(x.fake, sid, "msg_c", "/apana:class-graph");
    await x.context(sid, [m]);
    const notes = await x.context(sid, [m, userMessage("msg_d", "who uses Foo?")]);
    assert.ok(notes.some((t) => t.startsWith("class-graph is ON for this session")));
    const none = await boot();
    assert.deepEqual(await none.context(sid, [userMessage("msg_d", "who uses Foo?")]), []);
  });
  it("note a text search for a class name once, at the next request", async () => {
    const x = await boot();
    const m = await admit(x.fake, sid, "msg_c", "/apana:class-graph");
    await x.context(sid, [m]);
    await x.before("shell", { command: 'rg -n "ProductViewModel" app' });
    const first = await x.context(sid, [m]);
    assert.ok(first.some((t) => t.includes("this search looks for the users of ProductViewModel")));
    const second = await x.context(sid, [m]);
    assert.ok(!second.some((t) => t.includes("this search looks for")));
  });
  it("note nothing when the mode is off, do not treat glob as grep under scope, and ignore the Claude Code plugin option", async () => {
    const x = await boot({ env: { CLAUDE_PLUGIN_OPTION_CLASS_GRAPH_NUDGE: "off" } });
    assert.equal(x.env.CLAUDE_PLUGIN_OPTION_CLASS_GRAPH_NUDGE, undefined);
    await x.before("shell", { command: 'rg -n "ProductViewModel" app' });
    assert.deepEqual(await x.context(sid, [userMessage("msg_d", "hi")]), []);
    const cg = await admit(x.fake, sid, "msg_cg", "/apana:class-graph");
    const sc = await admit(x.fake, sid, "msg_sc", "/apana:scope Check files");
    await x.context(sid, [cg, sc]);
    await x.before("glob", { pattern: "ProductViewModel" });
    const afterGlob = await x.context(sid, [cg, sc, userMessage("msg_next", "continue")]);
    assert.ok(!afterGlob.some((t) => t.includes("this search looks for")), "glob is not misclassified as grep");
  });
});

describe("reload and restart", () => {
  it("a new setup over the same storage and state folder keeps the gate and does not handle the old message again", async () => {
    const storage = new Map();
    const raw = { XDG_STATE_HOME: tempDir("apana-state-"), HOME: tempDir("apana-home-") };
    const first = fakeCtx({ storage });
    await setupApana(first.ctx, raw);
    const m1 = await admit(first, sid, "msg_1", "/apana:scope Fix login");
    await first.fire("session.context", { sessionID: sid, messages: [m1], system: [] });
    const env = adapterEnv(raw);
    const nonce = scopeStatus(localID(sid), env).nonce;
    // The plugin is loaded again (a reload, a restart): new hooks, the same persisted state.
    const second = fakeCtx({ storage, directory: first.directory });
    await setupApana(second.ctx, raw);
    await assert.rejects(second.fire("tool.execute.before", { sessionID: sid, tool: "edit", input: { path: "a.js", oldString: "a", newString: "b" } }), /investigation is read-only/);
    const request = { sessionID: sid, messages: [m1], system: [] };
    await second.fire("session.context", request);
    assert.equal(scopeStatus(localID(sid), env).nonce, nonce, "the message was not handled a second time");
    assert.ok(request.system.some((p) => p.text.startsWith("Apana scope is investigating only")), "the reminder is rebuilt from the stored state");
  });
  it("a Jev loop that was on stays on after a restart, and one that was stopped stays stopped", async () => {
    const storage = new Map();
    const raw = { XDG_STATE_HOME: tempDir("apana-state-"), HOME: tempDir("apana-home-") };
    const first = fakeCtx({ storage });
    await setupApana(first.ctx, raw);
    const m = await admit(first, sid, "msg_1", "/apana:jev-decision-loop");
    await first.fire("session.context", { sessionID: sid, messages: [m], system: [] });
    const second = fakeCtx({ storage, directory: first.directory });
    await setupApana(second.ctx, raw);
    await assert.rejects(second.fire("tool.execute.before", { sessionID: sid, tool: "read", input: { path: "a" } }), /No Jev decision allows/);
    await second.fire("tool.execute.before", { sessionID: sid, tool: "shell", input: { command: `node ${JEV} --off` } });
    const third = fakeCtx({ storage, directory: first.directory });
    await setupApana(third.ctx, raw);
    await third.fire("tool.execute.before", { sessionID: sid, tool: "execute", input: {} });
  });
});

describe("state of the modes", () => {
  it("is kept under OpenCode's own state folder, per session, and apart from Claude Code's", async () => {
    const x = await boot();
    await startScope(x);
    assert.ok(statePath(localID(sid), x.env).includes(join("opencode", "apana", "scope")));
    assert.ok(!statePath(localID(sid), x.env).includes(".claude"));
    assert.notEqual(localID("ses_a"), localID("ses_b"));
    assert.match(localID("ses_a"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
