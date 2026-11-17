import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STALE_MS, createCompaction } from "../compaction.mjs";
import { setupApana } from "../plugin.mjs";
import { fakeCtx, tempDir, userMessage } from "./support/fake-ctx.mjs";

const sid = "ses_a";
const prepared = { text: "Verified compact history", artifact: "/archive/CONTEXT.md", beforeChars: 5000, afterChars: 24 };

function setup(options = {}) {
  const fake = fakeCtx();
  const clock = { t: 1_000_000 };
  const calls = [];
  const prepareSnapshot = async (snapshot, extra) => {
    calls.push({ snapshot, extra });
    if (options.prepareError) throw options.prepareError;
    return "result" in options ? options.result : prepared;
  };
  const compaction = createCompaction(fake.ctx, { prepareSnapshot, now: () => clock.t, newToken: () => `token-${calls.length}-${clock.t}` });
  return { fake, clock, calls, compaction };
}
const install = async (s) => s.compaction.install((pending) => pending);
const run = (s, id = sid, messages = [{ role: "user", id: "msg_1", content: [{ type: "text", text: "task" }] }]) => s.fake.fire("session.compaction", { sessionID: id, messages, system: [], tools: {}, options: {}, agent: "build", model: {} });
const state = (s, id = sid) => s.fake.ctx.storage.get(`compact/${id}`);

describe("asking for a compaction", () => {
  it("records the request before asking OpenCode, with the delivery the user chose", async () => {
    const s = setup();
    let seen;
    s.fake.ctx.session.compact = async (input) => {
      seen = { input, state: await state(s) };
      return { id: "msg_c" };
    };
    await s.compaction.request(sid, "queue");
    assert.deepEqual(seen.input, { sessionID: sid, delivery: "queue" });
    assert.equal(seen.state.state, "requested", "the hook may run before compact() returns");
  });
  it("does not start a second request while one is pending, but does once it is stale", async () => {
    const s = setup();
    await s.compaction.request(sid);
    await assert.rejects(s.compaction.request(sid), /already pending/);
    assert.equal(s.fake.calls.compact.length, 1);
    s.clock.t += STALE_MS + 1;
    await s.compaction.request(sid);
    assert.equal(s.fake.calls.compact.length, 2);
  });
  it("leaves nothing pending when OpenCode refuses the request", async () => {
    const s = setup();
    s.fake.state.compactError = new Error("A turn is running");
    await assert.rejects(s.compaction.request(sid), /could not ask OpenCode for a compaction; the context is unchanged/);
    assert.equal(await state(s), undefined);
    s.fake.state.compactError = null;
    await s.compaction.request(sid);
  });
});

describe("the compaction hook", () => {
  it("leaves every compaction that was not asked for to OpenCode", async () => {
    const s = setup();
    await install(s);
    const event = await run(s);
    assert.equal(event.result, undefined);
    assert.equal(s.calls.length, 0);
  });
  it("leaves a request that went stale alone", async () => {
    const s = setup();
    await install(s);
    await s.compaction.request(sid);
    s.clock.t += STALE_MS + 1;
    const event = await run(s);
    assert.equal(event.result, undefined);
    assert.equal(s.calls.length, 0);
  });
  it("replaces the model's summary by the verified text and keeps no recent tail beside it", async () => {
    const s = setup();
    await install(s);
    await s.compaction.request(sid);
    const messages = [userMessage("msg_1", "task"), { role: "assistant", id: "msg_2", content: [{ type: "text", text: "ok" }] }];
    const event = await run(s, sid, messages);
    assert.equal(event.result.summary, prepared.text);
    assert.ok("keepID" in event.result.metadata && event.result.metadata.keepID === undefined, "keepID is present and undefined, which disables the recent tail on 2.3.0");
    assert.deepEqual(event.result.metadata.apana, { token: (await state(s)).token, artifact: prepared.artifact, beforeChars: 5000, afterChars: 24 });
    assert.deepEqual(s.calls[0].snapshot, { sessionId: sid, messages }, "the request as OpenCode gave it, ids and metadata included");
    assert.equal((await state(s)).state, "installed");
  });
  it("does not install a replacement that is not smaller: it throws, with a message that says no-op, and the state says noop", async () => {
    for (const afterChars of [5000, 6000]) {
      const s = setup({ result: { ...prepared, afterChars } });
      await install(s);
      await s.compaction.request(sid);
      const error = await run(s).then(() => null, (e) => e);
      assert.match(error.message, /would not reduce the context \(5000 -> \d+ characters\); the context is unchanged \(no-op\)/);
      assert.equal(error.stack, error.message, "no stack trace in what OpenCode stores");
      const st = await state(s);
      assert.equal(st.state, "noop");
      assert.equal(st.after, afterChars);
    }
  });
  it("fails closed when the compactor fails, returns invalid output or cannot be run, and never falls back to a model summary", async () => {
    const detail = Object.assign(new Error("the compactor failed"), { detail: "compact-session: unsupported content part at messages[0].content[0]: 'media' for user" });
    for (const [label, options] of [["fails", { prepareError: detail }], ["throws", { prepareError: new Error("spawn python3 ENOENT") }], ["invalid", { result: { text: "", artifact: "relative" } }], ["null", { result: null }], ["floats", { result: { ...prepared, afterChars: 1.5 } }]]) {
      const s = setup(options);
      await install(s);
      await s.compaction.request(sid);
      const event = { sessionID: sid, messages: [], system: [] };
      const error = await s.fake.fire("session.compaction", event).then(() => null, (e) => e);
      assert.match(error?.message ?? "", /could not be prepared; the context is unchanged and no summary was requested/, label);
      assert.equal(event.result, undefined, label);
      assert.equal((await state(s)).state, "failed", label);
      assert.ok(!(error.message).includes("ENOENT") && !error.message.includes("media"), "the stored message carries no detail");
    }
  });
  it("consumes the request: a second compaction is OpenCode's own", async () => {
    const s = setup();
    await install(s);
    await s.compaction.request(sid);
    await run(s);
    const again = await run(s);
    assert.equal(again.result, undefined);
    assert.equal(s.calls.length, 1);
  });
  it("keeps sessions apart", async () => {
    const s = setup();
    await install(s);
    await s.compaction.request("ses_a");
    const other = await run(s, "ses_b");
    assert.equal(other.result, undefined);
    assert.equal((await state(s, "ses_a")).state, "requested");
  });
});

describe("the outcome told to the model", () => {
  const ready = async (options) => {
    const s = setup(options);
    await install(s);
    await s.compaction.request(sid);
    await run(s).catch(() => {});
    return s;
  };
  const recorded = (s) => [{ type: "compaction", status: "completed", metadata: { apana: { token: "" } } }].map((m) => ({ ...m, metadata: { apana: { token: s.token } } }));
  it("says compacted only when OpenCode recorded the replacement", async () => {
    const s = await ready();
    s.fake.state.context = recorded(await state(s));
    const text = await s.compaction.report(sid, "msg_9");
    assert.match(text, /^Context compacted in the same session\. Characters \(measured; n=1\): 5000 -> 24\. Recoverable history: \/archive\/CONTEXT\.md$/);
  });
  it("says the replacement was not recorded when OpenCode has no such compaction (it was not committed)", async () => {
    const s = await ready();
    s.fake.state.context = [{ type: "compaction", status: "failed" }, { type: "compaction", status: "completed", metadata: { apana: { token: "someone-else" } } }];
    const text = await s.compaction.report(sid, "msg_9");
    assert.match(text, /OpenCode did not record it, so the context is unchanged/);
    assert.ok(!text.includes("Context compacted"));
  });
  it("waits and says nothing when the record cannot be read, instead of guessing", async () => {
    const s = await ready();
    s.fake.state.contextError = new Error("unavailable");
    assert.equal(await s.compaction.report(sid, "msg_9"), null);
    assert.equal((await state(s)).state, "installed");
    s.fake.state.contextError = null;
    s.fake.state.context = recorded(await state(s));
    assert.match(await s.compaction.report(sid, "msg_9"), /^Context compacted/);
  });
  it("tells a no-op and a failure apart, each in its own words", async () => {
    const noop = await ready({ result: { ...prepared, afterChars: 5000 } });
    const a = await noop.compaction.report(sid, "msg_9");
    assert.match(a, /^Context unchanged: the verified replacement would not reduce context\. Prepared transcript characters \(measured; n=1\): 5000 -> 5000\./);
    assert.match(a, /records this run as a failed compaction/);
    const failed = await ready({ prepareError: Object.assign(new Error("x"), { detail: "compact-session: unsupported content part at messages[2]: 'media'" }) });
    const b = await failed.compaction.report(sid, "msg_9");
    assert.match(b, /^Context unchanged: the compact-session replacement could not be prepared \(compact-session: unsupported content part/);
    assert.match(b, /No model summary was requested/);
    assert.ok(!a.includes("could not be prepared") && !b.includes("would not reduce"));
  });
  it("is given in every request of the turn of the first message that sees it, and ends with a newer message", async () => {
    const s = await ready();
    s.fake.state.context = recorded(await state(s));
    const first = await s.compaction.report(sid, "msg_9");
    assert.equal(await s.compaction.report(sid, "msg_9"), first);
    assert.equal(await s.compaction.report(sid, "msg_9"), first);
    assert.equal(await s.compaction.report(sid, "msg_10"), null);
    assert.equal(await state(s), undefined);
  });
  it("is not consumed by a prompt that is never admitted: nothing is read until a request is built", async () => {
    const s = await ready();
    assert.equal((await state(s)).state, "installed");
    await s.fake.fire("session.prompt", { sessionID: sid, messageID: "msg_x", prompt: { text: "hello" } });
    assert.equal((await state(s)).state, "installed");
  });
  it("is given once when no user message has an id, and says nothing while a request is still being handled", async () => {
    const noid = await ready();
    noid.fake.state.context = recorded(await state(noid));
    assert.match(await noid.compaction.report(sid, undefined), /^Context compacted/);
    assert.equal(await noid.compaction.report(sid, undefined), null);
    const waiting = setup();
    await waiting.compaction.request(sid);
    assert.equal(await waiting.compaction.report(sid, "msg_1"), null);
    waiting.clock.t += STALE_MS + 1;
    assert.equal(await waiting.compaction.report(sid, "msg_1"), null);
    assert.equal(await state(waiting), undefined, "a stale request is dropped");
  });
});

describe("unloading", () => {
  it("ends a compactor that is still running", () => {
    const s = setup();
    const killed = [];
    const children = new Set([{ kill: (signal) => killed.push(signal) }, { kill: (signal) => killed.push(signal) }]);
    // The real prepare() adds its child to the set it was given; the plugin keeps one set and kills it on dispose.
    const compaction = createCompaction(s.fake.ctx, {
      prepareSnapshot: async (_snapshot, { children: set }) => {
        children.forEach((child) => set.add(child));
        return prepared;
      },
    });
    return compaction.request(sid).then(async () => {
      await compaction.install((p) => p);
      await s.fake.fire("session.compaction", { sessionID: sid, messages: [] }).catch(() => {});
      await s.fake.fire("session.compaction", { sessionID: sid, messages: [] });
      compaction.dispose();
      assert.deepEqual(killed, ["SIGKILL", "SIGKILL"]);
    });
  });
});

describe("in the plugin", () => {
  it("delivers the outcome to the model with the next request, as a note of the system prompt", async () => {
    const fake = fakeCtx();
    await setupApana(fake.ctx, { XDG_STATE_HOME: tempDir(), HOME: tempDir() }, {
      compaction: { prepareSnapshot: async () => prepared },
    });
    await fake.commands.find((c) => c.name === "apana:compact-session").execute({ sessionID: sid, delivery: "steer", prompt: { text: "" } });
    const token = (await fake.ctx.storage.get(`compact/${sid}`)).token;
    const event = await fake.fire("session.compaction", { sessionID: sid, messages: [userMessage("msg_1", "x")] });
    assert.equal(event.result.metadata.apana.token, token);
    fake.state.context = [{ type: "compaction", status: "completed", metadata: { apana: { token } } }];
    const request = { sessionID: sid, messages: [userMessage("msg_2", "next")], system: [] };
    await fake.fire("session.context", request);
    assert.deepEqual(request.system.map((p) => p.text), [`compact-session result (completed; do not rerun): Context compacted in the same session. Characters (measured; n=1): 5000 -> 24. Recoverable history: /archive/CONTEXT.md`]);
    const next = { sessionID: sid, messages: [userMessage("msg_2", "next"), userMessage("msg_3", "later")], system: [] };
    await fake.fire("session.context", next);
    assert.deepEqual(next.system, []);
  });
});
