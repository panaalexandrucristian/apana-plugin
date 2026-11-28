import assert from "node:assert/strict";
import { it } from "node:test";
import { setupAdvisor } from "../advisor.mjs";
import { fakeCtx } from "./support/fake-ctx.mjs";

const SELECTED = { providerID: "stub", modelID: "m", question: "" };
const MODEL = { id: "m", providerID: "stub", enabled: true, variants: [], capabilities: { tools: true, input: ["text"] } };

async function setup(deadlineMs) {
  const fake = fakeCtx({ models: [MODEL] });
  let rpc;
  fake.ctx.rpc.register = async (_contract, handlers) => {
    rpc = handlers;
    return { dispose: async () => {} };
  };
  const waiting = Promise.withResolvers();
  fake.ctx.session.wait = (_input, { signal }) => {
    waiting.resolve();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const advisor = await setupAdvisor(fake.ctx, {}, { deadlineMs });
  const sessionID = `ses_test_${fake.directory}`;
  return { ...advisor, calls: fake.calls, rpc, waiting: waiting.promise, source: { sessionID, ...SELECTED } };
}

it("cancellation releases an assembled parent request and does not start a child", async () => {
  const advisor = await setup();
  try {
    const running = advisor.rpc.consult(advisor.source);
    await advisor.waiting;
    const message = { id: "msg_source", role: "user", content: [] };
    const request = { sessionID: advisor.source.sessionID, messages: [message], tools: {} };
    const blocked = advisor.onContext(request);
    assert.deepEqual(advisor.rpc.cancel(advisor.source), { cancelled: true });
    await blocked;
    assert.deepEqual(await running, { ok: false, message: "Advisor cancelled." });
    assert.deepEqual(request.messages, [message]);
    assert.deepEqual(advisor.calls.create, []);
    assert.deepEqual(advisor.rpc.cancel(advisor.source), { cancelled: false });
  } finally {
    await advisor.dispose();
  }
});

it("a consultation times out when the source is busy and never reaches a safe boundary", async () => {
  const advisor = await setup(40);
  try {
    assert.deepEqual(await advisor.rpc.consult(advisor.source), { ok: false, message: "Advisor timed out." });
    assert.deepEqual(advisor.calls.create, []);
    assert.deepEqual(advisor.rpc.cancel(advisor.source), { cancelled: false });
  } finally {
    await advisor.dispose();
  }
});
