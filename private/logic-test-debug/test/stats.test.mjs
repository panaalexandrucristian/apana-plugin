import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allowance, finishSession, readLedger, spentUsd, startSession, started } from "../eval/lib/ledger.mjs";
import { compareArms, compareScores, fisherExact, permutationExact } from "../eval/lib/stats.mjs";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.0006, `${actual} vs ${expected}`);

describe("exact two-sided Fisher test (the values the plan relies on)", () => {
  it("matches the table of the live plan", () => {
    near(fisherExact(4, 4, 0, 4), 0.029);
    near(fisherExact(4, 4, 1, 4), 0.143);
    near(fisherExact(5, 5, 0, 5), 0.008);
    near(fisherExact(4, 5, 1, 5), 0.206);
    near(fisherExact(8, 8, 4, 8), 0.077);
    near(fisherExact(8, 8, 3, 8), 0.026);
    near(fisherExact(8, 8, 2, 8), 0.007);
    near(fisherExact(7, 8, 2, 8), 0.041);
  });
  it("is 1 for identical arms and symmetric", () => {
    near(fisherExact(3, 8, 3, 8), 1);
    near(fisherExact(8, 8, 3, 8), fisherExact(3, 8, 8, 8));
  });
  it("rejects invalid tables", () => {
    assert.throws(() => fisherExact(5, 4, 0, 4));
    assert.throws(() => fisherExact(-1, 4, 0, 4));
    assert.throws(() => fisherExact(1.5, 4, 0, 4));
  });
  it("claims an effect only below 0.05, with direction and counts", () => {
    assert.equal(compareArms({ onSuccess: 8, onN: 8, offSuccess: 3, offN: 8 }).effectClaimed, true);
    assert.equal(compareArms({ onSuccess: 8, onN: 8, offSuccess: 4, offN: 8 }).effectClaimed, false);
    const reversed = compareArms({ onSuccess: 2, onN: 8, offSuccess: 8, offN: 8 });
    assert.equal(reversed.direction, "OFF higher");
    assert.equal(reversed.on, "2/8");
  });
});

describe("session ledger", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "ltd-ledger-")), "ledger.tsv");
  const base = { kind: "planned", scenario: "activation", arm: "ON", run: "1", model: "haiku" };

  it("requires the cap and the prior use, with no default", () => {
    const path = fresh();
    assert.throws(() => allowance({ path }), /cap/);
    assert.throws(() => allowance({ path, cap: 50 }), /prior/);
    assert.throws(() => startSession({ path, ...base }), /cap/);
  });
  it("counts every start and lowers the allowance", () => {
    const path = fresh();
    assert.equal(allowance({ path, cap: 10, prior: 5 }), 5);
    const a = startSession({ path, cap: 10, prior: 5, ...base });
    const b = startSession({ path, cap: 10, prior: 5, ...base, kind: "retry", run: "1" });
    assert.deepEqual([a.id, b.id], ["s1", "s2"]);
    assert.equal(started(path), 2);
    assert.equal(allowance({ path, cap: 10, prior: 5 }), 3);
  });
  it("refuses the start that would exceed the cap instead of shrinking the plan", () => {
    const path = fresh();
    for (let i = 0; i < 3; i += 1) startSession({ path, cap: 5, prior: 2, ...base, run: String(i) });
    assert.throws(() => startSession({ path, cap: 5, prior: 2, ...base }), /no allowance left/);
    assert.equal(started(path), 3);
  });
  it("counts a session once whatever its later status, and never edits a start line", () => {
    const path = fresh();
    const s = startSession({ path, cap: 4, prior: 0, ...base });
    finishSession({ path, id: s.id, status: "incomplete" });
    assert.equal(started(path), 1);
    const rows = readLedger(path);
    assert.deepEqual(rows.map((r) => r.status), ["started", "incomplete"]);
    assert.equal(readFileSync(path, "utf8").split("\n")[0], "time\tid\tkind\tscenario\tarm\trun\tmodel\tstatus\tusd");
    assert.throws(() => finishSession({ path, id: "s9", status: "x" }));
  });
  it("records the cost of a finished session and sums it", () => {
    const path = fresh();
    const a = startSession({ path, cap: 9, prior: 0, ...base });
    const b = startSession({ path, cap: 9, prior: 0, ...base, run: "2" });
    finishSession({ path, id: a.id, status: "ok", usd: 0.04 });
    finishSession({ path, id: b.id, status: "ok", usd: 0.05 });
    assert.ok(Math.abs(spentUsd(path) - 0.09) < 1e-9);
    assert.throws(() => finishSession({ path, id: a.id, status: "ok", usd: -1 }));
  });
  it("rejects an unknown kind and a missing model", () => {
    const path = fresh();
    assert.throws(() => startSession({ path, cap: 4, prior: 0, ...base, kind: "free" }));
    startSession({ path, cap: 4, prior: 0, ...base, kind: "pilot" }); // a pilot is a declared kind: it counts against the cap and the reserve
    assert.throws(() => startSession({ path, cap: 4, prior: 0, ...base, model: "" }));
  });
});

describe("exact permutation test for score samples (the harder tasks)", () => {
  // Brute force: enumerate every choice of n of the pooled scores and compare the mean difference.
  const brute = (on, off) => {
    const all = [...on, ...off];
    const total = all.reduce((a, b) => a + b, 0);
    const n = on.length;
    const m = off.length;
    const observed = Math.abs(on.reduce((a, b) => a + b, 0) / n - off.reduce((a, b) => a + b, 0) / m);
    let extreme = 0;
    let all_ = 0;
    const pick = (start, chosen, sum) => {
      if (chosen === n) {
        all_ += 1;
        if (Math.abs(sum / n - (total - sum) / m) >= observed - 1e-9) extreme += 1;
        return;
      }
      for (let i = start; i < all.length; i += 1) pick(i + 1, chosen + 1, sum + all[i]);
    };
    pick(0, 0, 0);
    return extreme / all_;
  };
  it("gives the hand-counted values: 1,1 against 0,0 is 2 of 6 splits", () => {
    assert.ok(Math.abs(permutationExact([1, 1], [0, 0]) - 2 / 6) < 1e-12);
    assert.equal(permutationExact([3, 3, 3], [3, 3, 3]), 1);
  });
  it("matches brute-force enumeration on unequal and equal sizes, including ties", () => {
    const cases = [[[4, 6, 5, 7], [1, 2, 2]], [[0, 0, 1, 11], [3, 4, 5, 6, 7]], [[10, 11, 9, 8, 11], [2, 4, 1, 3, 5]], [[2, 2, 2], [2, 2, 3, 3]]];
    for (const [on, off] of cases) assert.ok(Math.abs(permutationExact(on, off) - brute(on, off)) < 1e-12, JSON.stringify([on, off]));
  });
  it("handles ten against ten in one pass and is symmetric in the arms", () => {
    const on = [9, 10, 8, 11, 9, 7, 10, 9, 8, 11];
    const off = [4, 6, 5, 7, 3, 5, 6, 4, 2, 5];
    const p = permutationExact(on, off);
    assert.ok(p < 0.001 && p > 0);
    assert.ok(Math.abs(p - permutationExact(off, on)) < 1e-12);
  });
  it("claims an effect only below the adjusted level 0.025 and in a clear direction", () => {
    const strong = compareScores([9, 10, 8, 11, 9, 7, 10, 9, 8, 11], [4, 6, 5, 7, 3, 5, 6, 4, 2, 5]);
    assert.equal(strong.effectClaimed, true);
    assert.equal(strong.direction, "ON higher");
    assert.equal(strong.alpha, 0.025);
    const weak = compareScores([5, 6, 7], [4, 6, 6]);
    assert.equal(weak.effectClaimed, false);
    assert.equal(compareScores([3, 3], [3, 3]).effectClaimed, false);
    assert.equal(compareScores([1, 1, 1, 1], [9, 9, 9, 9]).direction, "OFF higher");
  });
  it("rejects scores that are not non-negative integers", () => {
    assert.throws(() => permutationExact([1.5], [1]), /invalid scores/);
    assert.throws(() => permutationExact([-1], [1]), /invalid scores/);
    assert.throws(() => permutationExact([], [1]), /invalid scores/);
  });
});
