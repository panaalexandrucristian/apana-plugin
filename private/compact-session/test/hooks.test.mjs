import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = new URL("../../../hooks/compact-session.ts", import.meta.url);
const snapshot = [{ role: "user", content: [{ type: "text", text: "Only the active context" }] }];
const prepared = { text: "Verified compact history", artifact: "/local/CONTEXT.md", beforeChars: 5000, afterChars: 24 };
const end = { answer: "Pending", durationMs: 1, isAborted: false, turnId: "turn", reason: "answer" };

async function fixture(options = {}) {
  const { register } = await import(MODULE);
  const registrations = [];
  const calls = { core: [], processes: [], installed: [], ids: 0, snapshots: 0 };
  const on = (event, matcher, handler) => {
    if (typeof matcher === "function") { handler = matcher; matcher = undefined; }
    const registration = { event, matcher, handler };
    registrations.push(registration);
    return { catch(fn) { registration.fail = fn; } };
  };
  const processResult = (stdout, overrides) => ({
    exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false, ...overrides,
  });
  const $ = {
    plugin: { root: ROOT },
    session: {
      async id() { calls.ids++; return "active-session"; },
      async messages(args) { calls.snapshots++; assert.deepEqual(args, { as: "api" }); return options.snapshot ?? snapshot; },
      async compact(args) {
        if (options.busy) throw new Error("A turn is running");
        if (options.compactError) throw new Error(options.compactError);
        const result = await dispatch("session.compact", {
          trigger: "plugin", messages: [], ...args, ...options.compactEvent,
        });
        if (result.messages) calls.installed.push(result.messages);
        return result;
      },
    },
    process: {
      async run(argv, init) {
        calls.processes.push({ argv, init });
        if (argv[3] === "take") {
          if (options.requestError) throw new Error("request failed");
          return processResult(options.requestStdout ?? JSON.stringify({ pending: options.pending ?? true }), options.requestResult);
        }
        if (options.compactorError) throw new Error("compactor failed");
        return processResult(options.stdout ?? JSON.stringify(prepared), options.compactorResult);
      },
    },
  };
  register(on, {});
  async function dispatch(event, input) {
    const registration = registrations.find((item) => item.event === event && (!item.matcher ||
      Object.entries(item.matcher).every(([key, value]) => Array.isArray(value) ? value.includes(input[key]) : input[key] === value)));
    const next = async (forwarded) => {
      next.called = true;
      calls.core.push(event);
      if (event === "prompt.submit") {
        return options.dropPrompt ? { drop: "test block" } : { text: forwarded.text, context: forwarded.context };
      }
      return event === "session.compact" ? { skip: "core unchanged" } : { text: forwarded.text ?? forwarded.answer ?? "original" };
    };
    next.called = false;
    if (!registration) return next(input);
    try { return await registration.handler($, input, next); }
    catch (error) {
      if (!registration.fail) throw error;
      return registration.fail($, input, next, error);
    }
  }
  return {
    calls, dispatch, registrations,
    activate(overrides = {}) {
      return dispatch("skill.prompt", {
        skill: "apana:compact-session", pluginName: "apana", source: "plugin", text: "Skill instructions", frontmatter: {}, ...overrides,
      });
    },
    finish(overrides = {}) { return dispatch("turn.complete", { ...end, ...overrides }); },
  };
}

describe("compact-session skill-scoped native bridge", () => {
  for (const skill of ["compact-session", "apana:compact-session"]) {
    it(`recognizes ${skill} without requiring a path and waits for Stop`, async () => {
      const f = await fixture();
      assert.match((await f.activate({ skill })).text, /compact-session-native-ready/);
      assert.equal(f.calls.processes.length, 0);
      const result = await f.finish();
      assert.deepEqual(f.calls.installed, [[{ role: "user", text: prepared.text, toolUses: [] }]]);
      assert.match(result.text, /same session/);
      assert.match(result.text, /measured.*n=1/);
      assert.equal(f.calls.core.includes("session.compact"), false);
      const [request, compact] = f.calls.processes;
      assert.deepEqual(request.argv, ["python3", "-I", join(ROOT, "skills/compact-session/scripts/request_compaction.py"), "take", "active-session"]);
      assert.deepEqual(compact.argv, ["python3", "-I", join(ROOT, "skills/compact-session/scripts/compact_session.py")]);
      assert.deepEqual(JSON.parse(compact.init.stdin), { sessionId: "active-session", messages: snapshot });
      assert.equal(compact.init.timeoutMs, 600000);
      await f.finish();
      assert.equal(f.calls.processes.length, 2, "one invocation must not compact later turns");
    });
  }

  for (const activated of [false, true]) {
    for (const pending of [false, true]) {
      for (const reason of ["answer", "aborted", "refusal", "error"]) {
        it(`routes activated=${activated}, pending=${pending}, reason=${reason}`, async () => {
          const f = await fixture({ pending });
          if (activated) await f.activate();
          await f.finish({ reason, isAborted: reason === "aborted" });
          const handles = activated && pending && reason === "answer";
          assert.equal(f.calls.installed.length, handles ? 1 : 0);
          assert.equal(f.calls.processes.length, activated ? (handles ? 2 : 1) : 0);
          await f.finish();
          assert.equal(f.calls.installed.length, handles ? 1 : 0);
        });
      }
    }
  }

  for (const overrides of [
    { skill: "apana:compact-handoff" }, { skill: "other" }, { pluginName: "other" }, { source: "projectSettings" },
  ]) {
    it(`leaves unrelated skill ${JSON.stringify(overrides)} unchanged`, async () => {
      const f = await fixture();
      assert.deepEqual(await f.activate(overrides), { text: "Skill instructions" });
      await f.finish();
      assert.equal(f.calls.processes.length, 0);
    });
  }

  it("does not consume a main-session request at a subagent's end", async () => {
    const f = await fixture();
    await f.activate();
    await f.finish({ agentId: "child" });
    assert.equal(f.calls.processes.length, 0);
    await f.finish();
    assert.equal(f.calls.installed.length, 1);
  });

  for (const trigger of ["manual", "auto", "plugin", "precompute"]) {
    for (const instructions of [undefined, "apana:compact-session"]) {
      for (const agentId of [undefined, "child"]) {
        it(`does not hijack ordinary compaction ${trigger}/${instructions}/${agentId}`, async () => {
          const f = await fixture();
          await f.activate();
          assert.deepEqual(await f.dispatch("session.compact", { trigger, instructions, agentId, messages: [] }), { skip: "core unchanged" });
          assert.equal(f.calls.processes.length, 0);
        });
      }
    }
  }

  for (const [name, options] of [
    ["failed checker", { compactorResult: { exitCode: 1, stderr: "roundtrip failed" } }],
    ["truncated stdout", { compactorResult: { isStdoutTruncated: true } }],
    ["truncated stderr", { compactorResult: { isStderrTruncated: true } }],
    ["malformed output", { stdout: "not json" }],
    ["empty replacement", { stdout: JSON.stringify({ ...prepared, text: "" }) }],
    ["relative artifact", { stdout: JSON.stringify({ ...prepared, artifact: "relative" }) }],
    ["noninteger counts", { stdout: JSON.stringify({ ...prepared, afterChars: 1.5 }) }],
    ["empty snapshot", { snapshot: [] }],
    ["compactor exception", { compactorError: true }],
    ["busy session", { busy: true }],
    ["failed request", { requestResult: { exitCode: 1, stderr: "request failed" } }],
    ["truncated request", { requestResult: { isStdoutTruncated: true } }],
    ["malformed request", { requestStdout: "not json" }],
    ["request exception", { requestError: true }],
  ]) {
    it(`fails closed on ${name} and clears the one-shot request`, async () => {
      const f = await fixture(options);
      await f.activate();
      const result = await f.finish();
      assert.equal(f.calls.installed.length, 0);
      assert.equal(f.calls.core.includes("session.compact"), false);
      assert.doesNotMatch(result.text, /Context compacted/);
      const count = f.calls.processes.length;
      await f.finish();
      assert.equal(f.calls.processes.length, count);
    });
  }

  for (const beforeChars of [prepared.afterChars, prepared.afterChars - 1]) {
    it(`reports a verified no-op for ${beforeChars} -> ${prepared.afterChars} without installing or retrying`, async () => {
      const f = await fixture({ stdout: JSON.stringify({ ...prepared, beforeChars }) });
      await f.activate();
      const result = await f.finish();
      assert.ok(result.text.includes("Context unchanged: The verified replacement would not reduce context."));
      assert.ok(result.text.includes(`(measured; n=1): ${beforeChars} -> ${prepared.afterChars}`));
      assert.equal(result.text.includes("invalid"), false);
      assert.deepEqual(f.calls.installed, []);
      assert.equal(f.calls.core.includes("session.compact"), false);
      const count = f.calls.processes.length;
      await f.finish();
      assert.equal(f.calls.processes.length, count);
    });
  }

  it("distinguishes malformed replacements from verified no-ops", async () => {
    const f = await fixture({ stdout: JSON.stringify({ ...prepared, artifact: "relative" }) });
    await f.activate();
    assert.ok((await f.finish()).text.includes("The compactor returned an invalid replacement."));
    assert.deepEqual(f.calls.installed, []);
  });

  for (const outcome of ["success", "no-op", "failure"]) {
    for (const dropPrompt of [false, true]) {
      it(`delivers ${outcome} to the next accepted prompt (dropped first: ${dropPrompt})`, async () => {
        const options = { dropPrompt };
        if (outcome === "no-op") options.stdout = JSON.stringify({ ...prepared, beforeChars: 10 });
        if (outcome === "failure") options.compactorResult = { exitCode: 1, stderr: "roundtrip failed" };
        const f = await fixture(options);
        await f.activate();
        const completion = await f.finish();
        const status = completion.text.slice("Pending\n".length);
        const prompt = { text: "Was it done?", context: ["existing context"] };
        if (dropPrompt) {
          assert.deepEqual(await f.dispatch("prompt.submit", prompt), { drop: "test block" });
          options.dropPrompt = false;
        }
        const result = await f.dispatch("prompt.submit", prompt);
        assert.equal(result.text, prompt.text);
        assert.deepEqual(result.context, ["existing context", `compact-session last result (already completed; do not rerun):\n${status}`]);
        assert.deepEqual(await f.dispatch("prompt.submit", prompt), prompt);
      });
    }
  }

  it("replaces an undelivered success report with a later invocation's no-op", async () => {
    const options = {};
    const f = await fixture(options);
    await f.activate();
    assert.ok((await f.finish()).text.includes("same session"));
    const count = f.calls.processes.length;
    await f.finish();
    assert.equal(f.calls.processes.length, count);
    options.stdout = JSON.stringify({ ...prepared, beforeChars: 10 });
    await f.activate();
    assert.ok((await f.finish()).text.includes("verified replacement would not reduce context"));
    assert.equal(f.calls.installed.length, 1);
    const result = await f.dispatch("prompt.submit", { text: "Was it done?" });
    assert.ok(result.context[0].includes("Context unchanged:"));
    assert.equal(result.context[0].includes("Context compacted"), false);
  });

  it("reports native headless refusal without a snapshot, replacement or retry", async () => {
    const error = "session.compact is unavailable in headless mode";
    const f = await fixture({ compactError: error });
    await f.activate();
    const result = await f.finish();
    assert.ok(result.text.includes(error));
    assert.doesNotMatch(result.text, /Context compacted/);
    assert.equal(f.calls.snapshots, 0);
    assert.deepEqual(f.calls.installed, []);
    assert.equal(f.calls.processes.length, 1, "only consume the one-shot request");
    await f.finish();
    assert.equal(f.calls.processes.length, 1);
  });

  it("declares failure handlers and keeps global classic hook wiring unchanged", async () => {
    const f = await fixture();
    assert.deepEqual(f.registrations.map((r) => r.event), ["prompt.submit", "skill.prompt", "turn.complete", "session.compact"]);
    for (const registration of f.registrations) {
      if (registration.event !== "prompt.submit") assert.equal(typeof registration.fail, "function");
    }
    const skill = readFileSync(join(ROOT, "skills/compact-session/SKILL.md"), "utf8");
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
    assert.match(skill, /disable-model-invocation: true/);
    assert.match(skill, /hooks:\n  Stop:/);
    assert.match(skill, /request_compaction\.py" arm/);
    assert.match(skill, /once: true/);
    assert.deepEqual(hooks.modules, ["./compact-session.ts"]);
    assert.ok(hooks.hooks.UserPromptSubmit);
    assert.ok(hooks.hooks.PreToolUse);
    assert.equal(hooks.hooks.Stop, undefined);
  });
});
