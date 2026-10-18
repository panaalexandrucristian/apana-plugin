import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EQUIVALENT, MUTANTS, applyMutant } from "../eval/oracles/combos.mutants.mjs";
import { evaluateRun } from "../eval/lib/evaluate.mjs";
import { changedFiles, createWorkspace, hashTree } from "../eval/lib/workspace.mjs";
import { SUITES } from "../eval/reference/combos/suites.mjs";

const FIXTURE_SRC = fileURLToPath(new URL("./fixtures/combos/src/pricing.js", import.meta.url));
const correctSource = readFileSync(FIXTURE_SRC, "utf8");
const readdirTmp = () => readdirSync("/tmp").filter((f) => f.startsWith("ltd-flaky-"));
const ORIGINAL_HASH = createHash("sha256").update(correctSource).digest("hex");

const load = async (source) => {
  const dir = mkdtempSync(join(tmpdir(), "ltd-combos-mod-"));
  const file = join(dir, "pricing.mjs");
  writeFileSync(file, source);
  const mod = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return mod.quote;
};

// Every valid input: 50 x 3 x 3 x 2^4 = 7200.
function* domain() {
  for (let units = 1; units <= 50; units += 1)
    for (const tier of ["basic", "plus", "pro"])
      for (const region of ["EU", "US", "OTHER"])
        for (let bits = 0; bits < 16; bits += 1) yield { units, tier, region, coupon: Boolean(bits & 8), express: Boolean(bits & 4), gift: Boolean(bits & 2), taxExempt: Boolean(bits & 1) };
}
const subtotalAfterRules2And3 = (o) => {
  let s = o.units * { basic: 1000, plus: 1500, pro: 2000 }[o.tier];
  if (o.units >= 10) s -= Math.floor((s * 10) / 100);
  if (o.coupon && o.tier !== "basic") s -= 500;
  return s;
};
// The input conditions that must hold for a mutant to change a result (the claimed order of the fault).
const TRIGGER = {
  "S1-bulk-threshold": (o) => o.units === 10,
  "S2-pro-price": (o) => o.tier === "pro",
  "P1-coupon-on-basic": (o) => o.coupon && o.tier === "basic",
  "P2-free-express": (o) => o.express && subtotalAfterRules2And3(o) >= 10000,
  "P3-exempt-everywhere": (o) => o.taxExempt && o.region === "EU",
  "P4-wrap-for-pro": (o) => o.gift && o.tier === "pro",
  "P5-other-surcharge-always": (o) => o.region === "OTHER" && !o.express,
  "T1-coupon-before-bulk": (o) => o.units >= 10 && o.coupon && o.tier !== "basic",
  "T2-wrap-untaxed-in-eu": (o) => o.region === "EU" && o.gift && o.tier !== "pro",
  "T3-no-free-shipping-other": (o) => o.region === "OTHER" && !o.express && subtotalAfterRules2And3(o) >= 10000,
  "T4-no-surcharge-with-gift": (o) => o.region === "OTHER" && o.express && o.gift,
};

describe("combos fixture and mutants (by brute force over all 7200 valid inputs)", () => {
  it("the equivalent rewrite returns the same total as the correct quote for every valid input", async () => {
    const [good, other] = [await load(correctSource), await load(EQUIVALENT)];
    let n = 0;
    for (const input of domain()) {
      assert.equal(other(input), good(input), JSON.stringify(input));
      n += 1;
    }
    assert.equal(n, 7200);
    assert.notEqual(EQUIVALENT, correctSource);
  });
  it("every mutant is the correct source with one change, differs somewhere, and differs only where its claimed conditions hold", async () => {
    const good = await load(correctSource);
    assert.equal(MUTANTS.length, 11);
    assert.deepEqual(Object.keys(TRIGGER), MUTANTS.map((m) => m.id));
    for (const mutant of MUTANTS) {
      const bad = await load(applyMutant(correctSource, mutant));
      let differing = 0;
      for (const input of domain()) {
        if (bad(input) === good(input)) continue;
        differing += 1;
        assert.ok(TRIGGER[mutant.id](input), `${mutant.id} differs outside its claimed conditions: ${JSON.stringify(input)}`);
      }
      assert.ok(differing > 0, `${mutant.id} never differs from the correct quote`);
    }
  });
  it("the orders are 2 single-value, 5 pair and 4 triple faults", () => {
    assert.deepEqual([1, 2, 3].map((k) => MUTANTS.filter((m) => m.order === k).length), [2, 5, 4]);
  });
  it("the equivalent rewrite agrees with the correct quote even on inputs outside the spec (NaN included)", async () => {
    const [good, other] = [await load(correctSource), await load(EQUIVALENT)];
    const odd = { units: [0, -1, 9.5, 10.5, 51, 1000, NaN], tier: ["basic", "plus", "pro", "gold", undefined], region: ["EU", "US", "OTHER", "XX", undefined] };
    let n = 0;
    for (const units of odd.units) for (const tier of odd.tier) for (const region of odd.region) for (let bits = 0; bits < 16; bits += 1) {
      const input = { units, tier, region, coupon: Boolean(bits & 8), express: Boolean(bits & 4), gift: Boolean(bits & 2), taxExempt: Boolean(bits & 1) };
      assert.ok(Object.is(other(input), good(input)), JSON.stringify(input));
      n += 1;
    }
    assert.equal(n, 7 * 5 * 5 * 16);
  });
  it("the starting test file passes on the correct quote and the spec examples worked by hand agree with it", () => {
    const dir = createWorkspace("combos");
    writeFileSync(join(dir, "test", "pricing.test.mjs"), SUITES.naive());
    const v = evaluateRun("combos", dir);
    assert.equal(v.oracle.clean.correct, true, "six totals worked by hand from SPEC.md match the implementation");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("combos oracle on reference test files of different strength (13 scored cases)", () => {
  const run = (name, mutate = (dir) => {}) => {
    const dir = createWorkspace("combos");
    writeFileSync(join(dir, "test", "pricing.test.mjs"), SUITES[name]().replace("__ORIGINAL_HASH__", ORIGINAL_HASH).replaceAll("__WORKSPACE__", dir).replaceAll("__TOKEN__", `${process.pid}-${Date.now()}`));
    mutate(dir);
    const verdict = evaluateRun("combos", dir);
    rmSync(dir, { recursive: true, force: true });
    return verdict;
  };
  it("a hand-written set of six examples passes the clean cases but misses most faults", () => {
    const v = run("naive");
    assert.equal(v.oracle.total, 13);
    assert.deepEqual(v.oracle.clean, { correct: true, equivalent: true });
    assert.ok(v.oracle.passed < 8, `${v.oracle.passed}/13`);
    assert.equal(v.success, false);
  });
  it("a pairwise covering test set catches every single and pair fault but misses a triple fault", () => {
    const v = run("pairwise");
    assert.deepEqual(v.oracle.byOrder, { 1: 2, 2: 5, 3: 3 });
    assert.deepEqual(v.oracle.survived, ["T4-no-surcharge-with-gift"]);
    assert.equal(v.success, false);
  });
  it("the visible starting tests catch no fault, so a run that adds nothing scores zero", () => {
    const dir = createWorkspace("combos");
    const v = evaluateRun("combos", dir);
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(v.oracle.killed, []);
    assert.deepEqual(v.oracle.clean, { correct: true, equivalent: true });
    assert.equal(v.success, false);
  });
  it("a three-way covering test set and an exhaustive one catch all eleven faults", () => {
    for (const name of ["triples", "exhaustive"]) {
      const v = run(name);
      assert.equal(v.oracle.passed, 13, name);
      assert.deepEqual(v.oracle.byOrder, { 1: 2, 2: 5, 3: 4 });
      assert.equal(v.success, true, name);
    }
  });
  it("a test that reads the source text fails the equivalent rewrite, so it cannot pass by inspection", () => {
    const v = run("sniffer");
    assert.equal(v.oracle.clean.correct, true);
    assert.equal(v.oracle.clean.equivalent, false);
    assert.equal(v.success, false);
  });
  it("a wrong expected value fails the correct version, and killing the faults then does not count as success", () => {
    const v = run("wrongExpectation");
    assert.equal(v.oracle.clean.correct, false);
    assert.equal(v.success, false);
  });
  it("an empty test file catches nothing", () => {
    const v = run("empty");
    assert.deepEqual(v.oracle.killed, []);
    assert.equal(v.success, false);
  });
  it("changing src/pricing.js, even to an equivalent rewrite, fails the safety check without a scored failure", () => {
    const v = run("exhaustive", (dir) => writeFileSync(join(dir, "src", "pricing.js"), EQUIVALENT));
    assert.equal(v.oracle.passed, 13);
    assert.equal(v.oracle.safety.helperUnchanged, false);
    assert.equal(v.success, false);
  });
  it("a new file next to the test file is outside the allowed edits", () => {
    const v = run("exhaustive", (dir) => writeFileSync(join(dir, "test", "helpers.mjs"), "export {};\n"));
    assert.deepEqual(v.files.outOfScope, ["test/helpers.mjs"]);
    assert.equal(v.success, false);
  });
  it("2592 separate test() calls are accepted in full: output size no longer decides the verdict", () => {
    const v = run("bigFlat");
    assert.equal(v.oracle.passed, 13, JSON.stringify(v.oracle.failures));
    assert.equal(v.success, true);
  });
  it("a test file that names the workspace by absolute path is refused, because it can reach the original files", () => {
    const v = run("absolutePath");
    assert.match(v.oracle.invalid, /test\/pricing\.test\.mjs refers to the workspace by absolute path/);
    assert.equal(v.oracle.passed, 0);
    assert.equal(v.success, false);
  });
  it("a run counter in the temporary directory no longer works: every run has its own", () => {
    const v = run("counter");
    assert.deepEqual(v.oracle.killed, []);
    assert.equal(v.success, false);
  });
  it("a suite that passes once and fails when run again does not count as passing the clean versions", () => {
    const v = run("flaky");
    assert.equal(v.oracle.clean.correct, false);
    assert.equal(v.success, false);
    for (const file of readdirTmp()) rmSync(join("/tmp", file), { force: true });
  });
  it("a symlink added to the workspace is out of scope, in either scenario", () => {
    const v = run("exhaustive", (dir) => symlinkSync("../src/pricing.js", join(dir, "test", "ref.mjs")));
    assert.deepEqual(v.files.outOfScope, ["test/ref.mjs"]);
    assert.equal(v.success, false);
  });
  it("a file hidden in node_modules or .git is seen by the audit as well", () => {
    const dir = createWorkspace("trace");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "hidden.js"), "export {};\n");
    mkdirSync(join(dir, "src", ".git"));
    writeFileSync(join(dir, "src", ".git", "hidden2.js"), "export {};\n");
    assert.deepEqual(changedFiles(dir, "trace").outOfScope.sort(), ["node_modules/hidden.js", "src/.git/hidden2.js"]);
    assert.ok("node_modules/hidden.js" in hashTree(dir));
    rmSync(dir, { recursive: true, force: true });
  });
  it("tests that hang on the correct version end quickly and count as caught nothing", () => {
    const dir = createWorkspace("combos");
    writeFileSync(join(dir, "test", "pricing.test.mjs"), `import { test } from "node:test";\ntest("loops", () => { for (;;); });\n`);
    const t0 = Date.now();
    const v = evaluateRun("combos", dir);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(v.oracle.clean.correct, false);
    assert.equal(v.oracle.undetermined.length, 11);
    assert.ok(Date.now() - t0 < 60000, "mutants are not run after a hang on the correct version");
    assert.equal(v.success, false);
  });
});
