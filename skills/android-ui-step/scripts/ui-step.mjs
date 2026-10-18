#!/usr/bin/env node
// ui-step: one navigation step on an Android emulator in ONE command: act (tap a label, swipe, or Back), wait until the layout stops
// changing, then print the ui-digest of the new screen (optionally also a shrunk screenshot).
//   node ui-step.mjs [--serial emulator-5554] [--tap <label> [--region top|bottom]] [--swipe] [--back] [--settle 1.5] [--timeout 12] [--shot <out.jpg>] [--safe]
// With no action it only prints the digest of the current screen. By default any exact label can be tapped. With --safe (the read-only walks of the evaluation)
// a tapped label must be on ALLOWED and must not match FORBIDDEN, and a login / verify / error screen stops the command.
// Exit codes: 0 ok, 2 bad arguments, 3 stopped (label refused or not found or ambiguous, no app elements, with --safe also a login / verify / error screen).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { render } from "./ui-digest.mjs";

export const ALLOWED = [/^Home$/, /^Deals$/, /^myDG.? ?Wallet$/i, /^List$/, /^Cart$/, /^Coupons & Cash Back$/, /^Weekly Ads$/, /^Rewards$/, /^Rebates$/];
export const FORBIDDEN = /(Activate|Add|Clip|Redeem|Sign out|Log out|Checkout|Place|Order|Send|Delete|Remove|Buy|Pay|Verify|Edit|Save|Scan|Camera)/i;
export const STOP_TEXT = /needs to be verified|Error processing your request|Sign in to access/i;

export class Stop extends Error {}

const appElements = (data) => data.filter((w) => w.type !== "SYSTEM").flatMap((w) => w.content ?? []);
const centerOf = (e) => e.center.replace(/[[\]]/g, "").split(",").map(Number);

/** The element to tap for `label`, or a Stop. With `safe` (the default here) refuses labels that are not allowed; `region` keeps the top (y < 500) or the bottom (y > 2100) of the screen. */
export function findLabel(data, label, region = null, safe = true) {
  if (safe && FORBIDDEN.test(label)) throw new Stop(`label "${label}" is on the forbidden list`);
  if (safe && !ALLOWED.some((re) => re.test(label))) throw new Stop(`label "${label}" is not on the whitelist`);
  const y = (e) => centerOf(e)[1];
  let hits = appElements(data).filter((e) => (e.text === label || e["content-desc"] === label || (label.startsWith("myDG") && /myDG/.test(e.text ?? e["content-desc"] ?? ""))) && e.center);
  if (region === "top") hits = hits.filter((e) => y(e) < 500);
  else if (region === "bottom") hits = hits.filter((e) => y(e) > 2100);
  if (hits.length === 0) throw new Stop(`no element "${label}" in region ${region ?? "any"} on this screen`);
  // a container and the label inside it have centers a pixel apart: one target. Hits farther than 30 px from the first one are a different place.
  const [fx, fy] = centerOf(hits[0]);
  const far = hits.filter((e) => { const [cx, cy] = centerOf(e); return Math.abs(cx - fx) > 30 || Math.abs(cy - fy) > 30; });
  if (far.length > 0) { const centers = [...new Set(hits.map((e) => e.center))]; throw new Stop(`label "${label}" is ambiguous (${centers.length} elements at ${centers.join(" ")}): pass --region top or --region bottom`); }
  const [x, yy] = centerOf(hits[0]);
  return { x, y: yy, label, region };
}

const hashOf = (data) => createHash("sha1").update(JSON.stringify(data)).digest("hex");

/**
 * One step. `deps` = { run(cmd, args) -> {status, stdout}, sleep(seconds), now() -> ms } so that the logic is testable without a device.
 * Returns { action, reads, text } where `text` is what the command prints.
 */
export function step(opts, deps) {
  const { run, sleep, now } = deps;
  const adb = (...a) => { const r = run("adb", ["-s", opts.serial, ...a]); if (r.status !== 0) throw new Stop(`adb ${a.slice(0, 3).join(" ")} failed`); };
  let reads = 0;
  const read = () => {
    const r = run("android", ["layout", "--flat"]);
    if (r.status !== 0) throw new Stop("android layout failed");
    reads += 1;
    try { return JSON.parse(String(r.stdout).replace(/\nShell cwd was reset.*$/s, "").trim()); } catch { throw new Stop("layout did not return JSON"); }
  };
  let action = null;
  if (opts.tap) {
    action = findLabel(read(), opts.tap, opts.region, opts.safe !== false);
    adb("shell", "input", "tap", String(action.x), String(action.y));
  } else if (opts.swipe) {
    adb("shell", "input", "swipe", "540", "1700", "540", "900", "300");
    action = { swipe: "down once" };
  } else if (opts.back) {
    adb("shell", "input", "keyevent", "4");
    action = { back: true };
  }
  if (action) sleep(opts.settle);
  // settled = two equal reads in a row; give up after `timeout` seconds and say so
  const deadline = now() + opts.timeout * 1000;
  let data = read();
  let settled = !action;
  while (!settled && now() < deadline) {
    sleep(1);
    const next = read();
    settled = hashOf(next) === hashOf(data);
    data = next;
  }
  if (appElements(data).length === 0) {
    sleep(4);
    data = read();
    if (appElements(data).length === 0) throw new Stop("the screen exposes no app elements after one retry: use a screenshot");
  }
  const texts = appElements(data).map((e) => `${e.text ?? ""} ${e["content-desc"] ?? ""}`).join(" ");
  if (opts.safe !== false && STOP_TEXT.test(texts)) throw new Stop("the app shows a login, verify or error screen");
  const what = action ? (action.label ? `tapped "${action.label}" at ${action.x},${action.y}` : JSON.stringify(action)) : "no action";
  const head = `ui-step: ${what}; ${settled ? "settled" : `NOT settled after ${opts.timeout} s`} (${reads} layout reads)`;
  return { action, reads, settled, text: `${head}\n${render(data)}` };
}

const realDeps = {
  run: (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return { status: r.status ?? 1, stdout: r.stdout ?? "" }; },
  sleep: (s) => { spawnSync("sleep", [String(s)]); },
  now: () => Date.now(),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let values;
  try {
    ({ values } = parseArgs({ args: process.argv.slice(2), options: { serial: { type: "string" }, tap: { type: "string" }, region: { type: "string" }, swipe: { type: "boolean" }, back: { type: "boolean" }, settle: { type: "string" }, timeout: { type: "string" }, shot: { type: "string" }, safe: { type: "boolean" } } }));
  } catch (error) { console.error(error.message); process.exit(2); }
  if ([values.tap, values.swipe, values.back].filter(Boolean).length > 1 || (values.region && !["top", "bottom"].includes(values.region))) { console.error("usage: ui-step.mjs [--tap <label> [--region top|bottom]] [--swipe] [--back] [--settle s] [--timeout s] [--shot out.jpg] [--safe]"); process.exit(2); }
  const opts = { serial: values.serial ?? "emulator-5554", tap: values.tap, region: values.region ?? null, swipe: !!values.swipe, back: !!values.back, settle: Number(values.settle ?? 1.5), timeout: Number(values.timeout ?? 12), safe: !!values.safe };
  try {
    const result = step(opts, realDeps);
    console.log(result.text);
    if (values.shot) {
      const png = `${values.shot}.png`;
      const cap = realDeps.run("android", ["screen", "capture", "-o", png]);
      if (cap.status === 0) {
        try {
          const { shrink } = await import("./img-shrink.mjs");
          const r = shrink(png, { maxWidth: 540, out: values.shot });
          console.log(`screenshot: ${r.path} ${r.after.px.join("x")} ${r.after.bytes} B`);
        } catch (error) { console.log(`screenshot: could not shrink ${png} (${String(error.stderr ?? error.message).split("\n")[0].slice(0, 120)}); the full-size PNG is there`); }
      } else console.log("screenshot: android screen capture failed");
    }
  } catch (error) {
    if (error instanceof Stop) { console.error(`ui-step: STOP: ${error.message}`); process.exit(3); }
    throw error;
  }
}
