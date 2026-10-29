import { expect, mock, test, type TestBody } from "claude-code/testing";

const TOOL = "mcp__apana-cooperation__coordinate";
const MEMBER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
type Row = Record<string, any>;

function world(on: Parameters<TestBody>[1], options: { revision?: number; ownerState?: string; continuation?: boolean; saved?: Row; respond?: (request: Row) => Row | undefined | Promise<Row | undefined> } = {}) {
  const clock = mock.clock(on, { now: 1000000 });
  let revision = options.revision ?? 0;
  let ownerState = options.ownerState ?? (revision ? "active" : "idle");
  let saved: any = options.saved;
  const requests: Row[] = [];
  const deliveries: string[] = [];
  let dropDelivery = false;
  const env: Record<string, string> = { CLAUDE_AUTO_COOPERATE: "1", CLAUDE_AUTO_COOP_MEMBER: MEMBER,
    CLAUDE_AUTO_COOP_GENERATION: "1", CLAUDE_AUTO_COOP_DB: "/tmp/native-cooperation-test/db",
    CLAUDE_AUTO_COOP_CONTINUATION: options.continuation ? "1" : "0" };
  mock.env(on, env);
  on("session.id", () => ({ value: SESSION }));
  on("session.model", () => ({ value: "haiku" }));
  on("tool.register", () => ({ value: { tool: TOOL } }));
  on("ui.status", () => ({ value: undefined }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("state.get", () => ({ value: { value: saved, version: 1 } }));
  on("state.set", (_, e) => { saved = e.value; return { value: { isSet: true, version: 2 } }; });
  on("prompt.submit", (_, e) => {
    if (e.origin.kind === "plugin") {
      deliveries.push(e.text);
      if (dropDelivery) return { drop: "Test drop" };
    }
    return { text: e.text, context: e.context };
  });
  on("process.run", async (_, e) => {
    const request = JSON.parse(e.init?.stdin ?? "{}");
    requests.push(request);
    let reply = await options.respond?.(request);
    if (!reply) {
      if (request.op === "prompt") { revision++; ownerState = "active"; }
      if (request.op === "idle") ownerState = "idle";
      reply = { ok: true, member: { owner_revision: revision, owner_state: ownerState }, task: null, tasks: [], members: [] };
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(reply), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return { clock, requests, deliveries, saved: () => saved, drop: (value: boolean) => { dropDelivery = value; } };
}

async function start($: Parameters<TestBody>[0]) {
  await $.session.start({ cwd: "/tmp/project", surface: null, isInteractive: false });
}
async function prompt($: Parameters<TestBody>[0], text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: "composer" } });
}
async function turn($: Parameters<TestBody>[0], text: string, turnId = text) {
  await $.turn.start({ text, turnId });
}
function stored(overrides: Row = {}) {
  return { shape: "cooperation-v1", identity: `${MEMBER}:1`, ownerRevision: 2, continuationConsumed: true,
    activeTurn: { id: "old-turn", revision: 1 }, pending: [], sequence: 0, suspended: false,
    notified: [], stopped: false, ...overrides };
}

test("all owner mutation RPCs carry the revision bound to this turn and return native text", async ($, on) => {
  const w = world(on);
  await start($); await prompt($, "Owner"); await turn($, "Owner");
  for (const action of ["publish", "decide", "withdraw", "finish"]) {
    const reply = await $.tool.call({ tool: TOOL, action, title: "Scope", instructions: "Evidence", task: TASK, decision: "accept", rationale: "Checked" });
    expect(typeof reply.result).toBe("string");
    const op = action === "finish" ? "idle" : action;
    expect(w.requests.filter(r => r.op === op).at(-1)?.expected_revision).toBe(1);
  }
});

test("an answer or clarification is not explicit finish", async ($, on) => {
  const w = world(on); await start($); await prompt($, "Owner"); await turn($, "Owner");
  w.requests.length = 0;
  await $.turn.complete({ answer: "Please clarify", durationMs: 1, isAborted: false, turnId: "Owner", reason: "answer" });
  expect(w.requests.some(r => r.op === "idle")).toBe(false);
});

test("queued prompts bind their own revision, never the latest submitted revision", async ($, on) => {
  const w = world(on); await start($);
  await prompt($, "First"); await turn($, "First");
  await prompt($, "Second"); await prompt($, "Third");
  await turn($, "Second"); await $.tool.call({ tool: TOOL, action: "finish" });
  expect(w.requests.filter(r => r.op === "idle").at(-1)?.expected_revision).toBe(2);
  await turn($, "Third"); await $.tool.call({ tool: TOOL, action: "finish" });
  expect(w.requests.filter(r => r.op === "idle").at(-1)?.expected_revision).toBe(3);
});

test("unmatched or ambiguous turn text fails closed rather than borrowing a newer revision", async ($, on) => {
  const w = world(on); await start($); await prompt($, "Same"); await prompt($, "Same");
  for (const text of ["Same", "engine merged or rewritten text"]) {
    await turn($, text);
    w.requests.length = 0;
    const reply = await $.tool.call({ tool: TOOL, action: "finish" });
    expect(typeof reply.deny).toBe("string");
    expect(w.requests.some(r => r.op === "idle")).toBe(false);
  }
});

test("explicit recovery finish permits helping without discarding unmatched owner submissions", async ($, on) => {
  let registryRevision = 0;
  const w = world(on, { respond: r => {
    if (r.op === "prompt") registryRevision++;
    if (r.op === "idle" && r.expected_revision !== registryRevision) return { ok: false, error: "stale owner revision" };
    return undefined;
  } });
  await start($);
  await prompt($, "First"); await prompt($, "Second");
  await turn($, "First and Second merged");
  await $.turn.complete({ answer: "Unbound", durationMs: 1, isAborted: false, turnId: "First and Second merged", reason: "answer" });
  await w.clock.advance(2000);
  expect(w.requests.some(r => r.op === "claim")).toBe(false);
  await prompt($, "Recovery"); await turn($, "Recovery");
  expect(typeof (await $.tool.call({ tool: TOOL, action: "finish" })).result).toBe("string");
  await w.clock.advance(2000);
  expect(w.requests.some(r => r.op === "claim")).toBe(false); // the owner turn is still running
  await $.turn.complete({ answer: "Done", durationMs: 1, isAborted: false, turnId: "Recovery", reason: "answer" });
  await w.clock.advance(2000);
  expect(w.requests.some(r => r.op === "claim")).toBe(true);
  expect(w.saved().pending.map((p: Row) => p.text)).toEqual(["First", "Second"]);
  await turn($, "First");
  expect(typeof (await $.tool.call({ tool: TOOL, action: "finish" })).deny).toBe("string");
  expect(w.requests.filter(r => r.op === "idle").at(-1)?.expected_revision).toBe(1);
});

for (const duplicate of [false, true]) {
  test(`reloaded stale submissions allow helping but retain revision ambiguity (duplicate=${duplicate})`, async ($, on) => {
    const w = world(on, { revision: 3, ownerState: "idle", saved: stored({ ownerRevision: 3, activeTurn: null, sequence: 3,
      pending: [{ id: 1, text: "First", revision: 1 }, { id: 2, text: "Second", revision: 2 },
        { id: 3, text: "Notification", revision: 3, notification: true }] }),
      respond: r => r.op === "idle" && r.expected_revision !== 3 ? { ok: false, error: "stale owner revision" } : undefined });
    await start($); await w.clock.advance(2000);
    expect(w.requests.some(r => r.op === "claim")).toBe(true);
    expect(w.saved().pending.length).toBe(3);
    if (duplicate) await prompt($, "First");
    await turn($, "First");
    const reply = await $.tool.call({ tool: TOOL, action: "finish" });
    expect(typeof reply.deny).toBe("string");
    if (duplicate) {
      expect(w.requests.some(r => r.op === "idle")).toBe(false);
    } else expect(w.requests.filter(r => r.op === "idle").at(-1)?.expected_revision).toBe(1);
  });
}

for (const revision of [null, 3, 4]) {
  test(`unresolved pending revision ${revision} still blocks an idle member after reload`, async ($, on) => {
    const w = world(on, { revision: 3, ownerState: "idle", saved: stored({ ownerRevision: 3, activeTurn: null, sequence: 1,
      pending: [{ id: 1, text: "Unresolved", revision }] }) });
    await start($); await w.clock.advance(2000);
    expect(w.requests.some(r => r.op === "claim")).toBe(false);
  });
}

for (const finish of [false, true]) {
  test(`recovery completion cannot enable helping without successful explicit finish (attempt=${finish})`, async ($, on) => {
    const w = world(on, { revision: 3, saved: stored({ ownerRevision: 3, activeTurn: null, sequence: 2,
      pending: [{ id: 1, text: "Stale", revision: 1 }, { id: 2, text: "Recovery", revision: 3 }] }),
      respond: r => r.op === "idle" ? { ok: false, error: "owner has outstanding tasks" } : undefined });
    await start($); await turn($, "Recovery");
    if (finish) expect(typeof (await $.tool.call({ tool: TOOL, action: "finish" })).deny).toBe("string");
    await $.turn.complete({ answer: "Still waiting", durationMs: 1, isAborted: false, turnId: "Recovery", reason: "answer" });
    await w.clock.advance(2000);
    expect(w.requests.some(r => r.op === "claim")).toBe(false);
  });
}

test("an in-flight fresh owner prompt blocks helping after recovery finish", async ($, on) => {
  let releasePrompt: (() => void) | undefined;
  const w = world(on, { revision: 3, ownerState: "idle", saved: stored({ ownerRevision: 3, activeTurn: null, sequence: 1,
    pending: [{ id: 1, text: "Stale", revision: 1 }] }), respond: r => r.op === "prompt"
      ? new Promise(resolve => { releasePrompt = () => resolve(undefined); }) : undefined });
  await start($);
  const submission = prompt($, "Fresh owner");
  await w.clock.settle();
  expect(typeof releasePrompt).toBe("function");
  await w.clock.advance(2000);
  expect(w.requests.some(r => r.op === "claim")).toBe(false);
  releasePrompt?.(); await submission;
  await w.clock.advance(2000);
  expect(w.requests.some(r => r.op === "claim")).toBe(false);
});

test("reload preserves the older running turn fence when newer owner work exists", async ($, on) => {
  const w = world(on, { revision: 2, saved: stored() }); await start($);
  await $.tool.call({ tool: TOOL, action: "finish" });
  expect(w.requests.filter(r => r.op === "idle").at(-1)?.expected_revision).toBe(1);
});

test("reload does not consume another human prompt as a handoff continuation", async ($, on) => {
  const w = world(on, { revision: 2, continuation: true, saved: stored() });
  await start($); await prompt($, "New human task");
  expect(w.requests.some(r => r.op === "prompt" && r.text === "New human task")).toBe(true);
});

test("failed owner registration disables mutation and helping until a successful new prompt", async ($, on) => {
  let fail = true;
  const w = world(on, { revision: 1, respond: r => r.op === "prompt" && fail ? { ok: false, error: "locked" } : undefined });
  await start($); await prompt($, "Not registered"); await turn($, "Not registered");
  w.requests.length = 0;
  expect(typeof (await $.tool.call({ tool: TOOL, action: "finish" })).deny).toBe("string");
  await w.clock.advance(4000);
  expect(w.requests.some(r => ["idle", "claim", "publish"].includes(r.op))).toBe(false);
  fail = false;
  await prompt($, "Registered"); await turn($, "Registered");
  expect(typeof (await $.tool.call({ tool: TOOL, action: "finish" })).result).toBe("string");
});

test("stalled delegation uses awaited clock and retries a dropped notification", async ($, on) => {
  const w = world(on, { revision: 1, respond: r => r.op === "results" ? { ok: true, tasks: [{ task: TASK, owner_revision: 1, state: "queued", created_at: 1000 }] } : undefined });
  await start($); w.drop(true);
  await w.clock.advance(28000); expect(w.deliveries.length).toBe(0);
  await w.clock.advance(2000); expect(w.deliveries.length).toBe(1);
  w.drop(false); await w.clock.advance(2000); expect(w.deliveries.length).toBe(2);
  await w.clock.advance(4000); expect(w.deliveries.length).toBe(2);
});

test("all waiting guidance preserves explicit owner instructions through unclaimed work and cancelled attempts", async ($, on) => {
  const w = world(on, { respond: r => r.op === "results" ? { ok: true, tasks: [{ task: TASK, owner_revision: 1, state: "queued", created_at: 970 }] } : undefined });
  await start($);
  const submitted = await $.prompt.submit({ text: "Wait for the peer until the agreed timeout", wait: false, origin: { kind: "composer" } });
  await turn($, "Wait for the peer until the agreed timeout");
  const published = await $.tool.call({ tool: TOOL, action: "publish", title: "Review", instructions: "Public evidence" });
  await $.turn.complete({ answer: "Waiting", durationMs: 1, isAborted: false, turnId: "Wait for the peer until the agreed timeout", reason: "answer" });
  await w.clock.advance(2000);
  expect(w.deliveries.length).toBe(1);
  expect(w.deliveries[0]).toContain("automated status update, not a new user request");
  const guidance = JSON.parse(String(published.result)).guidance;
  for (const text of [JSON.stringify(submitted), guidance, w.deliveries[0]]) {
    expect(text).toContain("Preserve any explicit user instruction to wait and any agreed timeout");
    expect(text).toContain("Do not withdraw or finish solely because work is queued or an attempt was cancelled");
    expect(text).toContain("the user's instructions allow continuing alone");
    expect(text).toContain("do not rely on an old availability count");
  }
  expect(w.requests.some(r => r.op === "withdraw")).toBe(false);
});

test("completed result delivery retries resolved drops and binds the notified revision", async ($, on) => {
  const w = world(on, { revision: 1, respond: r => r.op === "results" ? { ok: true, tasks: [{ task: TASK, owner_revision: 1, state: "completed" }] } : undefined });
  await start($); w.drop(true); await w.clock.advance(2000);
  expect(w.deliveries.length).toBe(1);
  w.drop(false); await w.clock.advance(2000); expect(w.deliveries.length).toBe(2);
  await prompt($, "Replacement");
  await turn($, w.deliveries[1]);
  await $.tool.call({ tool: TOOL, action: "finish" });
  expect(w.requests.filter(r => r.op === "idle").at(-1)?.expected_revision).toBe(1);
});

test("failed helper respects the awaited retry cooldown", async ($, on) => {
  const w = world(on, { respond: r => r.op === "claim" ? { ok: true, task: { task: TASK, lease: TASK, owner: SESSION, owner_revision: 1, title: "bounded", instructions: "Public evidence" } } : undefined });
  on("model.complete", () => ({ value: { isAnswered: false, reason: "api-error", status: 503, error: "overloaded_error", usage: {} } }));
  await start($); await w.clock.advance(2000);
  expect(w.requests.filter(r => r.op === "claim").length).toBe(1);
  await w.clock.advance(28000); expect(w.requests.filter(r => r.op === "claim").length).toBe(1);
  await w.clock.advance(2000); expect(w.requests.filter(r => r.op === "claim").length).toBe(2);
});

for (const cause of ["owner-prompt", "remote-withdrawal"] as const) {
  test(`${cause} aborts the actual isolated model dispatch and keeps membership alive`, async ($, on) => {
    let invalidLease = false;
    let claims = 0;
    let aborted = false;
    let helperText = "";
    const w = world(on, { respond: r => {
      if (r.op === "claim") return { ok: true, task: claims++ === 0 ? { task: TASK, lease: TASK, owner: SESSION, owner_revision: 1, title: "bounded", instructions: "PUBLIC_EVIDENCE" } : null };
      if (r.op === "heartbeat" && r.lease && invalidLease) return { ok: false, error: "stale or foreign claim" };
      return undefined;
    } });
    on("model.complete", (_, e, next) => {
      helperText = e.prompt;
      return new Promise(resolve => {
        next.signal.addEventListener("abort", () => { aborted = true; resolve({ value: { isAnswered: false, reason: "aborted", usage: {} } }); }, { once: true });
      });
    });
    await start($); await w.clock.advance(2000);
    expect(helperText).toContain("PUBLIC_EVIDENCE");
    expect(helperText.includes("PRIVATE_OWNER")).toBe(false);
    if (cause === "owner-prompt") await prompt($, "PRIVATE_OWNER");
    else { invalidLease = true; await w.clock.advance(2000); }
    await w.clock.settle();
    expect(aborted).toBe(true);
    const atAbort = w.requests.length;
    await w.clock.advance(4000);
    expect(w.requests.slice(atAbort).some(r => r.op === "heartbeat" && !r.lease)).toBe(true);
    expect(w.requests.some(r => r.op === "complete")).toBe(false);
  });
}

for (const failedHeartbeat of ["membership", "lease"] as const) {
  for (const completion of ["aborted", "late-answer"] as const) {
    test(`${failedHeartbeat} failure cancels and fences a helper with ${completion} completion`, async ($, on) => {
      let fail = false;
      let claimed = false;
      let aborted = false;
      let finish: ((value: any) => void) | undefined;
      const w = world(on, { respond: r => {
        if (r.op === "claim") {
          const task = claimed ? null : { task: TASK, lease: TASK, owner: SESSION, owner_revision: 1, title: "bounded", instructions: "Public evidence" };
          claimed = true;
          return { ok: true, task };
        }
        if (fail && r.op === "heartbeat" && Boolean(r.lease) === (failedHeartbeat === "lease")) {
          return { ok: false, error: failedHeartbeat === "membership" ? "unknown member or stale generation" : "stale or foreign claim" };
        }
        if (fail && r.op === "release") return { ok: false, error: "unknown member or stale generation" };
        return undefined;
      } });
      on("model.complete", (_, e, next) => new Promise(resolve => {
        finish = resolve;
        next.signal.addEventListener("abort", () => {
          aborted = true;
          if (completion === "aborted") resolve({ value: { isAnswered: false, reason: "aborted", usage: {} } });
        }, { once: true });
      }));
      await start($); await w.clock.advance(2000);
      expect(typeof finish).toBe("function");
      fail = true; await w.clock.advance(2000);
      expect(aborted).toBe(true);
      if (completion === "late-answer") finish?.({ value: { isAnswered: true, text: "Too late", usage: {} } });
      await w.clock.settle();
      expect(w.requests.some(r => r.op === "complete")).toBe(false);
      const releases = w.requests.filter(r => r.op === "release");
      expect(releases.length).toBe(1);
      expect(releases[0]).toEqual({ op: "release", member: MEMBER, generation: 1, task: TASK, lease: TASK,
        reason: failedHeartbeat === "membership" ? "membership-invalidated" : "lease-invalidated" });
      await w.clock.advance(4000);
      expect(w.requests.filter(r => r.op === "release").length).toBe(1);
      expect(w.requests.some(r => r.op === "complete")).toBe(false);
      expect(w.requests.filter(r => r.op === "claim").length).toBe(failedHeartbeat === "membership" ? 1 : 3);
    });
  }
}

test("a failed initial membership heartbeat cannot claim work and can recover", async ($, on) => {
  let fail = true;
  const w = world(on, { respond: r => r.op === "heartbeat" && fail ? { ok: false, error: "unknown member or stale generation" } : undefined });
  await start($); await w.clock.advance(2000);
  expect(w.requests.some(r => ["claim", "release", "complete"].includes(r.op))).toBe(false);
  fail = false; await w.clock.advance(2000);
  expect(w.requests.some(r => r.op === "claim")).toBe(true);
});

test("late membership failure does not release a helper already preempted by its owner", async ($, on) => {
  let delayHeartbeat = false;
  let failHeartbeat: (() => void) | undefined;
  let aborted = false;
  const w = world(on, { respond: r => {
    if (r.op === "claim") return { ok: true, task: { task: TASK, lease: TASK, owner: SESSION, owner_revision: 1, title: "bounded", instructions: "Public evidence" } };
    if (r.op === "heartbeat" && delayHeartbeat) return new Promise(resolve => {
      failHeartbeat = () => resolve({ ok: false, error: "unknown member or stale generation" });
    });
    return undefined;
  } });
  on("model.complete", (_, e, next) => new Promise(resolve => {
    next.signal.addEventListener("abort", () => {
      aborted = true;
      resolve({ value: { isAnswered: false, reason: "aborted", usage: {} } });
    }, { once: true });
  }));
  await start($); await w.clock.advance(2000);
  delayHeartbeat = true; await w.clock.advance(2000);
  expect(typeof failHeartbeat).toBe("function");
  await prompt($, "New owner task");
  expect(aborted).toBe(true);
  failHeartbeat?.(); await w.clock.settle();
  expect(w.requests.some(r => ["release", "complete"].includes(r.op))).toBe(false);
  expect(w.saved().ownerRevision).toBe(1);
  expect(w.saved().suspended).toBe(false);
});

test("membership loss after a settled helper does not release its delivered contribution", async ($, on) => {
  let fail = false;
  const w = world(on, { respond: r => {
    if (r.op === "claim") return { ok: true, task: { task: TASK, lease: TASK, owner: SESSION, owner_revision: 1, title: "bounded", instructions: "Public evidence" } };
    if (r.op === "heartbeat" && fail) return { ok: false, error: "unknown member or stale generation" };
    return undefined;
  } });
  on("model.complete", () => ({ value: { isAnswered: true, text: "Delivered", usage: {} } }));
  await start($); await w.clock.advance(2000);
  expect(w.requests.filter(r => r.op === "complete").length).toBe(1);
  fail = true; await w.clock.advance(4000);
  expect(w.requests.some(r => r.op === "release")).toBe(false);
  expect(w.requests.filter(r => r.op === "complete").length).toBe(1);
});

// Exact engine envelope observed in the failed real headless notification turn.
// The native test kit does not add this framing to manually raised turn.start.
function framedNotification(text: string) {
  return `The apana-cooperation plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;
}

for (const superseded of [false, true]) {
  test(`engine-framed result notification retains its submitted revision (superseded=${superseded})`, async ($, on) => {
    let registryRevision = 1;
    const w = world(on, { revision: 1, respond: r => {
      if (r.op === "prompt") registryRevision++;
      if (["decide", "idle"].includes(r.op) && r.expected_revision !== registryRevision) return { ok: false, error: "stale owner revision" };
      return r.op === "results" ? { ok: true, tasks: [{ task: TASK, owner_revision: 1, state: "completed" }] } : undefined;
    } });
    await start($); await w.clock.advance(2000);
    expect(w.deliveries.length).toBe(1);
    if (superseded) await prompt($, "Replacement owner task");
    await turn($, framedNotification(w.deliveries[0]));
    const reply = await $.tool.call({ tool: TOOL, action: "decide", task: TASK, decision: "accept", rationale: "Verified" });
    expect(typeof (superseded ? reply.deny : reply.result)).toBe("string");
    expect(w.requests.filter(r => r.op === "decide").at(-1)?.expected_revision).toBe(1);
    const finished = await $.tool.call({ tool: TOOL, action: "finish" });
    expect(typeof (superseded ? finished.deny : finished.result)).toBe("string");
    expect(w.requests.filter(r => r.op === "idle").at(-1)?.expected_revision).toBe(1);
    expect(w.saved().pending.some((p: Row) => p.notification)).toBe(false);
  });
}

test("modified or merged notification envelopes cannot claim a pending revision", async ($, on) => {
  const w = world(on, { revision: 1, respond: r => r.op === "results" ? { ok: true, tasks: [{ task: TASK, owner_revision: 1, state: "completed" }] } : undefined });
  await start($); await w.clock.advance(2000);
  const framed = framedNotification(w.deliveries[0]);
  for (const text of [framed + "\nAdditional queued task", framed.replace("apana-cooperation plugin", "another plugin"), `prefix ${w.deliveries[0]} suffix`]) {
    await turn($, text);
    w.requests.length = 0;
    expect(typeof (await $.tool.call({ tool: TOOL, action: "finish" })).deny).toBe("string");
    expect(w.requests.some(r => r.op === "idle")).toBe(false);
  }
});

test("a human prompt identical to a pending framed notification stays ambiguous", async ($, on) => {
  const w = world(on, { revision: 1, respond: r => r.op === "results" ? { ok: true, tasks: [{ task: TASK, owner_revision: 1, state: "completed" }] } : undefined });
  await start($); await w.clock.advance(2000);
  const text = framedNotification(w.deliveries[0]);
  await prompt($, text); await turn($, text);
  w.requests.length = 0;
  expect(typeof (await $.tool.call({ tool: TOOL, action: "finish" })).deny).toBe("string");
  expect(w.requests.some(r => r.op === "idle")).toBe(false);
});

test("clear stops cooperation explicitly rather than retaining old session attribution", async ($, on) => {
  const w = world(on); await start($);
  await $.session.end({ reason: "clear", sessionId: SESSION, resume: { id: SESSION } });
  expect(w.requests.some(r => r.op === "close")).toBe(true);
  w.requests.length = 0;
  await prompt($, "After clear"); await turn($, "After clear");
  expect(typeof (await $.tool.call({ tool: TOOL, action: "publish", title: "T", instructions: "I" })).deny).toBe("string");
  await w.clock.advance(4000);
  expect(w.requests.length).toBe(0);
});
