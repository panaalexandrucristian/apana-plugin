import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { ROOT } from "../../opencode/catalog.mjs";
import { fakeCtx } from "../../opencode/test/support/fake-ctx.mjs";

const SERVER_WARNING = "[apana-auto] the automatic handoff is unavailable; nothing of it was left registered";
const TUI_WARNING = "[apana-auto] the TUI part is unavailable; the handoff still runs, but this window will not move to the new session by itself";

const load = async (name) => (await import(pathToFileURL(join(ROOT, "opencode-auto", name)).href)).default;
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

describe("opencode-auto/server.js", () => {
  it("has its own id and returns a cleanup function that takes back the hook and the subscription", async () => {
    const plugin = await load("server.js");
    assert.equal(plugin.id, "apana-auto");
    const fake = fakeCtx();
    const { result, warnings } = await quietly(() => plugin.setup(fake.ctx));
    assert.equal(typeof result, "function");
    assert.deepEqual(warnings, []);
    assert.equal(fake.hooks.get("tool.execute.before").length, 1);
    assert.equal(fake.subscribers.size, 1);
    await result();
    assert.equal(fake.hooks.get("tool.execute.before").length, 0);
    assert.equal(fake.subscribers.size, 0);
  });
  it("registers nothing of apana itself: no skills, no commands, no session hooks", async () => {
    const plugin = await load("server.js");
    const fake = fakeCtx();
    await quietly(() => plugin.setup(fake.ctx));
    assert.equal(fake.registry.size, 0);
    assert.equal(fake.commands.length, 0);
    assert.deepEqual(fake.order, ["tool.hook:execute.before"]);
  });
  it("warns with a fixed text, returns no cleanup and leaves nothing registered when OpenCode lacks a call", async () => {
    const plugin = await load("server.js");
    const fake = fakeCtx({ missing: ["session.interrupt"] });
    const { result, warnings } = await quietly(() => plugin.setup(fake.ctx));
    assert.equal(result, undefined);
    assert.deepEqual(warnings, [SERVER_WARNING]);
    assert.equal(fake.hooks.size, 0);
    assert.ok(!warnings.join("").includes("session.interrupt"), "no raw error text");
  });
  it("does the same when the subscription fails after the hook was registered", async () => {
    const plugin = await load("server.js");
    const fake = fakeCtx({ failAt: "event.subscribe" });
    const { result, warnings } = await quietly(() => plugin.setup(fake.ctx));
    assert.equal(result, undefined);
    assert.deepEqual(warnings, [SERVER_WARNING]);
    assert.equal(fake.hooks.get("tool.execute.before").length, 0);
    assert.ok(!warnings.join("").includes("injected"));
  });
});

describe("opencode-auto/tui.js", () => {
  it("has its own id, different from the server entry's", async () => {
    const [server, tui] = [await load("server.js"), await load("tui.js")];
    assert.equal(tui.id, "apana-auto.tui");
    assert.notEqual(tui.id, server.id);
  });
  it("warns with a fixed text and returns no cleanup when the TUI part cannot be set up, without a raw error", async () => {
    const plugin = await load("tui.js");
    const { result, warnings } = await quietly(() => plugin.setup({}));
    assert.equal(result, undefined);
    assert.deepEqual(warnings, [TUI_WARNING]);
    assert.ok(!/Cannot find|ERR_|undefined|TypeError/.test(warnings.join("")), "no raw error text");
  });
});
