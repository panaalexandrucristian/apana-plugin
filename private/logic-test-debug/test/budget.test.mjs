import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { finishSession } from "../eval/lib/ledger.mjs";
import { loadBudget, refusal, startBudgeted, status } from "../eval/lib/budget.mjs";

const CLI = fileURLToPath(new URL("../eval/session-budget.mjs", import.meta.url));
const REAL = fileURLToPath(new URL("../eval/budget.json", import.meta.url));
const dir = () => mkdtempSync(join(tmpdir(), "ltd-budget-"));
const withBudget = (overrides = {}) => {
  const d = dir();
  const real = JSON.parse(JSON.stringify(loadBudgetFile()));
  const budget = { ...real, ...overrides, ledger: join(d, "ledger.tsv") };
  const path = join(d, "budget.json");
  writeFileSync(path, JSON.stringify(budget));
  return { path, budget: { ...budget }, ledger: budget.ledger };
};
import { readFileSync } from "node:fs";
const loadBudgetFile = () => JSON.parse(readFileSync(REAL, "utf8"));
const planned = (scenario, arm, n) => Array.from({ length: n }, (_, i) => ({ kind: "planned", scenario, arm, run: String(i + 1), model: "haiku" }));

afterEach(() => {
  delete process.env.LTD_BUDGET;
  delete process.env.LTD_LEDGER;
});

describe("the recorded budget", () => {
  it("is the delegated decision: 50 sessions, none used elsewhere, 44 planned plus 6 reserve, a USD guard", () => {
    const real = loadBudgetFile();
    assert.equal(real.sessionsCap, 50);
    assert.equal(real.prior, 0);
    assert.deepEqual(real.plan.planned, { activation: 8, conditions: 16, bug: 16, nocode: 4 });
    assert.equal(real.plan.reserve, 6);
    assert.equal(Object.values(real.plan.planned).reduce((a, b) => a + b, 0) + real.plan.reserve, 50);
    assert.equal(real.usdGuard, 5);
    assert.match(real.decision, /jev_decide/);
    assert.equal(real.openCode.sessions, 4);
  });
  it("loads, expanding ~ in the ledger path, and rejects a plan that exceeds the cap", () => {
    const loaded = loadBudget(REAL);
    assert.ok(!loaded.ledger.startsWith("~"));
    const { path } = withBudget({ sessionsCap: 40 });
    assert.throws(() => loadBudget(path), /exceeds the cap/);
  });
});

describe("what the budget lets start", () => {
  it("allows exactly the planned runs per scenario and arm, then refuses a further planned run", () => {
    const { budget } = withBudget();
    for (const request of planned("activation", "ON", 4)) startBudgeted(budget, request);
    assert.match(refusal(budget, { kind: "planned", scenario: "activation", arm: "ON" }), /planned 4 runs of activation arm ON/);
    assert.equal(refusal(budget, { kind: "planned", scenario: "activation", arm: "OFF" }), null);
  });
  it("refuses an unknown scenario and an arm the scenario does not have", () => {
    const { budget } = withBudget();
    assert.match(refusal(budget, { kind: "planned", scenario: "other", arm: "ON" }), /unknown scenario/);
    assert.match(refusal(budget, { kind: "planned", scenario: "nocode", arm: "OFF" }), /no arm OFF/);
  });
  it("limits everything that is not planned to the reserve of 6", () => {
    const { budget } = withBudget();
    for (let i = 0; i < 6; i += 1) startBudgeted(budget, { kind: i % 2 ? "retry" : "reserve", scenario: "bug", arm: "ON", run: String(i), model: "haiku" });
    assert.match(refusal(budget, { kind: "smoke", scenario: "activation", arm: "ON" }), /reserve of 6 is used/);
  });
  it("fits the whole plan in exactly 50 sessions and refuses the 51st", () => {
    const { budget } = withBudget();
    const all = [...planned("activation", "ON", 4), ...planned("activation", "OFF", 4), ...planned("conditions", "ON", 8), ...planned("conditions", "OFF", 8), ...planned("bug", "ON", 8), ...planned("bug", "OFF", 8), ...planned("nocode", "ON", 4)];
    for (const request of all) startBudgeted(budget, request);
    for (let i = 0; i < 6; i += 1) startBudgeted(budget, { kind: "reserve", scenario: "bug", arm: "ON", run: `r${i}`, model: "haiku" });
    assert.equal(status(budget).started, 50);
    assert.equal(status(budget).allowance, 0);
    assert.match(refusal(budget, { kind: "retry", scenario: "bug", arm: "ON" }), /session cap is used up/);
  });
  it("stops at the USD guard", () => {
    const { budget } = withBudget();
    const a = startBudgeted(budget, planned("activation", "ON", 1)[0]);
    finishSession({ path: budget.ledger, id: a.id, status: "ok", usd: 5 });
    assert.match(refusal(budget, { kind: "planned", scenario: "activation", arm: "OFF" }), /USD guard of 5 is reached/);
  });
  it("counts a session once even after it finishes", () => {
    const { budget } = withBudget();
    const a = startBudgeted(budget, planned("bug", "ON", 1)[0]);
    finishSession({ path: budget.ledger, id: a.id, status: "incomplete", usd: 0.03 });
    assert.equal(status(budget).started, 1);
    assert.equal(status(budget).byScenario["bug/ON/planned"], 1);
  });
});

describe("the session-budget command line", () => {
  const run = (budgetPath, ledger, ...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", LTD_BUDGET: budgetPath, LTD_LEDGER: ledger } });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  it("starts, finishes and reports, and refuses with exit code 3", () => {
    const { path, ledger } = withBudget();
    const first = run(path, ledger, "start", "--kind", "planned", "--scenario", "nocode", "--arm", "ON", "--run", "1", "--model", "haiku");
    assert.deepEqual([first.code, first.out], [0, "s1"]);
    assert.equal(run(path, ledger, "finish", "--id", "s1", "--status", "ok", "--usd", "0.04").out, "ok");
    const report = JSON.parse(run(path, ledger, "status").out);
    assert.equal(report.started, 1);
    assert.equal(report.allowance, 49);
    assert.ok(Math.abs(report.usdSpent - 0.04) < 1e-9);
    for (const n of [2, 3, 4]) run(path, ledger, "start", "--kind", "planned", "--scenario", "nocode", "--arm", "ON", "--run", String(n), "--model", "haiku");
    const refused = run(path, ledger, "start", "--kind", "planned", "--scenario", "nocode", "--arm", "ON", "--run", "5", "--model", "haiku");
    assert.equal(refused.code, 3);
    assert.match(refused.err, /^refused: /);
  });
  it("lets only 6 of 12 simultaneous reserve starts through, with unique ids, in a directory that does not exist yet", async () => {
    const { spawn } = await import("node:child_process");
    const { path } = withBudget();
    const ledger = join(dir(), "nested", "deeper", "ledger.tsv");
    const start = (n) => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, "start", "--kind", "smoke", "--scenario", "activation", "--arm", "ON", "--run", String(n), "--model", "haiku"], { env: { PATH: process.env.PATH ?? "", LTD_BUDGET: path, LTD_LEDGER: ledger } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code, out: out.trim() }));
    });
    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => start(n)));
    const accepted = results.filter((r) => r.code === 0);
    assert.equal(accepted.length, 6, JSON.stringify(results));
    assert.equal(new Set(accepted.map((r) => r.out)).size, 6, "ids are unique");
    assert.equal(results.filter((r) => r.code === 3).length, 6);
  });
  it("exits 2 on an unknown command and 1 on a broken budget file", () => {
    const { path, ledger } = withBudget();
    assert.equal(run(path, ledger, "bogus").code, 2);
    writeFileSync(path, "not json");
    assert.equal(run(path, ledger, "status").code, 1);
  });
});
