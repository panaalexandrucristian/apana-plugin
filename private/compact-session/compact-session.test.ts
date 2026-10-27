import { expect, test, type TestBody } from "claude-code/testing";

const rows = [{ role: "user" as const, text: "active", toolUses: [] }];
const snapshot = [{ role: "user", content: [{ type: "text", text: "active" }] }];
const prepared = { text: "Verified history", artifact: "/local/CONTEXT.md", beforeChars: 10000, afterChars: 16 };
const end = { answer: "Pending", durationMs: 1, isAborted: false, turnId: "turn", reason: "answer" as const };

function setup(on: Parameters<TestBody>[1]) {
  on("session.id", () => ({ value: "active-session" }));
  on("session.messages", () => ({ value: snapshot }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("skill.prompt", (_, e) => ({ text: e.text }));
}

async function activate($: Parameters<TestBody>[0]) {
  return $.skill.prompt({
    skill: "apana:compact-session", source: "plugin", pluginName: "apana",
    text: "Skill instructions", frontmatter: {},
  });
}

function output(stdout: string, exitCode = 0, stderr = "") {
  return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } };
}

test("ordinary compaction reaches the engine unchanged", async ($, on) => {
  on("session.compact", (_, e) => ({ skip: `original ${e.trigger}` }));
  const result = await $.session.compact({ trigger: "manual", messages: rows });
  expect(result.skip).toBe("original manual");
});

test("frontmatter request plus native bridge returns a verified replacement", async ($, on) => {
  setup(on);
  let processCalls = 0;
  on("process.run", (_, e) => {
    if (e.argv[3] === "take") return output('{"pending":true}');
    processCalls++;
    expect(JSON.parse(e.init?.stdin ?? "{}")).toEqual({ sessionId: "active-session", messages: snapshot });
    return output(JSON.stringify(prepared));
  });
  on("session.compact", () => ({ skip: "Unexpected default summarizer" }));
  expect((await activate($)).text).toContain("compact-session-native-ready");
  expect(processCalls).toBe(0);
  const result = await $.turn.complete(end);
  expect(processCalls).toBe(1);
  expect(result.text).toContain("same session");
});

test("checker failure cannot fall through to a standard summary", async ($, on) => {
  setup(on);
  let coreCalls = 0;
  on("process.run", (_, e) => e.argv[3] === "take" ? output('{"pending":true}') : output("", 1, "roundtrip failed"));
  on("session.compact", () => { coreCalls++; return { messages: rows }; });
  await activate($);
  expect((await $.turn.complete(end)).text).toContain("roundtrip failed");
  expect(coreCalls).toBe(0);
});

for (const [label, beforeChars] of [["equal", 16], ["larger", 15]] as const) {
  test(`a valid ${label} replacement reports a measured no-op, not invalid data`, async ($, on) => {
    setup(on);
    on("process.run", (_, e) => e.argv[3] === "take" ? output('{"pending":true}') :
      output(JSON.stringify({ ...prepared, beforeChars })));
    on("session.compact", () => ({ skip: "Unexpected default summarizer" }));
    await activate($);
    const result = await $.turn.complete(end);
    expect(result.text).toContain("Context unchanged:");
    expect(result.text).toContain("verified replacement would not reduce context");
    expect(result.text).toContain(`${beforeChars} -> 16`);
  });
}

test("invalid data is distinct from a valid nonshrinking replacement", async ($, on) => {
  setup(on);
  on("process.run", (_, e) => e.argv[3] === "take" ? output('{"pending":true}') :
    output(JSON.stringify({ ...prepared, artifact: "relative-path" })));
  await activate($);
  expect((await $.turn.complete(end)).text).toContain("The compactor returned an invalid replacement.");
});

for (const outcome of ["success", "no-op", "failure"] as const) {
  for (const blocked of [false, true]) {
    test(`${outcome} report reaches the next accepted prompt (blocked first: ${blocked})`, async ($, on) => {
      setup(on);
      let drop = blocked;
      on("prompt.submit", (_, e) => drop ? { drop: "test block" } : { text: e.text, context: e.context });
      on("process.run", (_, e) => {
        if (e.argv[3] === "take") return output('{"pending":true}');
        if (outcome === "failure") return output("", 1, "roundtrip failed");
        return output(JSON.stringify({ ...prepared, beforeChars: outcome === "no-op" ? 15 : 10000 }));
      });
      on("session.compact", () => ({ skip: "Unexpected default summarizer" }));
      await activate($);
      const completion = await $.turn.complete(end);
      const status = completion.text.slice("Pending\n".length);
      if (blocked) {
        expect((await $.prompt.submit({ text: "Was it done?", wait: false, origin: { kind: "composer" } })).drop).toBe("test block");
        drop = false;
      }
      const prompt = { text: "Was it done?", context: ["existing context"], wait: false, origin: { kind: "composer" as const } };
      const result = await $.prompt.submit(prompt);
      expect(result.text).toBe(prompt.text);
      expect(result.context).toEqual(["existing context", `compact-session last result (already completed; do not rerun):\n${status}`]);
      expect((await $.prompt.submit(prompt)).context).toEqual(["existing context"]);
    });
  }
}

test("repeated invocation reports a no-op after success without compacting intervening turns", async ($, on) => {
  setup(on);
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }));
  let preparations = 0;
  on("process.run", (_, e) => {
    if (e.argv[3] === "take") return output('{"pending":true}');
    preparations++;
    return output(JSON.stringify({ ...prepared, beforeChars: preparations === 1 ? 10000 : 15 }));
  });
  on("session.compact", () => ({ skip: "Unexpected default summarizer" }));
  await activate($);
  expect((await $.turn.complete(end)).text).toContain("same session");
  expect((await $.turn.complete(end)).text).toBe("Pending");
  expect(preparations).toBe(1);
  await activate($);
  expect((await $.turn.complete(end)).text).toContain("verified replacement would not reduce context");
  expect(preparations).toBe(2);
  const result = await $.prompt.submit({ text: "Was it done?", wait: false, origin: { kind: "composer" } });
  expect(result.context?.[0]).toContain("Context unchanged:");
});

test("without the skill's frontmatter request, the bridge installs nothing", async ($, on) => {
  setup(on);
  let compactCalls = 0;
  on("process.run", () => output('{"pending":false}'));
  on("session.compact", () => { compactCalls++; return { messages: rows }; });
  await activate($);
  await $.turn.complete(end);
  expect(compactCalls).toBe(0);
});
