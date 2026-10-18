import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOGIC_DIRECTIVE } from "../check.mjs";
import { DIAGNOSTICS, MAX_PENDING, extractPromptText, parseSkill, setupLogicTestDebug } from "../opencode.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL_PATH = join(ROOT, "skills", "logic-test-debug", "SKILL.md");
const SENTINEL = "SENTINEL-PROMPT-TEXT-DO-NOT-LEAK";
const CODE = "Write a Python function that validates an email address.";

/** A fake plugin context: a skill editor over a Map and a recorder of session hooks. */
function fakeCtx({ skill = true, hooks = true, entries = [], failHook = [], failTransform = false } = {}) {
  const skills = new Map(entries);
  const registered = {};
  const ctx = {};
  if (skill) {
    ctx.skill = {
      transform: async (fn) => {
        if (failTransform) throw new Error(`transform failed ${SENTINEL}`);
        return fn({ get: (id) => skills.get(id), add: (entry) => skills.set(entry.id, entry) });
      },
    };
  }
  if (hooks) {
    ctx.session = {
      hook: async (name, fn) => {
        if (failHook.includes(name)) throw new Error(`hook failed ${SENTINEL}`);
        registered[name] = fn;
      },
    };
  }
  return { ctx, skills, registered };
}
const setup = async (fake, env = {}) => {
  const logs = [];
  const report = await setupLogicTestDebug(fake.ctx, env, { log: (m) => logs.push(m) });
  return { report, logs };
};
const deliver = (fake, sessionID) => {
  const system = [];
  fake.registered.context({ sessionID, system });
  return system;
};

describe("skill registration", () => {
  it("registers the skill with fields derived from the file, beside existing entries", async () => {
    const jev = { id: "jev", name: "jev" };
    const fake = fakeCtx({ entries: [["jev", jev]] });
    const { report, logs } = await setup(fake);
    assert.deepEqual(report.registered, ["skill", "hook:context", "hook:prompt"]);
    assert.equal(logs.length, 0);
    assert.equal(fake.skills.get("jev"), jev, "existing jev entry preserved");
    const entry = fake.skills.get("logic-test-debug");
    assert.equal(entry.id, "logic-test-debug");
    assert.equal(entry.name, "logic-test-debug");
    assert.equal(entry.path, SKILL_PATH);
    assert.equal(entry.location, SKILL_PATH);
    assert.ok(entry.description.startsWith("Use when writing or changing code"));
    assert.ok(!entry.content.startsWith("---"), "content is the body without frontmatter");
    assert.ok(entry.content.includes("# logic-test-debug"));
  });
  it("parses frontmatter and rejects a file without it", () => {
    const parsed = parseSkill(readFileSync(SKILL_PATH, "utf8"));
    assert.equal(parsed.name, "logic-test-debug");
    assert.throws(() => parseSkill("no frontmatter"));
    assert.throws(() => parseSkill("---\nname: x\n---\nbody"));
  });
  it("treats an existing entry with the same path as already registered", async () => {
    const fake = fakeCtx({ entries: [["logic-test-debug", { id: "logic-test-debug", path: SKILL_PATH }]] });
    const { report } = await setup(fake);
    assert.ok(report.registered.includes("skill"));
    assert.ok(report.registered.includes("hook:prompt"));
  });
  it("preserves a colliding entry, delivers nothing and says so once", async () => {
    const other = { id: "logic-test-debug", path: "/somewhere/else/SKILL.md" };
    const fake = fakeCtx({ entries: [["logic-test-debug", other]] });
    const { report, logs } = await setup(fake);
    assert.equal(fake.skills.get("logic-test-debug"), other);
    assert.deepEqual(report.degraded, ["skill"]);
    assert.deepEqual(logs, [DIAGNOSTICS.collision]);
    assert.equal(fake.registered.prompt, undefined);
    assert.equal(fake.registered.context, undefined);
  });
  it("degrades without throwing when skill.transform is missing or fails, and registers no hooks", async () => {
    for (const fake of [fakeCtx({ skill: false }), fakeCtx({ failTransform: true })]) {
      const { report, logs } = await setup(fake);
      assert.deepEqual(report.degraded, ["skill"]);
      assert.deepEqual(logs, [DIAGNOSTICS.registration]);
      assert.ok(!logs.join("").includes(SENTINEL));
      assert.equal(fake.registered.prompt, undefined, "no directive for a skill that failed to register");
    }
  });
});

describe("hook capabilities degrade independently", () => {
  it("keeps the skill when session.hook is missing", async () => {
    const fake = fakeCtx({ hooks: false });
    const { report, logs } = await setup(fake);
    assert.deepEqual(report.registered, ["skill"]);
    assert.deepEqual(logs, [DIAGNOSTICS.hooks]);
    assert.ok(fake.skills.has("logic-test-debug"));
  });
  it("registers no producer when the context hook fails", async () => {
    const fake = fakeCtx({ failHook: ["context"] });
    const { report, logs } = await setup(fake);
    assert.deepEqual(report.registered, ["skill"]);
    assert.equal(fake.registered.prompt, undefined);
    assert.deepEqual(logs, [DIAGNOSTICS.hooks]);
    assert.ok(!logs.join("").includes(SENTINEL));
  });
  it("leaves the context hook inert when the prompt hook fails", async () => {
    const fake = fakeCtx({ failHook: ["prompt"] });
    const { report } = await setup(fake);
    assert.deepEqual(report.registered, ["skill", "hook:context"]);
    assert.deepEqual(deliver(fake, "s1"), []);
  });
});

describe("directive delivery", () => {
  it("delivers in every model request of the turn and renews on a later code prompt", async () => {
    const fake = fakeCtx();
    await setup(fake);
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    for (let step = 0; step < 4; step += 1) assert.deepEqual(deliver(fake, "s1"), [{ type: "text", text: LOGIC_DIRECTIVE }], `request ${step + 1} of the turn`);
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    assert.equal(deliver(fake, "s1").length, 1);
    assert.equal(deliver(fake, "s1").length, 1);
  });
  it("adds the directive once per request, not twice", async () => {
    const fake = fakeCtx();
    await setup(fake);
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    const system = [{ type: "text", text: "base" }];
    fake.registered.context({ sessionID: "s1", system });
    assert.deepEqual(system.map((p) => p.text), ["base", LOGIC_DIRECTIVE]);
  });
  it("clears a stale directive when the next prompt is not about code", async () => {
    const fake = fakeCtx();
    await setup(fake);
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    fake.registered.prompt({ sessionID: "s1", prompt: "What is a good pancake recipe?" });
    assert.deepEqual(deliver(fake, "s1"), []);
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    fake.registered.prompt({ sessionID: "s1", prompt: { not: "a string" } });
    assert.deepEqual(deliver(fake, "s1"), []);
  });
  it("gives the read-only locator subagent no directive and keeps the entry for the main agent", async () => {
    const fake = fakeCtx();
    await setup(fake);
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    const locator = [];
    fake.registered.context({ sessionID: "s1", agent: "jev-locator", system: locator });
    assert.deepEqual(locator, []);
    assert.equal(deliver(fake, "s1").length, 1);
  });
  it("keeps sessions apart and ignores a context call for another session", async () => {
    const fake = fakeCtx();
    await setup(fake);
    fake.registered.prompt({ sessionID: "a", prompt: CODE });
    assert.deepEqual(deliver(fake, "b"), []);
    assert.equal(deliver(fake, "a").length, 1);
  });
  it(`caps the pending map at ${MAX_PENDING} entries and evicts the oldest`, async () => {
    const fake = fakeCtx();
    await setup(fake);
    for (let i = 0; i < MAX_PENDING + 44; i += 1) fake.registered.prompt({ sessionID: `s${i}`, prompt: CODE });
    assert.deepEqual(deliver(fake, "s0"), [], "oldest evicted");
    assert.equal(deliver(fake, `s${MAX_PENDING + 43}`).length, 1, "newest kept");
  });
  it("accepts the prompt text from prompt, text or text parts, with bounds", () => {
    assert.equal(extractPromptText({ prompt: { text: "o", files: [], agents: [], skills: [] }, delivery: "steer" }), "o", "OpenCode 2.0.22 shape");
    assert.equal(extractPromptText({ prompt: { text: 5 } }), null);
    assert.equal(extractPromptText({ prompt: { text: JSON.stringify("Fix the bug in a.js") } }), "Fix the bug in a.js", "opencode run wraps the text as a JSON string");
    assert.equal(extractPromptText({ prompt: { text: JSON.stringify("say \"hi\"\nnow") } }), 'say "hi"\nnow');
    assert.equal(extractPromptText({ prompt: { text: '"not json' } }), '"not json');
    assert.equal(extractPromptText({ prompt: { text: 'He said "write code" and "run it"' } }), 'He said "write code" and "run it"');
    assert.equal(extractPromptText({ prompt: { text: '"a" and "b"' } }), '"a" and "b"', "two quoted words are not one JSON string");
    assert.equal(extractPromptText({ prompt: "a" }), "a");
    assert.equal(extractPromptText({ text: "b" }), "b");
    assert.equal(extractPromptText({ parts: [{ type: "text", text: "c" }, { type: "image", text: "x" }, { type: "text", text: "d" }] }), "c\nd");
    assert.equal(extractPromptText({ parts: [{ type: "image" }] }), null);
    assert.equal(extractPromptText({}), null);
    assert.equal(extractPromptText({ prompt: 5, parts: "x" }), null);
    const huge = extractPromptText({ parts: [{ type: "text", text: "a".repeat(200000) }] });
    assert.ok(huge.length > 65536, "oversize input stays oversize and is rejected by the classifier");
  });
  it("makes one fixed diagnostic when the payload or the session identity is unsupported, never leaking the prompt", async () => {
    const fake = fakeCtx();
    const { logs } = await setup(fake);
    fake.registered.prompt({ sessionID: "s1", somethingElse: SENTINEL });
    fake.registered.prompt({ sessionID: "s1", somethingElse: SENTINEL });
    fake.registered.prompt({ prompt: `${CODE} ${SENTINEL}` });
    assert.deepEqual(logs, [DIAGNOSTICS.payload], "once per capability");
    assert.ok(!logs.join("").includes(SENTINEL));
    assert.deepEqual(deliver(fake, "s1"), []);
  });
  it("clears the pending directive and diagnoses once when the append fails", async () => {
    const fake = fakeCtx();
    const { logs } = await setup(fake);
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    fake.registered.context({ sessionID: "s1", system: Object.freeze([]) });
    assert.deepEqual(logs, [DIAGNOSTICS.delivery]);
    assert.deepEqual(deliver(fake, "s1"), [], "not retried indefinitely");
    fake.registered.prompt({ sessionID: "s2", prompt: CODE });
    fake.registered.context({ sessionID: "s2", system: "not an array" });
    assert.deepEqual(logs, [DIAGNOSTICS.delivery], "the same diagnostic is not repeated");
  });
});

describe("switch", () => {
  it("registers nothing when off", async () => {
    for (const value of ["off", "0", "false", "", "garbage"]) {
      const fake = fakeCtx();
      const { report, logs } = await setup(fake, { APANA_LOGIC_TEST_DEBUG: value });
      assert.deepEqual(report, { registered: [], degraded: [] }, value);
      assert.equal(fake.skills.size, 0);
      assert.deepEqual(logs, []);
    }
  });
  it("is independent of JEV_FLOW and rechecks the switch inside the callbacks", async () => {
    const env = { JEV_FLOW: "off" };
    const fake = fakeCtx();
    await setup(fake, env);
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    env.APANA_LOGIC_TEST_DEBUG = "off";
    assert.deepEqual(deliver(fake, "s1"), [], "pending entry cleared once the switch is off");
    fake.registered.prompt({ sessionID: "s1", prompt: CODE });
    delete env.APANA_LOGIC_TEST_DEBUG;
    assert.deepEqual(deliver(fake, "s1"), [], "nothing was stored while off");
  });
});

describe("plugin isolation (opencode-plugin.js with a minimal context)", () => {
  it("does not throw and leaks no error text when the logic-test-debug part fails", async () => {
    const calls = { skills: new Map() };
    const ctx = {
      skill: { transform: async (fn) => fn({ get: (id) => calls.skills.get(id), add: (entry) => { if (entry.id === "logic-test-debug") throw new Error(SENTINEL); calls.skills.set(entry.id, entry); } }) },
      session: { hook: async () => { throw new Error(SENTINEL); } },
    };
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const plugin = (await import(pathToFileURL(join(ROOT, "opencode-plugin.js")).href)).default;
      await plugin.setup(ctx);
    } finally {
      console.warn = original;
    }
    assert.ok(!calls.skills.has("logic-test-debug"));
    assert.ok(!warnings.join("\n").includes(SENTINEL) || warnings.every((w) => !w.includes("logic-test-debug") || !w.includes(SENTINEL)), "no raw error text in the new part's diagnostics");
  });
});
