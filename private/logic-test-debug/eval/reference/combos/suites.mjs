// Reference test files for the combos oracle (used only to test the oracle; never given to an agent). Each function
// returns the source of a test/pricing.test.mjs. The model below is an independent statement of SPEC.md.
const HEAD = `import assert from "node:assert/strict";
import { test } from "node:test";
import { quote } from "../src/pricing.js";
`;

const MODEL = `
function model(o) {
  const price = o.tier === "basic" ? 1000 : o.tier === "plus" ? 1500 : 2000;
  let sub = o.units * price;
  if (o.units >= 10) sub = sub - Math.floor(sub / 10);
  if (o.coupon && o.tier !== "basic") sub -= 500;
  const ship = o.express ? 1500 + (o.region === "OTHER" ? 1000 : 0) : sub >= 10000 ? 0 : 500;
  const wrap = o.gift && o.tier !== "pro" ? 200 : 0;
  const rate = o.region === "EU" ? 20 : o.region === "US" && !o.taxExempt ? 8 : 0;
  return sub + ship + wrap + Math.floor(((sub + wrap) * rate) / 100);
}
`;

const GENERATOR = `
const LEVELS = { units: [1, 9, 10, 25], tier: ["basic", "plus", "pro"], region: ["EU", "US", "OTHER"], coupon: [false, true], express: [false, true], gift: [false, true], taxExempt: [false, true] };
const KEYS = Object.keys(LEVELS);
const ALL = KEYS.reduce((rows, key) => rows.flatMap((row) => LEVELS[key].map((value) => ({ ...row, [key]: value }))), [{}]);
const combinations = (items, size) => (size === 0 ? [[]] : items.flatMap((item, i) => combinations(items.slice(i + 1), size - 1).map((rest) => [item, ...rest])));
const tupleKey = (cols, row) => cols.map((c) => c + "=" + row[c]).join("|");
function coveringArray(strength) {
  const columnSets = combinations(KEYS, strength);
  const uncovered = new Set();
  for (const row of ALL) for (const cols of columnSets) uncovered.add(tupleKey(cols, row));
  const chosen = [];
  while (uncovered.size > 0) {
    let best = ALL[0];
    let bestGain = -1;
    for (const row of ALL) {
      let gain = 0;
      for (const cols of columnSets) if (uncovered.has(tupleKey(cols, row))) gain += 1;
      if (gain > bestGain) { best = row; bestGain = gain; }
    }
    chosen.push(best);
    for (const cols of columnSets) uncovered.delete(tupleKey(cols, best));
  }
  return chosen;
}
`;

const loop = (rowsExpression) => `${HEAD}${MODEL}${GENERATOR}
for (const [i, input] of ${rowsExpression}.entries()) {
  test("combination " + i + " " + JSON.stringify(input), () => {
    assert.equal(quote(input), model(input));
  });
}
`;

const o = (units, tier, region, coupon, express, gift, taxExempt) => ({ units, tier, region, coupon, express, gift, taxExempt });

export const SUITES = {
  // One typical example per rule, the way a person writes tests by hand. Expected values come from SPEC.md by hand.
  naive: () => {
    // Worked by hand from SPEC.md. Each line: subtotal, shipping, wrap, tax -> total.
    const cases = [
      [o(1, "basic", "EU", false, false, false, false), 1700], // 1000 + 500 + 0 + 200
      [o(1, "pro", "US", false, true, false, true), 3500], // 2000 + 1500 + 0 + 0
      [o(20, "basic", "EU", false, false, false, false), 21600], // 20000 - 2000 = 18000; free shipping; tax 3600
      [o(2, "plus", "US", true, false, false, false), 3200], // 3000 - 500 = 2500; 500; tax 200
      [o(1, "plus", "OTHER", false, true, false, false), 4000], // 1500 + (1500 + 1000) + 0 + 0
      [o(1, "plus", "EU", false, false, true, false), 2540], // 1500 + 500 + 200 + tax 340
    ];
    return `${HEAD}${cases.map(([input, expected], i) => `test("example ${i}", () => {\n  assert.equal(quote(${JSON.stringify(input)}), ${expected});\n});`).join("\n\n")}\n`;
  },
  pairwise: () => loop("coveringArray(2)"),
  triples: () => loop("coveringArray(3)"),
  exhaustive: () => loop("ALL"),
  // Reads the source text instead of testing behaviour: passes the original, fails every other file text.
  sniffer: () => `${HEAD}import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
test("the source is the original", () => {
  const text = readFileSync(new URL("../src/pricing.js", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), "__ORIGINAL_HASH__");
});
`,
  // 2592 separate test() calls: a faulty version fails hundreds of them and prints a lot (the first oracle overflowed its pipe).
  bigFlat: () => `${HEAD}${MODEL}
for (let units = 1; units <= 18; units += 1)
  for (const tier of ["basic", "plus", "pro"])
    for (const region of ["EU", "US", "OTHER"])
      for (let bits = 0; bits < 16; bits += 1) {
        const input = { units, tier, region, coupon: Boolean(bits & 8), express: Boolean(bits & 4), gift: Boolean(bits & 2), taxExempt: Boolean(bits & 1) };
        test("case " + units + tier + region + bits, () => assert.equal(quote(input), model(input)));
      }
`,
  // Compares with the original file by absolute path: the swap cannot reach it, so every fault would be "caught".
  absolutePath: () => `${HEAD}import { quote as original } from "__WORKSPACE__/src/pricing.js";
test("same as the original", () => {
  for (const tier of ["basic", "plus", "pro"]) for (const units of [1, 10, 25]) {
    const input = { units, tier, region: "EU", coupon: true, express: false, gift: true, taxExempt: false };
    assert.equal(quote(input), original(input));
  }
});
`,
  // Never calls quote: counts its own runs in the temporary directory and fails from the third run on.
  counter: () => `${HEAD}import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("run counter", () => {
  const file = join(tmpdir(), "ltd-counter-__TOKEN__");
  const n = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
  writeFileSync(file, String(n));
  assert.ok(n <= 2);
});
`,
  // Passes the first time it is run and fails the second time (state kept outside the workspace copy).
  flaky: () => `${HEAD}import { existsSync, writeFileSync } from "node:fs";
test("fails when run again", () => {
  const file = "/tmp/ltd-flaky-__TOKEN__";
  if (existsSync(file)) assert.fail("second run");
  writeFileSync(file, "1");
});
`,
  wrongExpectation: () => `${HEAD}test("wrong total", () => {
  assert.equal(quote(${JSON.stringify(o(1, "basic", "EU", false, false, false, false))}), 1);
});
`,
  empty: () => `${HEAD}`,
};
