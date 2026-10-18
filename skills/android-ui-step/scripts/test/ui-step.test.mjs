// ui-step: the tap decision (label class x found x region), settling, stop screens, failures, and the real CLI against fake `android` / `adb` commands. Offline, node stdlib only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Stop, findLabel, step } from "../ui-step.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "ui-step.mjs");
const el = (text, x, y, extra = {}) => ({ class: "android.widget.TextView", text, center: `[${x},${y}]`, bounds: `[${x - 40},${y - 20}][${x + 40},${y + 20}]`, interactions: ["CLICKABLE"], ...extra });
const screen = (...elements) => [{ type: "SYSTEM", content: [{ class: "android.widget.TextView", text: "9:26", center: "[63,70]" }] }, { type: "APPLICATION", content: elements }];
const MAIN = screen(
  el("Rewards", 871, 320), el("Deals", 200, 200), el("Weekly Ads", 600, 1200), el("Add to cart", 540, 1500), el("Settings", 540, 1700), el("Checkout", 540, 2200),
  el("Home", 107, 2340), el("Deals", 323, 2343), el("Cart", 971, 2343), el("myDG® Wallet", 539, 2343),
);
const OTHER = screen(el("Shopping List", 540, 200), el("Diet Coke", 540, 600));
const TRANSITION_1 = screen(el("Loading", 540, 1000));
const TRANSITION_2 = screen(el("Loading more", 540, 1000));

/** A fake device: layout reads walk through `frames`; the first adb input switches to `afterTap`. Time is a counter moved by sleep(). */
function fakeDevice({ before, afterTap = null, fail = {} }) {
  const calls = []; let frames = [before]; let index = 0; let clock = 0; let moved = false;
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "android" && args[0] === "layout") {
      if (fail.layout) return { status: 1, stdout: "" };
      const frame = typeof frames === "function" ? frames(index) : frames[Math.min(index, frames.length - 1)];
      index += 1;
      return { status: 0, stdout: typeof frame === "string" ? frame : JSON.stringify(frame) };
    }
    if (cmd === "adb") {
      if (fail.adb) return { status: 1, stdout: "" };
      if (afterTap && !moved) { moved = true; frames = afterTap; index = 0; }
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  return { calls, run, sleep: (s) => { clock += s * 1000; }, now: () => clock, elapsed: () => clock, inputs: () => calls.filter(([c]) => c === "adb"), layoutReads: () => calls.filter(([c, a]) => c === "android" && a === "layout").length };
}
const OPTS = { serial: "emulator-5554", tap: null, region: null, swipe: false, back: false, settle: 1.5, timeout: 12 };
const go = (device, opts) => step({ ...OPTS, ...opts }, { run: device.run, sleep: device.sleep, now: device.now });

describe("tap decision: label class x found x region", () => {
  // [label, region, expected]; expected = [x, y] (one tap at these coordinates) or a regexp (STOP, and no adb call at all)
  const MATRIX = [
    ["Rewards", null, [871, 320]], ["Rewards", "top", [871, 320]], ["Rewards", "bottom", /no element/],
    ["Deals", null, /ambiguous/], ["Deals", "top", [200, 200]], ["Deals", "bottom", [323, 2343]],
    ["Home", null, [107, 2340]], ["Home", "top", /no element/], ["Home", "bottom", [107, 2340]],
    ["Weekly Ads", null, [600, 1200]], ["Weekly Ads", "top", /no element/], ["Weekly Ads", "bottom", /no element/],
    ["List", null, /no element/], ["List", "top", /no element/], ["List", "bottom", /no element/],
    ["myDG Wallet", null, [539, 2343]], ["myDG Wallet", "bottom", [539, 2343]], ["myDG Wallet", "top", /no element/],
    ["Add to cart", null, /forbidden/], ["Add to cart", "bottom", /forbidden/], ["Checkout", null, /forbidden/], ["Checkout", "bottom", /forbidden/],
    ["Redeem", null, /forbidden/], ["Redeem", "top", /forbidden/], ["Sign out", "bottom", /forbidden/], ["add to list", null, /forbidden/],
    ["Settings", null, /whitelist/], ["Settings", "top", /whitelist/], ["Profile", null, /whitelist/], ["Profile", "bottom", /whitelist/],
  ];
  for (const [label, region, expected] of MATRIX) {
    it(`${label} / ${region ?? "no region"}`, () => {
      const device = fakeDevice({ before: MAIN, afterTap: [OTHER] });
      if (Array.isArray(expected)) {
        const result = go(device, { tap: label, region });
        assert.deepEqual(device.inputs(), [["adb", "-s", "emulator-5554", "shell", "input", "tap", String(expected[0]), String(expected[1])]]);
        assert.deepEqual([result.action.x, result.action.y], expected);
      } else {
        assert.throws(() => go(device, { tap: label, region }), (error) => error instanceof Stop && expected.test(error.message));
        assert.equal(device.inputs().length, 0, "a refused tap must not reach adb");
      }
    });
  }
  it("findLabel on its own refuses a forbidden label before looking at the screen", () => {
    assert.throws(() => findLabel([], "Send verification email"), /forbidden/);
    assert.throws(() => findLabel([], "Nonsense"), /whitelist/);
  });
});

describe("one target seen as two elements", () => {
  it("a container and its label with centers 1 px apart are one target (the real Rewards tab: [871,320] and [870,319])", () => {
    const tab = screen(el("Rewards", 871, 320, { text: undefined, "content-desc": "Rewards" }), el("Rewards", 870, 319), el("Home", 107, 2340));
    const device = fakeDevice({ before: tab, afterTap: [OTHER] });
    const result = go(device, { tap: "Rewards", region: "top" });
    assert.deepEqual([result.action.x, result.action.y], [871, 320]);
    assert.equal(device.inputs().length, 1);
  });
  it("two elements 40 px apart or more are still ambiguous", () => {
    const device = fakeDevice({ before: screen(el("Deals", 200, 200), el("Deals", 200, 241)), afterTap: [OTHER] });
    assert.throws(() => go(device, { tap: "Deals", region: "top" }), (error) => error instanceof Stop && /ambiguous/.test(error.message));
    assert.equal(device.inputs().length, 0);
  });
});

describe("settling before printing", () => {
  it("prints the screen that is stable (two equal reads in a row), not the transition frames", () => {
    const device = fakeDevice({ before: MAIN, afterTap: [TRANSITION_1, TRANSITION_2, OTHER, OTHER, OTHER] });
    const result = go(device, { tap: "Home", region: "bottom" });
    assert.equal(result.settled, true);
    assert.match(result.text, /Shopping List/);
    assert.doesNotMatch(result.text, /Loading/);
    assert.equal(result.reads, 5);
    assert.equal(device.layoutReads(), 5);
    assert.equal(device.elapsed(), 1500 + 3 * 1000);
  });
  it("says so and returns after the timeout when the screen never settles", () => {
    let n = 0;
    const run = (cmd) => (cmd === "adb" ? { status: 0, stdout: "" } : { status: 0, stdout: JSON.stringify(n++ === 0 ? MAIN : n % 2 ? TRANSITION_1 : TRANSITION_2) });
    let clock = 0;
    const result = step({ ...OPTS, tap: "Home", region: "bottom" }, { run, sleep: (s) => { clock += s * 1000; }, now: () => clock });
    assert.equal(result.settled, false);
    assert.match(result.text, /NOT settled after 12 s/);
    assert.ok(clock >= 12000 && clock <= 14000, `elapsed ${clock}`);
  });
  it("without an action it reads once and does not wait", () => {
    const device = fakeDevice({ before: OTHER });
    const result = go(device, {});
    assert.equal(result.reads, 1);
    assert.equal(device.elapsed(), 0);
    assert.match(result.text, /no action; settled \(1 layout reads\)/);
    assert.equal(device.inputs().length, 0);
  });
  it("one command is enough: tap + wait + digest in a single call, at most 4 layout reads on a screen that is already stable", () => {
    const device = fakeDevice({ before: MAIN, afterTap: [OTHER] });
    const result = go(device, { tap: "Cart", region: "bottom" });
    assert.ok(result.reads <= 4, `reads ${result.reads}`);
    assert.match(result.text, /^ui-step: tapped "Cart" at 971,2343; settled/);
    assert.match(result.text, /ui-digest: \d+ of \d+ elements/);
  });
});

describe("open mode (the CLI default; --safe turns the whitelist and the stop texts on)", () => {
  it("taps unlisted and state-changing labels when they are found, and still refuses labels that are missing or ambiguous", () => {
    for (const [label, region, xy] of [["Settings", null, [540, 1700]], ["Add to cart", "bottom", null], ["Checkout", null, [540, 2200]], ["Profile", null, null]]) {
      const device = fakeDevice({ before: MAIN, afterTap: [OTHER] });
      if (xy) { go(device, { tap: label, region, safe: false }); assert.deepEqual(device.inputs()[0].slice(-2), xy.map(String)); }
      else assert.throws(() => go(device, { tap: label, region, safe: false }), (error) => error instanceof Stop && /no element/.test(error.message));
    }
    assert.throws(() => go(fakeDevice({ before: MAIN }), { tap: "Deals", safe: false }), (error) => error instanceof Stop && /ambiguous/.test(error.message));
  });
  it("prints a login, verify or error screen instead of stopping, but still stops when the screen has no app elements", () => {
    const verify = screen(el("Your email needs to be verified.", 540, 476), el("Remind me next time", 540, 2301));
    const result = go(fakeDevice({ before: MAIN, afterTap: [verify] }), { tap: "Home", region: "bottom", safe: false });
    assert.match(result.text, /Your email needs to be verified\./);
    const empty = [{ type: "SYSTEM", content: [{ class: "android.widget.TextView", text: "9:26", center: "[63,70]" }] }];
    assert.throws(() => go(fakeDevice({ before: MAIN, afterTap: [empty] }), { tap: "Home", region: "bottom", safe: false }), (error) => error instanceof Stop && /no app elements/.test(error.message));
  });
});

describe("swipe and back", () => {
  it("swipe sends one swipe and waits", () => {
    const device = fakeDevice({ before: OTHER, afterTap: [OTHER] });
    go(device, { swipe: true });
    assert.deepEqual(device.inputs(), [["adb", "-s", "emulator-5554", "shell", "input", "swipe", "540", "1700", "540", "900", "300"]]);
    assert.ok(device.elapsed() >= 1500);
  });
  it("back sends keyevent 4", () => {
    const device = fakeDevice({ before: OTHER, afterTap: [OTHER] });
    go(device, { back: true });
    assert.deepEqual(device.inputs(), [["adb", "-s", "emulator-5554", "shell", "input", "keyevent", "4"]]);
  });
});

describe("stop screens", () => {
  for (const text of ["Your email needs to be verified.", "Error processing your request", "Sign in to access your account"]) {
    it(`stops on "${text}"`, () => {
      const device = fakeDevice({ before: MAIN, afterTap: [screen(el(text, 540, 600), el("Home", 107, 2340))] });
      assert.throws(() => go(device, { tap: "Home", region: "bottom" }), (error) => error instanceof Stop && /login, verify or error/.test(error.message));
    });
  }
  it("ordinary text does not stop, and the same words in a SYSTEM window do not count", () => {
    const system = [{ type: "SYSTEM", content: [{ class: "android.widget.TextView", text: "Error processing your request", center: "[1,1]" }] }, { type: "APPLICATION", content: [el("Shopping List", 540, 200)] }];
    assert.match(go(fakeDevice({ before: system }), {}).text, /Shopping List/);
  });
  it("stops when the screen has no app elements after one retry, and recovers when the retry shows them", () => {
    const empty = [{ type: "SYSTEM", content: [{ class: "android.widget.TextView", text: "9:26", center: "[63,70]" }] }];
    const dead = fakeDevice({ before: MAIN, afterTap: [empty] });
    assert.throws(() => go(dead, { tap: "Home", region: "bottom" }), (error) => error instanceof Stop && /no app elements/.test(error.message));
    const late = fakeDevice({ before: MAIN, afterTap: [empty, empty, OTHER, OTHER] });
    // settle loop: empty, empty (equal -> settled with no app elements), then the retry after 4 s reads OTHER
    const result = go(late, { tap: "Home", region: "bottom" });
    assert.match(result.text, /Shopping List/);
  });
});

describe("failures of the commands", () => {
  it("android layout failing, garbage output and adb failing are all STOPs", () => {
    assert.throws(() => go(fakeDevice({ before: MAIN, fail: { layout: true } }), {}), (error) => error instanceof Stop && /android layout failed/.test(error.message));
    assert.throws(() => go(fakeDevice({ before: "not json" }), {}), (error) => error instanceof Stop && /did not return JSON/.test(error.message));
    assert.throws(() => go(fakeDevice({ before: MAIN, fail: { adb: true } }), { tap: "Home", region: "bottom" }), (error) => error instanceof Stop && /adb .* failed/.test(error.message));
  });
});

describe("the real CLI against fake android / adb commands", () => {
  function fakeBin() {
    const dir = mkdtempSync(join(tmpdir(), "ui-step-cli-"));
    mkdirSync(join(dir, "bin"));
    const layout = join(dir, "layout.json");
    writeFileSync(layout, JSON.stringify(MAIN));
    writeFileSync(join(dir, "bin", "android"), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "layout") process.stdout.write(readFileSync(${JSON.stringify(layout)}, "utf8"));
else if (a[0] === "screen" && a[1] === "capture") { writeFileSync(a[a.indexOf("-o") + 1], "this is not an image"); }
`);
    writeFileSync(join(dir, "bin", "adb"), "#!/bin/sh\nexit 0\n");
    for (const tool of ["android", "adb"]) chmodSync(join(dir, "bin", tool), 0o755);
    return dir;
  }
  const run = (dir, args) => spawnSync(process.execPath, [SCRIPT, "--settle", "0.1", ...args], { encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });

  it("without an action it prints the digest of the current screen and exits 0", () => {
    const dir = fakeBin();
    try { const r = run(dir, []); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^ui-step: no action; settled/); assert.match(r.stdout, /ui-digest:/); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a label that is not on the screen stops with exit 3 and says STOP", () => {
    const dir = fakeBin();
    try { const r = run(dir, ["--tap", "No such label"]); assert.equal(r.status, 3); assert.match(r.stderr, /ui-step: STOP: no element "No such label"/); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("--shot with a file that cannot be shrunk still prints the digest and exits 0 with a notice", () => {
    const dir = fakeBin();
    try { const r = run(dir, ["--shot", join(dir, "shot.jpg")]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ui-digest:/); assert.match(r.stdout, /screenshot: could not shrink .*shot\.jpg\.png/); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
