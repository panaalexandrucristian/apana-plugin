import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_INTENT_TEXT, deriveIntent, storedIntent } from "../intents.mjs";

describe("deriveIntent", () => {
  it("reads the scope command with a task, with an approval, and with nothing after it", () => {
    assert.deepEqual(deriveIntent("/apana:scope fix login"), { v: 1, kind: "scope", text: "/apana:scope fix login" });
    assert.equal(deriveIntent("/apana:scope approve 1234-abcd").kind, "scope");
    assert.equal(deriveIntent("  /apana:scope").kind, "scope");
    assert.equal(deriveIntent("/apana:scope\nfix\nit").text, "/apana:scope\nfix\nit");
  });
  it("does not take a longer command name, or the name inside a sentence, for scope", () => {
    for (const text of ["/apana:scoped x", "please run /apana:scope x", "scope", "/apana:scopes"]) assert.equal(deriveIntent(text), null, text);
  });
  it("starts Jev by its command or by the user's attached skill, and compact-session or others by neither", () => {
    assert.equal(deriveIntent("/apana:jev-decision-loop").kind, "jev");
    assert.equal(deriveIntent("fix the bug", ["jev-decision-loop"]).kind, "jev");
    assert.equal(deriveIntent("/apana:jev-decision-loopy"), null);
    assert.equal(deriveIntent("compact please", ["compact-session"]), null);
    assert.equal(deriveIntent("/apana:compact-session"), null);
  });
  it("starts the class-graph mode only by the bare command", () => {
    assert.equal(deriveIntent("/apana:class-graph").kind, "class-graph");
    assert.equal(deriveIntent("/class-graph").kind, "class-graph");
    assert.equal(deriveIntent("/apana:class-graph who uses Foo"), null);
  });
  it("gives nothing for an ordinary prompt, a non-string and a text over the limit", () => {
    assert.equal(deriveIntent("fix the bug in a.js"), null);
    assert.equal(deriveIntent(null), null);
    assert.equal(deriveIntent(`/apana:scope ${"x".repeat(MAX_INTENT_TEXT)}`), null);
    assert.equal(deriveIntent(`/apana:scope ${"x".repeat(MAX_INTENT_TEXT - 20)}`).kind, "scope");
  });
});

describe("storedIntent", () => {
  const good = { apana: { v: 1, kind: "scope", text: "/apana:scope x" } };
  it("accepts what deriveIntent produced and returns only its fields", () => {
    assert.deepEqual(storedIntent({ apana: { ...good.apana, extra: 1 } }), good.apana);
  });
  it("rejects metadata that is missing, of another version or kind, or of the wrong type", () => {
    for (const metadata of [undefined, null, {}, { apana: null }, { apana: "scope" }, { apana: { ...good.apana, v: 2 } }, { apana: { ...good.apana, kind: "compact" } }, { apana: { ...good.apana, text: 5 } }, { apana: { ...good.apana, text: "x".repeat(MAX_INTENT_TEXT + 1) } }]) {
      assert.equal(storedIntent(metadata), null, JSON.stringify(metadata)?.slice(0, 60));
    }
  });
});
