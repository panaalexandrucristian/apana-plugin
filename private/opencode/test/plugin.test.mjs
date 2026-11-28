import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { ROOT, loadCatalog } from "../catalog.mjs";
import { setupApana } from "../plugin.mjs";
import { fakeCtx, tempDir } from "./support/fake-ctx.mjs";

const envFor = () => ({ XDG_STATE_HOME: tempDir("apana-state-"), HOME: tempDir("apana-home-") });
const SKILL_PATH = (id) => join(ROOT, "skills", id, "SKILL.md");
const command = (fake, name) => fake.commands.find((c) => c.name === name);

describe("setup", () => {
  it("registers the hooks first, then the skills, then the commands", async () => {
    const fake = fakeCtx();
    await setupApana(fake.ctx, envFor());
    assert.deepEqual(fake.order, [
      "session.hook:prompt", "session.hook:context", "tool.hook:execute.before", "tool.hook:execute.after",
      "session.hook:experimental.idle", "session.hook:compaction", "skill.transform", "command.transform",
    ]);
  });
  it("adds the skills of the catalog except the one whose own adapter registers it, and a command for each registered skill", async () => {
    const fake = fakeCtx();
    const result = await setupApana(fake.ctx, envFor());
    const { skills } = await loadCatalog();
    const expected = skills.filter((s) => !s.adapter).map((s) => s.id).sort();
    assert.deepEqual([...fake.registry.keys()].sort(), expected);
    assert.ok(!fake.registry.has("logic-test-debug"));
    assert.deepEqual(result.skills.sort(), expected);
    assert.deepEqual(fake.commands.map((c) => c.name).sort(), [...expected.map((id) => `apana:${id}`), "apana:explica-optiuni"].sort());
    const entry = fake.registry.get("class-graph");
    assert.equal(entry.path, SKILL_PATH("class-graph"));
    assert.equal(entry.autoinvoke, true);
    assert.equal(fake.registry.get("compact-session").autoinvoke, false);
  });
  it("does not register removed skills or their commands", async () => {
    const fake = fakeCtx();
    await setupApana(fake.ctx, envFor());
    for (const id of ["assess-complexity", "code-rag", "code-rag-setup", "harness2", "improve-skill", "scope"]) {
      assert.ok(!fake.registry.has(id), id);
      assert.ok(!command(fake, `apana:${id}`), id);
    }
  });
  it("gives the command of the adapter's skill too when that adapter registered it from the same file", async () => {
    const fake = fakeCtx({ skills: [{ id: "logic-test-debug", path: SKILL_PATH("logic-test-debug") }] });
    await setupApana(fake.ctx, envFor());
    assert.ok(command(fake, "apana:logic-test-debug"));
  });
  it("leaves a skill id that another source holds alone, and offers no command for it", async () => {
    const other = { id: "class-graph", path: "/somewhere/else/SKILL.md", content: "theirs" };
    const fake = fakeCtx({ skills: [other] });
    await setupApana(fake.ctx, envFor());
    assert.equal(fake.registry.get(other.id).content, "theirs");
    assert.ok(!command(fake, `apana:${other.id}`));
    assert.ok(command(fake, "apana:variant-check"));
  });
  it("keeps the descriptions of the commands short", async () => {
    const fake = fakeCtx();
    await setupApana(fake.ctx, envFor());
    for (const c of fake.commands) assert.ok(c.description.length <= 160, `${c.name} ${c.description.length}`);
  });
});

describe("a setup that fails leaves nothing registered", () => {
  const points = [
    "session.hook:prompt", "session.hook:context", "tool.hook:execute.before", "tool.hook:execute.after",
    "session.hook:experimental.idle", "session.hook:compaction", "skill.transform", "command.transform",
  ];
  for (const failAt of points) {
    it(`when ${failAt} fails`, async () => {
      const fake = fakeCtx({ failAt });
      await assert.rejects(setupApana(fake.ctx, envFor()), /injected failure/);
      assert.equal(fake.disposed.length, fake.order.length, "every registration made before the failure was undone");
      assert.equal(fake.registry.size, 0, "no skill is left behind");
      assert.equal(fake.commands.length, 0);
      for (const callbacks of fake.hooks.values()) assert.equal(callbacks.length, 0);
    });
  }
  for (const path of ["session.hook", "session.get", "session.prompt", "session.compact", "session.context", "session.synthetic", "tool.hook", "skill.transform", "skill.list", "command.transform", "storage.get", "storage.set", "storage.remove"]) {
    it(`when OpenCode does not offer ${path}: it is named, and nothing is registered`, async () => {
      const fake = fakeCtx({ missing: [path] });
      await assert.rejects(setupApana(fake.ctx, envFor()), new RegExp(`does not offer ${path.replace(".", "\\.")}`));
      assert.equal(fake.order.length, 0);
    });
  }
  it("rolls back when the catalog cannot be read", async () => {
    const fake = fakeCtx();
    await assert.rejects(setupApana(fake.ctx, envFor(), { loadCatalog: async () => { throw new Error("catalog"); } }), /catalog/);
    assert.equal(fake.order.length, 0);
  });
});

describe("opencode-plugin.js", () => {
  const load = async () => (await import(pathToFileURL(join(ROOT, "opencode-plugin.js")).href)).default;
  const quietly = async (fn) => {
    const warnings = [];
    const [info, warn] = [console.info, console.warn];
    console.info = () => {};
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      return { result: await fn(), warnings };
    } finally {
      [console.info, console.warn] = [info, warn];
    }
  };
  it("returns a cleanup function when everything is set up", async () => {
    const plugin = await load();
    const fake = fakeCtx();
    const { result, warnings } = await quietly(() => plugin.setup(fake.ctx));
    assert.equal(typeof result, "function");
    assert.deepEqual(warnings, []);
    assert.ok(fake.registry.has("class-graph") && fake.registry.has("logic-test-debug"), "both parts registered their skills");
  });
  it("keeps logic-test-debug and undoes the rest when the larger integration cannot be set up, without a raw error", async () => {
    const plugin = await load();
    const fake = fakeCtx({ failAt: "command.transform" });
    const { result, warnings } = await quietly(() => plugin.setup(fake.ctx));
    assert.equal(result, undefined);
    assert.deepEqual(warnings, ["[apana] the OpenCode integration is unavailable; nothing of it was left registered"]);
    assert.ok(fake.registry.has("logic-test-debug"), "the independent adapter still works");
    assert.ok(!fake.registry.has("class-graph") && fake.commands.length === 0);
    assert.ok(!warnings.join("").includes("injected"));
  });
});

describe("the commands", () => {
  const boot = async (options) => {
    const fake = fakeCtx(options);
    await setupApana(fake.ctx, envFor());
    return fake;
  };
  const args = 'path with "quotes", $1 $& ünï 𐍈\nsecond line';
  it("send the command as the user typed it, with the skill attached and the other attachments kept (their mentions dropped)", async () => {
    const fake = await boot();
    const mention = { start: 0, end: 5, text: "@file" };
    await command(fake, "apana:review-plan").execute({
      sessionID: "ses_a", delivery: "queue",
      prompt: { text: args, files: [{ uri: "file:///a.txt", mention }], agents: [{ name: "x", mention }], skills: [{ id: "variant-check", mention }] },
    });
    assert.deepEqual(fake.calls.prompt, [{
      sessionID: "ses_a", delivery: "queue", text: `/apana:review-plan ${args}`,
      files: [{ uri: "file:///a.txt" }], agents: [{ name: "x" }], skills: [{ id: "variant-check" }, { id: "review-plan" }],
    }]);
  });
  it("send only the command name when there are no arguments, and do not attach the skill twice", async () => {
    const fake = await boot();
    await command(fake, "apana:variant-check").execute({ sessionID: "s", delivery: "steer", prompt: { text: "  ", skills: [{ id: "variant-check" }] } });
    assert.equal(fake.calls.prompt[0].text, "/apana:variant-check");
    assert.deepEqual(fake.calls.prompt[0].skills, [{ id: "variant-check" }]);
  });
  it("fill in $ARGUMENTS of a command file literally (no replacement pattern is read)", async () => {
    const fake = await boot();
    await command(fake, "apana:explica-optiuni").execute({ sessionID: "s", delivery: "steer", prompt: { text: args } });
    const text = fake.calls.prompt[0].text;
    assert.ok(text.endsWith(`Subiect și context:\n${args}\n`));
    assert.ok(!text.includes("$ARGUMENTS"));
    assert.deepEqual(fake.calls.prompt[0].skills, []);
  });
  it("ask OpenCode for the compaction instead of sending a prompt, with the delivery that was asked", async () => {
    const fake = await boot();
    await command(fake, "apana:compact-session").execute({ sessionID: "ses_a", delivery: "queue", prompt: { text: "" } });
    assert.deepEqual(fake.calls.compact, [{ sessionID: "ses_a", delivery: "queue" }]);
    assert.deepEqual(fake.calls.prompt, []);
  });
  it("refuse to run when another source took the skill id after setup", async () => {
    const fake = await boot();
    fake.registry.set("review-plan", { id: "review-plan", path: "/other/SKILL.md" });
    await assert.rejects(command(fake, "apana:review-plan").execute({ sessionID: "s", delivery: "steer", prompt: { text: "x" } }), /used by another source/);
    assert.deepEqual(fake.calls.prompt, []);
  });
  it("keep sessions apart: two commands with different arguments do not mix", async () => {
    const fake = await boot();
    await Promise.all([
      command(fake, "apana:review-plan").execute({ sessionID: "s1", delivery: "steer", prompt: { text: "one" } }),
      command(fake, "apana:review-plan").execute({ sessionID: "s2", delivery: "steer", prompt: { text: "two" } }),
    ]);
    const by = Object.fromEntries(fake.calls.prompt.map((p) => [p.sessionID, p.text]));
    assert.deepEqual(by, { s1: "/apana:review-plan one", s2: "/apana:review-plan two" });
  });
});
