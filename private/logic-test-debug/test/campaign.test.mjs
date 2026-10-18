import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { campaignOrder, remaining } from "../eval/lib/campaign.mjs";
import { permissionFingerprint } from "../eval/lib/run.mjs";

const EVAL = fileURLToPath(new URL("../eval/", import.meta.url));
const SESSIONS_BASE = mkdtempSync(join(tmpdir(), "ltd-test-sessions-"));
after(() => rmSync(SESSIONS_BASE, { recursive: true, force: true }));
const real = JSON.parse(readFileSync(join(EVAL, "budget.json"), "utf8"));
const order = campaignOrder(real.plan.planned);
const count = (scenario, arm) => order.filter((e) => e.scenario === scenario && (!arm || e.arm === arm)).length;

describe("the pre-registered order of the sessions", () => {
  it("has the 44 planned sessions: 4+4, 8+8, 8+8 and 4 non-code", () => {
    assert.equal(order.length, 44);
    assert.deepEqual([count("activation", "ON"), count("activation", "OFF"), count("conditions", "ON"), count("conditions", "OFF"), count("bug", "ON"), count("bug", "OFF"), count("nocode", "ON"), count("nocode", "OFF")], [4, 4, 8, 8, 8, 8, 4, 0]);
  });
  it("runs each pair back to back, ON first in odd pairs and OFF first in even pairs", () => {
    for (const scenario of ["activation", "conditions", "bug"]) {
      const rows = order.filter((e) => e.scenario === scenario);
      for (let i = 0; i < rows.length; i += 2) {
        assert.equal(rows[i].run, rows[i + 1].run, `${scenario} pair ${i / 2 + 1}`);
        assert.deepEqual([rows[i].arm, rows[i + 1].arm], rows[i].run % 2 === 1 ? ["ON", "OFF"] : ["OFF", "ON"]);
      }
    }
  });
  it("lists the non-code prompts once each, ON only, runs 1 to 4", () => {
    assert.deepEqual(order.filter((e) => e.scenario === "nocode").map((e) => `${e.arm}${e.run}`), ["ON1", "ON2", "ON3", "ON4"]);
  });
  it("has no duplicate session", () => {
    assert.equal(new Set(order.map((e) => `${e.scenario}/${e.arm}/${e.run}`)).size, 44);
  });
  it("skips what was already started as planned, and ignores reserve, retry and smoke starts", () => {
    const rows = [{ kind: "planned", scenario: "activation", arm: "ON", run: "1" }, { kind: "retry", scenario: "activation", arm: "OFF", run: "1" }];
    const left = remaining(order, rows);
    assert.equal(left.length, 43);
    assert.ok(!left.some((e) => e.scenario === "activation" && e.arm === "ON" && e.run === 1));
    assert.ok(left.some((e) => e.scenario === "activation" && e.arm === "OFF" && e.run === 1), "a retry does not replace the planned run");
  });
});

describe("the second campaign (harder tasks)", () => {
  const hard = JSON.parse(readFileSync(new URL("../eval/budget-hard.json", import.meta.url), "utf8"));
  it("plans 20 combos and 20 trace sessions as 10 alternating pairs each, and nothing else", () => {
    const order = campaignOrder(hard.plan.planned);
    assert.equal(order.length, 40);
    assert.deepEqual([...new Set(order.map((e) => e.scenario))], ["combos", "trace"]);
    for (const scenario of ["combos", "trace"]) {
      const mine = order.filter((e) => e.scenario === scenario);
      assert.equal(mine.filter((e) => e.arm === "ON").length, 10);
      assert.equal(mine.filter((e) => e.arm === "OFF").length, 10);
      assert.equal(mine[0].arm, "ON", "odd pairs start with ON");
      assert.equal(mine[2].arm, "OFF", "even pairs start with OFF");
    }
  });
  it("fits its own pool: plan plus reserve within the cap, with the first campaign's pool untouched", () => {
    const planned = Object.values(hard.plan.planned).reduce((a, b) => a + b, 0);
    assert.ok(planned + hard.plan.reserve <= hard.sessionsCap - hard.prior);
    assert.equal(hard.prior, 0);
    assert.notEqual(hard.ledger, real.ledger);
    assert.equal(hard.pluginRef, real.pluginRef, "the same plugin commit as the first campaign");
  });
});

describe("the campaign driver (stand-in binary, nothing real is started)", () => {
  const prepare = (mode) => {
    const root = mkdtempSync(join(tmpdir(), "ltd-camp-"));
    mkdirSync(join(root, "plugin"));
    writeFileSync(join(root, "plugin", ".plugin-commit"), `${real.pluginRef}\n`);
    // the start gate wants proof that these permissions held in a probe
    writeFileSync(join(root, "confinement.json"), JSON.stringify({ pass: true, fingerprint: permissionFingerprint({ pluginDir: join(root, "plugin") }) }));
    const bin = join(root, "claude-fake.mjs");
    writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("./fake.json", import.meta.url), "utf8"));
appendFileSync(cfg.record, "call\\n");
const emit = (o) => console.log(JSON.stringify(o));
emit({ type: "system", subtype: "init", model: "claude-haiku-fake" });
if (cfg.mode === "outside") {
  emit({ type: "assistant", message: { id: "m0", content: [{ type: "tool_use", id: "t0", name: "Read", input: { file_path: "/Users/someone/Downloads/cv.md" } }] } });
}
if (cfg.mode === "complete" || cfg.mode === "outside") {
  emit({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Scope: a\\nMethod: b\\nResult: no tests run." }] } });
  emit({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.01 });
}
`);
    chmodSync(bin, 0o755);
    writeFileSync(join(root, "fake.json"), JSON.stringify({ mode, record: join(root, "record.txt") }));
    const budget = { ...real, ledger: join(root, "ledger.tsv") };
    writeFileSync(join(root, "budget.json"), JSON.stringify(budget));
    return { root, bin, budgetPath: join(root, "budget.json") };
  };
  const drive = ({ root, bin, budgetPath }, ...args) => spawnSync(process.execPath, [join(EVAL, "campaign.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", LTD_SESSIONS_BASE: SESSIONS_BASE, LTD_ROOT: root, LTD_BUDGET: budgetPath, LTD_CLAUDE_BIN: bin, LTD_LEDGER: join(root, "ledger.tsv") } });

  it("--list shows what is left and starts nothing", () => {
    const t = prepare("complete");
    const r = drive(t, "--list", "--only", "nocode");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { left: 4, next: ["nocode/ON/1", "nocode/ON/2", "nocode/ON/3", "nocode/ON/4"] });
    assert.equal(existsSync(join(t.root, "ledger.tsv")), false, "no ledger line was written");
    assert.equal(existsSync(join(t.root, "record.txt")), false, "the binary was not called");
  });
  it("runs the sessions in order and then stops at the limit it was given", () => {
    const t = prepare("complete");
    const r = drive(t, "--only", "nocode", "--limit", "2");
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(JSON.parse(lines[0]).run, 1);
    assert.equal(JSON.parse(lines[1]).run, 2);
    assert.match(lines[2], /^done: 2 sessions$/);
    assert.equal(readFileSync(join(t.root, "record.txt"), "utf8").trim().split("\n").length, 2);
  });
  it("stops at the first session that is not complete and starts nothing after it", () => {
    const t = prepare("incomplete");
    const r = drive(t, "--only", "nocode");
    assert.equal(r.status, 4);
    assert.match(r.stdout, /STOP: s1 ended with status incomplete; nothing further was started/);
    assert.equal(readFileSync(join(t.root, "record.txt"), "utf8").trim().split("\n").length, 1);
  });
  it("stops at once when a session used a path outside its workspace", () => {
    const t = prepare("outside");
    const r = drive(t, "--only", "nocode");
    assert.equal(r.status, 5, r.stdout + r.stderr);
    assert.match(r.stdout, /STOP: s1 used a path outside its workspace \(Read \/Users\/someone\/Downloads\/cv.md\)/);
    assert.equal(readFileSync(join(t.root, "record.txt"), "utf8").trim().split("\n").length, 1, "nothing was started after it");
  });
  it("refuses to start anything without proof of confinement", () => {
    const t = prepare("complete");
    rmSync(join(t.root, "confinement.json"));
    const r = drive(t, "--only", "nocode", "--limit", "1");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refused: confinement is not proven/);
    assert.equal(existsSync(join(t.root, "record.txt")), false, "the binary was not called");
  });
  it("resumes without repeating a session already started", () => {
    const t = prepare("complete");
    drive(t, "--only", "nocode", "--limit", "1");
    const r = drive(t, "--only", "nocode", "--limit", "1");
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).run, 2);
  });
});
