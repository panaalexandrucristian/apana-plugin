import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyCodePrompt } from "../check.mjs";
import { handleLogicHook } from "../hook.mjs";
import { FIXTURES_DIR, SCENARIOS, auditWorkspace, changedFiles, createWorkspace, hashTree, readLock, sha256 } from "../eval/lib/workspace.mjs";

const EVAL = join(dirname(fileURLToPath(import.meta.url)), "..", "eval");
const prompts = JSON.parse(readFileSync(join(EVAL, "prompts.json"), "utf8"));
const hardPrompts = JSON.parse(readFileSync(join(EVAL, "prompts-hard.json"), "utf8"));
const lock = readLock();

describe("frozen fixtures and prompts", () => {
  it("match the lock file byte for byte (refreeze on purpose with eval/freeze.mjs)", () => {
    for (const scenario of SCENARIOS) assert.deepEqual(hashTree(join(FIXTURES_DIR, scenario)), lock.scenarios[scenario].files, scenario);
    assert.equal(lock.promptsHash, sha256(JSON.stringify(prompts)));
    assert.equal(lock.hardPromptsHash, sha256(JSON.stringify(hardPrompts)));
  });
  it("leave the first campaign's frozen entries as they were when the harder tasks were added", () => {
    assert.equal(lock.promptsHash, "f45af8d94b2da7a2ab2a4607554ecb9631fc99df24903d7de81eba577a3f4248");
    assert.equal(lock.scenarios.conditions.helperHash, "3155d65093cd2b7b6f93a030e9cabc7e1c992c496d9fdf4fe821d2ba8d838744");
    assert.equal(lock.scenarios.bug.helperHash, "3b26779a8fdb64c2c2a9f74b9632b3b2b05baf278d16374194c4a5191a6e77b9");
    assert.deepEqual(Object.keys(prompts), ["activation", "conditions", "bug", "nocode"]);
  });
  it("give a fresh workspace with no change from the frozen state", () => {
    for (const scenario of SCENARIOS) {
      const dir = createWorkspace(scenario);
      assert.deepEqual(changedFiles(dir, scenario), { changed: [], added: [], removed: [], outOfScope: [] });
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("hold no hidden oracle: fresh workspaces pass the leak audit and the audit catches a planted one", () => {
    for (const scenario of SCENARIOS) {
      const dir = createWorkspace(scenario);
      assert.equal(auditWorkspace(dir).ok, true, scenario);
      writeFileSync(join(dir, "check.oracle.mjs"), "x");
      assert.equal(auditWorkspace(dir).ok, false);
      rmSync(join(dir, "check.oracle.mjs"));
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "notes.js"), "// HIDDEN-ORACLE leaked");
      assert.match(auditWorkspace(dir).problems.join(" "), /oracle marker/);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keep every oracle outside the fixtures and mark each one", () => {
    const oracles = readdirSync(join(EVAL, "oracles"));
    assert.deepEqual(oracles.sort(), ["activation.oracle.mjs", "bug.oracle.mjs", "combos.mutants.mjs", "combos.oracle.mjs", "conditions.oracle.mjs", "trace.oracle.mjs"]);
    for (const file of oracles) assert.ok(readFileSync(join(EVAL, "oracles", file), "utf8").includes("HIDDEN-ORACLE"), file);
    for (const scenario of SCENARIOS) {
      for (const name of Object.keys(hashTree(join(FIXTURES_DIR, scenario)))) assert.ok(!/oracle|reference|lock/i.test(name), `${scenario}/${name}`);
    }
  });
});

describe("the frozen prompts reach the code-prompt check as designed", () => {
  it("the three code prompts activate the directive on both reasons and hosts' shared check", () => {
    for (const key of ["activation", "conditions", "bug"]) {
      const result = classifyCodePrompt(prompts[key]);
      assert.equal(result.activate, true, `${key}: ${result.reason}`);
      assert.notEqual(handleLogicHook("UserPromptSubmit", { prompt: prompts[key] }, {}), null, key);
    }
  });
  it("the two harder-task prompts activate it as well", () => {
    for (const key of Object.keys(hardPrompts)) {
      assert.equal(classifyCodePrompt(hardPrompts[key]).activate, true, key);
      assert.notEqual(handleLogicHook("UserPromptSubmit", { prompt: hardPrompts[key] }, {}), null, key);
    }
    assert.deepEqual(Object.keys(hardPrompts), ["combos", "trace"]);
  });
  it("the four non-code prompts add nothing", () => {
    assert.equal(prompts.nocode.length, 4);
    for (const prompt of prompts.nocode) {
      assert.equal(handleLogicHook("UserPromptSubmit", { prompt }, {}), null, prompt);
    }
  });
});

describe("fixture design", () => {
  const run = (scenario, file) => {
    const dir = createWorkspace(scenario);
    const result = spawnSync(process.execPath, ["--test", file], { cwd: dir, encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH ?? "" } });
    rmSync(dir, { recursive: true, force: true });
    return result;
  };
  it("the seeded bug passes every visible test (000, 011, 101, 110) so the visible suite hides it", () => {
    const result = run("bug", "test/shipping.test.mjs");
    assert.equal(result.status, 0, result.stdout.slice(-400));
  });
  it("the four visible combinations cover every pair of the three flags but not 111", () => {
    const labels = [...readFileSync(join(FIXTURES_DIR, "bug", "test", "shipping.test.mjs"), "utf8").matchAll(/test\("(\d{3}):/g)].map((m) => m[1]);
    assert.deepEqual(labels.sort(), ["000", "011", "101", "110"]);
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      const seen = new Set(labels.map((label) => label[i] + label[j]));
      assert.equal(seen.size, 4, `pair ${i}${j} fully covered`);
    }
    assert.ok(!labels.includes("111"));
  });
  it("the conditions fixture starts unimplemented, so its visible tests fail until the agent works", () => {
    const result = run("conditions", "test/access.test.mjs");
    assert.notEqual(result.status, 0);
  });
  it("the protected helpers are the ones named in the lock", () => {
    assert.match(lock.scenarios.conditions.helperHash, /^[0-9a-f]{64}$/);
    assert.match(lock.scenarios.bug.helperHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(lock.scenarios.conditions.allowedEdits, ["src/access.js", "test/access.test.mjs"]);
    assert.deepEqual(lock.scenarios.bug.allowedEdits, ["src/shipping.js", "test/shipping.test.mjs"]);
    assert.deepEqual(lock.scenarios.activation.allowedEdits, []);
  });
});
