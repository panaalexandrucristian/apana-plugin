import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EARLIER_DIRECTIVES, LOGIC_DIRECTIVE } from "../check.mjs";
import { parseTranscript, scoreTranscript } from "../eval/lib/transcript.mjs";

let n = 0;
const id = () => `toolu_${++n}`;
const line = (value) => JSON.stringify(value);
const use = (name, input, uid = id()) => ({ uid, event: line({ type: "assistant", message: { content: [{ type: "tool_use", id: uid, name, input }] } }) });
const answer = (uid, isError = false) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: uid, content: "ok", ...(isError ? { is_error: true } : {}) }] } });
const said = (text) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const end = (extra = {}) => line({ type: "result", subtype: "success", result: "done", ...extra });
const score = (lines, options) => scoreTranscript(lines.join("\n"), options);

describe("transcript scoring: loaded, not loaded, unknown", () => {
  it("counts a successful Skill call for the skill, plain or plugin-qualified", () => {
    for (const skill of ["logic-test-debug", "apana:logic-test-debug"]) {
      const s = use("Skill", { skill });
      assert.equal(score([s.event, answer(s.uid), end()]).loaded, "loaded", skill);
    }
  });
  it("counts a successful Read of the skill file", () => {
    const r = use("Read", { file_path: "/repo/skills/logic-test-debug/SKILL.md" });
    assert.equal(score([r.event, answer(r.uid), end()]).loaded, "loaded");
  });
  it("does not count a failed call, a wrong skill name or another file", () => {
    const failed = use("Skill", { skill: "logic-test-debug" });
    const wrong = use("Skill", { skill: "jev:handoff-verify" });
    const other = use("Read", { file_path: "/repo/skills/explica-clar/SKILL.md" });
    const result = score([failed.event, answer(failed.uid, true), wrong.event, answer(wrong.uid), other.event, answer(other.uid), end()]);
    assert.equal(result.loaded, "not_loaded");
    assert.equal(result.failedLoadAttempts, 1);
  });
  it("does not count a call that has no result yet", () => {
    const s = use("Skill", { skill: "logic-test-debug" });
    assert.equal(score([s.event, end()]).loaded, "not_loaded");
    assert.equal(score([s.event]).loaded, "unknown");
  });
  it("says not loaded only for a complete transcript with neither event", () => {
    assert.equal(score([said("hello"), end()]).loaded, "not_loaded");
    assert.equal(score([said("hello")]).loaded, "unknown", "no result event: incomplete");
    assert.equal(score([said("hello"), end({ subtype: "error_max_turns" })]).loaded, "unknown", "a limit exit is incomplete");
    assert.equal(score([said("hello"), end()], { limitExit: true }).loaded, "unknown");
  });
  it("treats a truncated last line as an incomplete transcript", () => {
    const parsed = parseTranscript(`${said("hi")}\n{"type":"result","sub`);
    assert.equal(parsed.broken, true);
    assert.equal(score([said("hi"), '{"type":"result","sub']).complete, false);
  });
  it("keeps a proven load even when the run later hit a limit", () => {
    const s = use("Skill", { skill: "logic-test-debug" });
    const result = score([s.event, answer(s.uid), end({ subtype: "error_max_turns" })]);
    assert.equal(result.loaded, "loaded");
    assert.equal(result.limitExit, true);
  });
});

describe("transcript scoring: application is separate from loading", () => {
  const record = "Scope: canAccess; token, member, paid, trial, suspended.\nMethod: t=2 (INFERENCE) over the five conditions.\nResult: ran node --test, all pass.";
  it("a record alone does not prove loading", () => {
    const result = score([said(record), end({ result: record })]);
    assert.equal(result.record.present, true);
    assert.equal(result.loaded, "not_loaded");
  });
  it("reads a record written with markdown emphasis, as the live sessions sometimes did", () => {
    const bold = "**Scope:** `canProceed(a, b)`.\n\n**Method:** Read the file by hand.\n\n**Result:** `true`.";
    assert.equal(score([end({ result: bold })]).record.present, true);
    assert.equal(score([end({ result: "**Scope**: x\n**Method**: y\n**Result**: z" })]).record.present, true);
    assert.equal(score([end({ result: "The Scope: is not at the start of a line" })]).record.present, false);
  });
  it("reads the three record fields and reports a missing one", () => {
    assert.equal(score([end({ result: "Scope: x\nMethod: y" })]).record.present, false);
    assert.equal(score([said(record), end()]).record.scope, "canAccess; token, member, paid, trial, suspended.");
  });
  it("does not flag a Result that says nothing was run (a case seen in the first live session)", () => {
    const said = "Scope: x\nMethod: condition reading.\nResult: read the file only, no tests or code run. The operators are plain JavaScript.";
    assert.equal(score([end({ result: said })]).unsupportedCheckClaim, false);
    assert.equal(score([end({ result: "Scope: a\nMethod: b\nResult: tests not run, unverified." })]).unsupportedCheckClaim, false);
    assert.equal(score([end({ result: "Scope: a\nMethod: b\nResult: all tests pass." })]).unsupportedCheckClaim, true);
  });
  it("flags a Result that claims checks when no command was run, but not a labelled dry run", () => {
    assert.equal(score([end({ result: record })]).unsupportedCheckClaim, true);
    const bash = use("Bash", { command: "node --test" });
    assert.equal(score([bash.event, answer(bash.uid), end({ result: record })]).unsupportedCheckClaim, false);
    assert.equal(score([end({ result: "Scope: a\nMethod: b\nResult: dry-run by hand, tests not run." })]).unsupportedCheckClaim, false);
  });
  it("sees the directive text in a transcript, for the non-code gate", () => {
    assert.equal(score([line({ type: "system", note: LOGIC_DIRECTIVE }), end()]).directiveSeen, true);
    assert.equal(score([said("plain answer"), end()]).directiveSeen, false);
  });
  it("still recognises the directive of plugin 0.10.0, so the first two campaigns can be scored again", () => {
    for (const earlier of EARLIER_DIRECTIVES) {
      const events = [line({ type: "system", subtype: "hook_response", output: earlier }), end()];
      const result = score(events);
      assert.equal(result.directiveSeen, true);
      assert.equal(result.directiveDelivered, true);
    }
    assert.equal(score([line({ type: "system", subtype: "hook_response", output: "something else" }), end()]).directiveDelivered, false);
  });
});
