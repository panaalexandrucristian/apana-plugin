import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONFINED_PERMISSION, confineScript, confinementProven, judgeConfine, permissionFingerprint, prepareSentinels, writeProof } from "../eval/opencode/confine.mjs";
import { capsOf, ledgerStart, ledgerVoid, oracleScore, scanAgentCode, summarizeMessages, summarizeProbe } from "../eval/opencode/real.mjs";
import { PLAN, makePlan, toMarkdown } from "../eval/opencode/campaign.mjs";
import { clopperPearson } from "../eval/lib/stats.mjs";

const dirs = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ltd-ocf-"));
  dirs.push(dir);
  return dir;
};
let sentinels;
const allSentinels = [];
after(() => {
  allSentinels.forEach((s) => s.cleanupTmp());
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const rejected = JSON.stringify({ error: { type: "permission.rejected", message: "Permission denied: external_directory" }, content: [] });
const unavailable = JSON.stringify({ error: { type: "tool.execution", message: 'No tool named "shell" is currently available.' }, content: [] });
const logFor = (script, results) => JSON.stringify({ n: 1, body: { tools: [{ function: { name: "read" } }], messages: [{ role: "user", content: "x" }, ...results.map((content) => ({ role: "tool", content }))] } });

function setup() {
  const root = temp();
  sentinels = prepareSentinels(root);
  allSentinels.push(sentinels);
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "hello.txt"), "hello inside\n");
  writeFileSync(join(workspace, "control.txt"), "ok");
  const script = confineScript(workspace, sentinels);
  const good = script.map((step) => (step.expect === "allowed" ? (step.label.startsWith("read") ? "1: hello inside" : step.label.startsWith("skill") ? "<skill_content name=\"x\">" : "Created file") : step.expect === "rejected" ? rejected : unavailable));
  return { root, workspace, script, good };
}

describe("judgeConfine", () => {
  it("passes when every outside attempt is refused, the controls work and the sentinels are untouched", () => {
    const { workspace, script, good } = setup();
    const verdict = judgeConfine({ logText: logFor(script, good), script, sentinels, workspace });
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.pass, true);
    assert.equal(verdict.table.length, script.length);
  });
  it("fails when a refused step was allowed, and names it", () => {
    const { workspace, script, good } = setup();
    const results = [...good];
    results[1] = "OCSENTINEL leaked? no: plain allowed text";
    const verdict = judgeConfine({ logText: logFor(script, results), script, sentinels, workspace });
    assert.equal(verdict.pass, false);
    assert.ok(verdict.reasons.some((r) => r.startsWith("read sentinel in run root")));
  });
  it("fails when the token comes back in a result", () => {
    const { workspace, script, good } = setup();
    const results = [...good];
    results[2] = `${rejected} ${sentinels.token}`;
    const verdict = judgeConfine({ logText: logFor(script, results), script, sentinels, workspace });
    assert.ok(verdict.reasons.includes("the sentinel token came back in a tool result"));
  });
  it("fails when a sentinel changed or a new file appeared next to it", () => {
    const { workspace, script, good } = setup();
    writeFileSync(sentinels.files[0], "changed");
    writeFileSync(join(sentinels.dirs[1], "new.txt"), "x");
    const verdict = judgeConfine({ logText: logFor(script, good), script, sentinels, workspace });
    assert.ok(verdict.reasons.some((r) => /sentinel 0 changed/.test(r)));
    assert.ok(verdict.reasons.some((r) => /new files in/.test(r)));
    writeFileSync(sentinels.files[0], readFileSync(sentinels.files[1], "utf8"));
  });
  it("fails when results are missing or a control did not work", () => {
    const { workspace, script, good } = setup();
    assert.equal(judgeConfine({ logText: logFor(script, good.slice(0, 5)), script, sentinels, workspace }).pass, false);
    rmSync(join(workspace, "control.txt"));
    const verdict = judgeConfine({ logText: logFor(script, good), script, sentinels, workspace });
    assert.ok(verdict.reasons.includes("the control file was not written inside the workspace"));
  });
});

describe("proof file", () => {
  it("is valid only for the same permission set and version", () => {
    const root = temp();
    assert.equal(confinementProven(root, "2.0.22"), false);
    writeProof(root, "2.0.22", "/p");
    assert.equal(confinementProven(root, "2.0.22"), true);
    assert.equal(confinementProven(root, "2.0.23"), false);
    assert.notEqual(permissionFingerprint("a"), permissionFingerprint("b"));
    assert.equal(CONFINED_PERMISSION.external_directory, "deny");
    assert.equal(CONFINED_PERMISSION.shell, "deny");
  });
});

const message = (type, data) => ({ type, data });
describe("summarizeMessages and summarizeProbe", () => {
  const messages = [
    message("user", { text: '"Implement canAccess"', files: [] }),
    message("assistant", { content: [{ type: "tool", name: "skill", state: { status: "completed", input: { id: "logic-test-debug" } } }, { type: "tool", name: "read", state: { status: "error", input: { path: "/x" }, error: { type: "permission.rejected" } } }], finish: "tool-calls", tokens: { input: 10, output: 2, reasoning: 0 }, cost: 0 }),
    message("assistant", { content: [{ type: "text", text: "Scope: the access rule.\nMethod: pairs, INFERENCE.\nResult: edited, nothing run." }], finish: "stop", tokens: { input: 20, output: 5, reasoning: 1 }, cost: 0 }),
  ];
  it("reads the skill load, the refused attempts, the record and the totals", () => {
    const s = summarizeMessages(messages);
    assert.equal(s.assistantMessages, 2);
    assert.equal(s.skillLoaded, true);
    assert.deepEqual(s.rejected, [{ name: "read" }]);
    assert.equal(s.record.present, true);
    assert.equal(s.finished, "stop");
    assert.deepEqual(s.tokens, { input: 30, output: 7, reasoning: 1 });
  });
  it("tells a tool that is not offered from an ordinary failure of a tool that exists", () => {
    const m = [message("assistant", { content: [
      { type: "tool", name: "bash", state: { status: "error", input: { command: "npm test" }, error: { type: "tool.execution", message: 'No tool named "bash" is currently available. Please use a tool from the available tool list.' } } },
      { type: "tool", name: "edit", state: { status: "error", input: {}, error: { type: "tool.execution", message: "Could not find oldString in test/pricing.test.mjs." } } },
    ], finish: "stop" })];
    const s = summarizeMessages(m);
    assert.deepEqual(s.unavailable, ["bash"]);
    assert.deepEqual(s.toolErrors, ["edit"]);
  });
  it("does not count a failed skill call or a different skill as a load", () => {
    const failed = [message("assistant", { content: [{ type: "tool", name: "skill", state: { status: "error", input: { id: "logic-test-debug" } } }, { type: "tool", name: "skill", state: { status: "completed", input: { id: "jev" } } }], finish: "stop" })];
    const s = summarizeMessages(failed);
    assert.equal(s.skillLoaded, false);
    assert.equal(s.skillAttempts, 2);
    assert.equal(s.record.present, false);
  });
  it("counts the main agent's requests with the directive and ignores the locator subagent", () => {
    const log = [{ at: "context", agent: "build", directive: true }, { at: "context", agent: "jev-locator", directive: false }, { at: "context", agent: "build", directive: false }].map((r) => JSON.stringify(r)).join("\n");
    assert.deepEqual(summarizeProbe(log), { modelRequests: 2, withDirective: 1, firstHasDirective: true });
  });
});

describe("report", () => {
  it("lists the sessions and the gates with counts only", () => {
    const verdict = (id, arm, directive) => ({ id, arm, model: "m", version: "2.0.22", complete: true, seconds: 10, probe: { modelRequests: 3, withDirective: directive ? 1 : 0, firstHasDirective: directive }, session: { skillLoaded: directive, record: { present: false }, toolCalls: ["read", "read", "write"], rejected: [] }, oracle: { passed: 100, total: 136, success: false, outOfScope: [] } });
    const md = toMarkdown([verdict("s1", "ON", true), verdict("s2", "OFF", false)]);
    assert.match(md, /no effect is claimed/);
    assert.match(md, /every ON session had the directive in its first model request: true/);
    assert.match(md, /no OFF session had it: true/);
    assert.match(md, /in every model request of the session \(plugin 0\.10\.4 and later\): false/, "1 of 3 requests is not every request");
    assert.match(md, /read×2 write×1/);
    assert.deepEqual(PLAN.map((p) => p.arm), ["ON", "OFF", "OFF", "ON"]);
  });
});

describe("ledger", () => {
  const start = (root, id, kind = "planned") => ledgerStart(root, { id, kind, scenario: "conditions", arm: "ON", run: 1 });
  it("refuses a fifth planned session and a seventh in all", () => {
    const root = temp();
    for (const id of ["s1", "s2", "s3", "s4"]) start(root, id);
    assert.throws(() => start(root, "s5"), /planned sessions already started/);
    start(root, "r1", "reserve");
    start(root, "r2", "reserve");
    assert.throws(() => start(root, "r3", "reserve"), /cap reached: 6 of 6/);
  });
  it("does not count a voided attempt, and lets the same id start again", async () => {
    const root = temp();
    start(root, "s1");
    await new Promise((r) => setTimeout(r, 5));
    ledgerVoid(root, "s1", "no model request");
    await new Promise((r) => setTimeout(r, 5));
    for (const id of ["s1", "s2", "s3", "s4"]) start(root, id);
    assert.throws(() => start(root, "s5"), /planned sessions already started/);
    const lines = readFileSync(join(root, "ledger.tsv"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.filter((l) => l.includes("\tvoid\t")).length, 1, "the void line stays in the ledger");
  });
});

describe("hard-task helpers", () => {
  it("scores combos only when both clean versions pass", () => {
    assert.equal(oracleScore("combos", { clean: { correct: true, equivalent: true }, killed: ["S1", "P1", "T1"] }), 3);
    assert.equal(oracleScore("combos", { clean: { correct: true, equivalent: false }, killed: ["S1", "P1", "T1"] }), 0);
    assert.equal(oracleScore("trace", { passed: 44 }), 44);
    assert.equal(oracleScore("combos", {}), 0);
  });
  it("scans only the files the agent changed or added, for code that reaches outside a pure function", () => {
    const root = temp();
    const ws = join(root, "ws");
    mkdirSync(join(ws, "test"), { recursive: true });
    mkdirSync(join(ws, "src"), { recursive: true });
    // Copy the frozen fixture so changedFiles has something to compare with.
    const fixture = join(import.meta.dirname, "fixtures", "combos");
    cpSync(fixture, ws, { recursive: true });
    assert.deepEqual(scanAgentCode(ws, "combos"), [], "the untouched fixture is clean");
    writeFileSync(join(ws, "test", "pricing.test.mjs"), 'import test from "node:test";\nimport { quote } from "../src/pricing.js";\ntest("x", () => quote({}));\n');
    assert.deepEqual(scanAgentCode(ws, "combos"), [], "a plain test is clean");
    writeFileSync(join(ws, "test", "pricing.test.mjs"), 'import { execSync } from "node:child_process";\nexecSync("id");\n');
    assert.match(scanAgentCode(ws, "combos")[0], /pricing\.test\.mjs: child_process/);
    writeFileSync(join(ws, "test", "pricing.test.mjs"), 'const m = await import("../src/pricing.js");\n');
    assert.deepEqual(scanAgentCode(ws, "combos"), [], "a relative dynamic import is allowed");
    writeFileSync(join(ws, "test", "pricing.test.mjs"), 'const m = await import("node:" + "fs");\n');
    assert.equal(scanAgentCode(ws, "combos").length, 1, "a computed dynamic import is not");
    assert.deepEqual(scanAgentCode(ws, "conditions"), [], "only the scenarios whose oracle runs agent code are scanned");
  });
  it("adds the combos scores and the behaviour table to the report", () => {
    const v = (id, arm, killed, loops) => ({ id, arm, scenario: "combos", model: "m", version: "2.0.22", complete: true, seconds: 1, probe: { modelRequests: 2, withDirective: arm === "ON" ? 2 : 0, firstHasDirective: arm === "ON" }, session: { skillLoaded: arm === "ON", record: { present: arm === "ON" }, toolCalls: ["write"], rejected: [] }, oracle: { passed: 2 + killed.length, total: 13, success: false, score: killed.length, killed, clean: { correct: true, equivalent: true }, skipped: false, outOfScope: [] }, behaviour: { editedTests: true, testLoops: loops, mentionsCombination: arm === "ON", mentionsInference: arm === "ON" } });
    const md = toMarkdown([v("s1", "ON", ["S1", "P1"], 3), v("s2", "OFF", ["S1"], 0)]);
    assert.match(md, /Scores of the task `combos`/);
    assert.match(md, /\| s1 \| ON \| true, true \| 2 \| 2 \| false \|/);
    assert.match(md, /Behaviour measures/);
    assert.match(md, /\| s2 \| OFF \| true \| 0 \| false \| false \|/);
  });
});

describe("plan, caps and the larger report", () => {
  it("alternates the first arm of each pair", () => {
    assert.deepEqual(makePlan(2).map((p) => p.arm), ["ON", "OFF", "OFF", "ON"]);
    assert.deepEqual(makePlan(3).map((p) => p.arm), ["ON", "OFF", "OFF", "ON", "ON", "OFF"]);
    assert.deepEqual(makePlan(10).map((p) => p.id).slice(-2), ["s19", "s20"]);
    assert.equal(makePlan(10).filter((p) => p.arm === "ON").length, 10);
  });
  it("takes the caps from caps.json and falls back to 4 and 6", () => {
    const root = temp();
    assert.deepEqual(capsOf(root), { planned: 4, total: 6 });
    writeFileSync(join(root, "caps.json"), JSON.stringify({ planned: 20, total: 22 }));
    assert.deepEqual(capsOf(root), { planned: 20, total: 22 });
    for (let i = 1; i <= 20; i += 1) ledgerStart(root, { id: `s${i}`, kind: "planned", scenario: "combos", arm: "ON", run: 1 });
    assert.throws(() => ledgerStart(root, { id: "s21", kind: "planned", scenario: "combos", arm: "ON", run: 1 }), /20 of 20 planned/);
    writeFileSync(join(root, "caps.json"), "not json");
    assert.deepEqual(capsOf(root), { planned: 4, total: 6 });
  });
  it("matches known exact binomial intervals", () => {
    const near = (a, b) => assert.ok(Math.abs(a - b) < 2e-3, `${a} vs ${b}`);
    const a = clopperPearson(1, 4);
    near(a.low, 0.0063);
    near(a.high, 0.8059);
    const b = clopperPearson(0, 10);
    assert.equal(b.low, 0);
    near(b.high, 0.3085);
    const c = clopperPearson(5, 20);
    near(c.low, 0.0866);
    near(c.high, 0.491);
    assert.throws(() => clopperPearson(5, 4));
  });
  it("adds Fisher rows, the score test and the failure rate when each arm has five sessions", () => {
    const v = (id, arm, clean, killed) => ({ id, arm, scenario: "combos", model: "m", version: "2.0.22", complete: true, seconds: 1, probe: { modelRequests: 2, withDirective: arm === "ON" ? 2 : 0, firstHasDirective: arm === "ON" }, session: { skillLoaded: arm === "ON", record: { present: arm === "ON" }, toolCalls: ["write"], rejected: [] }, oracle: { passed: 0, total: 13, success: false, score: clean ? killed : 0, killed: Array(killed).fill("x"), clean: { correct: clean, equivalent: clean }, skipped: false, outOfScope: [] }, behaviour: { editedTests: true, testLoops: 0, mentionsCombination: false, mentionsInference: false } });
    const verdicts = [];
    for (let i = 0; i < 5; i += 1) verdicts.push(v(`a${i}`, "ON", true, 9), v(`b${i}`, "OFF", i !== 0, 10));
    const md = toMarkdown(verdicts);
    assert.match(md, /Exact two-sided Fisher tests/);
    assert.match(md, /\| skill loaded \| 5\/5 \| 0\/5 \|/);
    assert.match(md, /the one pre-registered comparison/);
    assert.match(md, /A clean version failed in 1 of 10 sessions/);
    assert.doesNotMatch(toMarkdown(verdicts.slice(0, 4)), /Exact two-sided Fisher tests/);
  });
});
