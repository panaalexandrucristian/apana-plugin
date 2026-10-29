import { expect, test, type TestBody } from "claude-code/testing";

type Request = Record<string, unknown>;
const member = "11111111-1111-4111-8111-111111111111";
const session = "22222222-2222-4222-8222-222222222222";
function setup(on: Parameters<TestBody>[1], continuation = false, enabled = true,
               respond?: (request: Request) => Record<string, unknown>, freezeTimer = true) {
  const requests: Request[] = [];
  let state: unknown;
  on("state.get", () => ({ value: { value: state, version: 1 } }));
  on("state.set", (_, e) => { state = e.value; return { value: { isSet: true, version: 2 } }; });
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  const env: Record<string, string> = {
    CLAUDE_AUTO_COOPERATE: enabled ? "1" : "0",
    CLAUDE_AUTO_COOP_MEMBER: member, CLAUDE_AUTO_COOP_GENERATION: "1",
    CLAUDE_AUTO_COOP_DB: "/tmp/test-cooperation/registry.sqlite3",
    CLAUDE_AUTO_COOP_CONTINUATION: continuation ? "1" : "0",
  };
  on("env.get", (_, e) => ({ value: env[e.name] }));
  on("tool.register", () => ({ value: { tool: "mcp__apana-cooperation__coordinate" } }));
  on("ui.status", () => ({ value: undefined }));
  if (freezeTimer) on("clock.every", () => new Promise(() => {}));
  on("clock.now", () => ({ value: 1000 }));
  on("session.id", () => ({ value: session }));
  on("session.model", () => ({ value: "haiku" }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("process.run", (_, e) => {
    const request = JSON.parse(e.init?.stdin ?? "{}");
    requests.push(request);
    const response = respond ? respond(request) : { ok: true, member: { owner_revision: continuation ? 3 : 0, owner_state: "active" }, tasks: [], helped: [], contributions: [] };
    return { value: { exitCode: 0, stdout: JSON.stringify(response), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return requests;
}

test("disabled plugin has no registry side effects", async ($, on) => {
  const requests = setup(on, false, false);
  await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
  await $.prompt.submit({ text: "owner task", wait: false, origin: { kind: "composer" } });
  expect(requests).toEqual([]);
});

test("fresh member registers and can help before receiving an owner task", async ($, on) => {
  const requests = setup(on);
  await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
  expect(requests.map(r => r.op)).toEqual(["register", "idle"]);
  expect(requests[0].member).toBe(member);
  expect(requests[0].session).toBe(session);
});

for (const origin of ["composer", "bridge", "sdk"] as const) {
  test(`${origin} owner prompt fences assistance and remains unchanged`, async ($, on) => {
    const requests = setup(on);
    await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
    const result = await $.prompt.submit({ text: "new owner task", wait: false, origin: { kind: origin } });
    expect(requests.some(r => r.op === "prompt" && r.text === "new owner task")).toBe(true);
    expect(result.text).toBe("new owner task");
    expect(result.context?.join(" ")).toContain("separate");
  });
}

test("handoff preserves owner revision but next human prompt supersedes it", async ($, on) => {
  const requests = setup(on, true);
  await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
  await $.prompt.submit({ text: "Read HANDOFF.md", wait: false, origin: { kind: "composer" } });
  expect(requests.filter(r => r.op === "prompt")).toEqual([]);
  await $.prompt.submit({ text: "new task", wait: false, origin: { kind: "composer" } });
  expect(requests.filter(r => r.op === "prompt").length).toBe(1);
});

test("idle helper is context isolated and cancelled by owner submission", async ($, on) => {
  const task = "33333333-3333-4333-8333-333333333333";
  let fire: (() => void) | undefined;
  let started: (() => void) | undefined;
  let finish: ((value: unknown) => void) | undefined;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  const requests = setup(on, false, true, request => ({
    ok: true, member: { owner_revision: 0, owner_state: "idle" }, tasks: [],
    task: request.op === "claim" ? { task, lease: task, owner: session, owner_revision: 1, title: "bounded", instructions: "HELP_SNAPSHOT_ONLY" } : null,
  }), false);
  on("clock.every", () => new Promise(resolve => { fire = () => resolve({ value: undefined }); }));
  let helperPrompt = "";
  on("model.complete", (_, e) => {
    helperPrompt = e.prompt;
    started?.();
    return new Promise(resolve => { finish = resolve; });
  });
  await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
  await Promise.resolve();
  fire?.();
  await modelStarted;
  expect(helperPrompt).toContain("HELP_SNAPSHOT_ONLY");
  expect(helperPrompt.includes("OWNER_PRIVATE")).toBe(false);
  await $.prompt.submit({ text: "OWNER_PRIVATE new task", wait: false, origin: { kind: "composer" } });
  finish?.({ value: { isAnswered: true, text: "stale result", usage: {} } });
  await Promise.resolve();
  expect(requests.some(r => r.op === "prompt")).toBe(true);
  expect(requests.some(r => r.op === "complete")).toBe(false);
});

test("a final answer alone does not mark the owner's task complete", async ($, on) => {
  const requests = setup(on);
  await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
  requests.length = 0;
  await $.turn.complete({ answer: "I need your clarification", durationMs: 1, isAborted: false, turnId: "owner-turn", reason: "answer" });
  expect(requests.some(r => r.op === "idle")).toBe(false);
});

test("coordinate returns the native tool's text result shape", async ($, on) => {
  setup(on);
  await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
  await $.prompt.submit({ text: "Finish this task", wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: "Finish this task", turnId: "owner-turn" });
  const reply = await $.tool.call({ tool: "mcp__apana-cooperation__coordinate", action: "finish" });
  expect(typeof reply.result).toBe("string");
});

test("peer delivery never becomes an owner task", async ($, on) => {
  const requests = setup(on);
  await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
  await $.prompt.submit({ text: "help someone", wait: false, origin: { kind: "peer" } });
  expect(requests.filter(r => r.op === "prompt")).toEqual([]);
});
