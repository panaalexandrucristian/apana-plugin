import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LOGIC_DIRECTIVE } from "../check.mjs";
import { composeOutput, handleLogicHook } from "../hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CODE = "Write a Python function that validates an email address.";
const SENTINEL = "SENTINEL-PROMPT-TEXT-DO-NOT-LEAK";

const expected = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: LOGIC_DIRECTIVE } };

describe("handleLogicHook", () => {
  it("adds the exact directive on an enabled code prompt, only on UserPromptSubmit", () => {
    assert.deepEqual(handleLogicHook("UserPromptSubmit", { prompt: CODE }, {}), expected);
    assert.ok(LOGIC_DIRECTIVE.length <= 520);
    for (const event of ["SessionStart", "PostToolUse", "PreToolUse", "Stop", "SessionEnd", undefined]) {
      assert.equal(handleLogicHook(event, { prompt: CODE }, {}), null, String(event));
    }
  });
  it("adds nothing for non-code prompts, a missing or non-string prompt, or when off", () => {
    assert.equal(handleLogicHook("UserPromptSubmit", { prompt: "If I double this recipe, how much flour?" }, {}), null);
    for (const input of [undefined, null, {}, { prompt: 42 }, { prompt: ["x"] }]) assert.equal(handleLogicHook("UserPromptSubmit", input, {}), null);
    assert.equal(handleLogicHook("UserPromptSubmit", { prompt: CODE }, { APANA_LOGIC_TEST_DEBUG: "off" }), null);
    assert.equal(handleLogicHook("UserPromptSubmit", { prompt: CODE }, { JEV_FLOW: "off" }) !== null, true, "JEV_FLOW=off does not disable it");
  });
});

describe("composeOutput", () => {
  it("returns the other output when one side is empty", () => {
    assert.equal(composeOutput(null, null), null);
    assert.equal(composeOutput(undefined, null), null);
    assert.deepEqual(composeOutput(null, expected), expected);
    const existing = { systemMessage: "m" };
    assert.equal(composeOutput(existing, null), existing);
  });
  it("keeps every existing field and joins additionalContext by a newline, without mutating", () => {
    const existing = Object.freeze({
      systemMessage: "note",
      hookSpecificOutput: Object.freeze({ hookEventName: "UserPromptSubmit", additionalContext: "flow context", extra: 1 }),
    });
    const out = composeOutput(existing, expected);
    assert.equal(out.systemMessage, "note");
    assert.equal(out.hookSpecificOutput.extra, 1);
    assert.equal(out.hookSpecificOutput.additionalContext, `flow context\n${LOGIC_DIRECTIVE}`);
    assert.equal(existing.hookSpecificOutput.additionalContext, "flow context");
  });
  it("adds the directive to an output that has only a systemMessage", () => {
    const out = composeOutput({ systemMessage: "tip" }, expected);
    assert.equal(out.systemMessage, "tip");
    assert.equal(out.hookSpecificOutput.additionalContext, LOGIC_DIRECTIVE);
  });
  it("leaves an incompatible existing output unchanged", () => {
    const other = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } };
    assert.equal(composeOutput(other, expected), other);
    const weird = { hookSpecificOutput: "text" };
    assert.equal(composeOutput(weird, expected), weird);
    assert.equal(composeOutput("string", expected), "string");
    const array = [1];
    assert.equal(composeOutput(array, expected), array);
    const badContext = { hookSpecificOutput: { additionalContext: 5 } };
    assert.equal(composeOutput(badContext, expected), badContext);
  });
});

// The real adapter seam (scripts/apana-hook.mjs) in a temporary tree, so no model, network or git state is touched. The
// nudge state goes to a temporary folder.
describe("scripts/apana-hook.mjs seam", () => {
  let tree;
  let state;
  const swapLogic = (dir) => {
    rmSync(join(tree, "private", "logic-test-debug"), { recursive: true, force: true });
    if (dir) cpSync(dir, join(tree, "private", "logic-test-debug"), { recursive: true });
  };
  const useRealLogic = () => {
    swapLogic(null);
    symlinkSync(join(ROOT, "private", "logic-test-debug"), join(tree, "private", "logic-test-debug"), "dir");
  };
  const run = (event, input, env = {}) => {
    const result = spawnSync(process.execPath, [join(tree, "scripts", "apana-hook.mjs"), event], {
      input: JSON.stringify({ hook_event_name: event, ...input }),
      env: { PATH: process.env.PATH, HOME: tree, APANA_CLASS_GRAPH_STATE_DIR: state, ...env },
      encoding: "utf8",
    });
    return { code: result.status, out: result.stdout, err: result.stderr, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };

  before(() => {
    tree = mkdtempSync(join(tmpdir(), "logic-seam-"));
    state = join(tree, "state");
    mkdirSync(join(tree, "scripts"));
    mkdirSync(join(tree, "private"));
    cpSync(join(ROOT, "scripts", "apana-hook.mjs"), join(tree, "scripts", "apana-hook.mjs"));
    symlinkSync(join(ROOT, "private", "class-graph-nudge"), join(tree, "private", "class-graph-nudge"), "dir");
    useRealLogic();
  });
  after(() => rmSync(tree, { recursive: true, force: true }));

  it("emits the exact directive on a code prompt and nothing on a non-code prompt", () => {
    useRealLogic();
    const code = run("UserPromptSubmit", { prompt: CODE });
    assert.equal(code.code, 0);
    assert.deepEqual(code.json, expected);
    const plain = run("UserPromptSubmit", { prompt: "What is a good pancake recipe?" });
    assert.equal(plain.code, 0);
    assert.equal(plain.out, "");
  });
  it("emits nothing for other events or with the switch off", () => {
    assert.equal(run("SessionStart", { prompt: CODE }).out, "");
    assert.equal(run("UserPromptSubmit", { prompt: CODE }, { APANA_LOGIC_TEST_DEBUG: "off" }).out, "");
  });
  it("joins the directive with the class-graph reminder of a session whose mode was recorded", () => {
    run("UserPromptSubmit", { session_id: "joined", prompt: "/apana:class-graph" });
    const result = run("UserPromptSubmit", { session_id: "joined", prompt: CODE });
    assert.equal(result.code, 0);
    const context = result.json.hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith(LOGIC_DIRECTIVE), "the directive comes first");
    assert.ok(context.length > LOGIC_DIRECTIVE.length, "the reminder follows it");
  });
  it("keeps exit code 0 and a neutral diagnostic when the logic module fails to load, and the nudge still works", () => {
    run("UserPromptSubmit", { session_id: "broken", prompt: "/apana:class-graph" });
    const broken = mkdtempSync(join(tmpdir(), "logic-broken-"));
    writeFileSync(join(broken, "hook.mjs"), `export function handleLogicHook( { this is not valid javascript ${SENTINEL}\n`);
    writeFileSync(join(broken, "check.mjs"), "export {};\n");
    swapLogic(broken);
    const result = run("UserPromptSubmit", { session_id: "broken", prompt: `${CODE} ${SENTINEL}` });
    rmSync(broken, { recursive: true, force: true });
    assert.equal(result.code, 0);
    assert.match(result.err, /\[logic-test-debug\] activation unavailable/);
    assert.ok(!result.err.includes(SENTINEL) && !result.out.includes(SENTINEL), "no prompt or exception text leaks");
    assert.ok(result.json.hookSpecificOutput.additionalContext.length > 0, "the nudge reminder is still delivered");
    assert.ok(!result.json.hookSpecificOutput.additionalContext.includes(LOGIC_DIRECTIVE));
    useRealLogic();
  });
  it("keeps exit code 0 and leaks nothing when the logic handler throws at run time", () => {
    const throwing = mkdtempSync(join(tmpdir(), "logic-throw-"));
    writeFileSync(join(throwing, "hook.mjs"), `export function handleLogicHook() { throw new Error("${SENTINEL}"); }\nexport function composeOutput(a) { return a; }\n`);
    swapLogic(throwing);
    const result = run("UserPromptSubmit", { prompt: CODE });
    rmSync(throwing, { recursive: true, force: true });
    assert.equal(result.code, 0);
    assert.equal(result.out, "");
    assert.ok(!result.err.includes(SENTINEL));
    useRealLogic();
  });
  it("works when the logic module is absent", () => {
    swapLogic(null);
    const result = run("UserPromptSubmit", { prompt: CODE });
    assert.equal(result.code, 0);
    assert.equal(result.out, "");
    useRealLogic();
  });
});
