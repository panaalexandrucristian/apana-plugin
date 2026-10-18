// Mechanical session accounting for the live tests. Every start is a line in a TSV ledger: planned runs, retries,
// smoke runs and diagnostics all count. A start is refused when the allowance (cap - prior - already started) is
// not enough, so the plan can never silently shrink or overrun. The cap and the prior use are never defaulted.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const HEADER = "time\tid\tkind\tscenario\tarm\trun\tmodel\tstatus\tusd\n";
const KINDS = new Set(["planned", "reserve", "retry", "smoke", "pilot", "diagnostic"]);

/** Run fn while holding an exclusive lock file next to the ledger (concurrent starts must not share an id). */
function withLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let fd = -1;
  for (let attempt = 0; attempt < 150 && fd < 0; attempt += 1) {
    try {
      fd = openSync(lock, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (fd < 0) throw new Error("ledger is busy (lock not released within 3 s)");
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

export function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").slice(1).filter(Boolean).map((line) => {
    const [time, id, kind, scenario, arm, run, model, status, usd] = line.split("\t");
    return { time, id, kind, scenario, arm, run, model, status, usd: usd === undefined || usd === "" ? null : Number(usd) };
  });
}

/** Sessions already started in this ledger (each id counts once, whatever its later status). */
export const started = (path) => new Set(readLedger(path).map((row) => row.id)).size;

function need(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer (no default)`);
  return value;
}

export function allowance({ path, cap, prior }) {
  return need(cap, "cap") - need(prior, "prior") - started(path);
}

/** Record a session start; throws when the allowance is exhausted. Returns the new row. */
export function startSession({ path, cap, prior, kind, scenario, arm, run, model, guard, now = () => new Date().toISOString() }) {
  if (!KINDS.has(kind)) throw new Error(`unknown kind: ${kind}`);
  if (!model || !scenario) throw new Error("model and scenario are required");
  return withLock(path, () => {
    guard?.();
    if (allowance({ path, cap, prior }) < 1) throw new Error(`no allowance left: cap ${cap}, prior ${prior}, started ${started(path)}`);
    if (!existsSync(path)) appendFileSync(path, HEADER);
    const row = { time: now(), id: `s${started(path) + 1}`, kind, scenario, arm: arm ?? "", run: run ?? "", model, status: "started" };
    appendFileSync(path, `${Object.values(row).join("\t")}\t\n`);
    return row;
  });
}

/** Append the outcome of a started session, with its cost in USD when known (a start line is never edited). */
export function finishSession({ path, id, status, usd, now = () => new Date().toISOString() }) {
  const row = readLedger(path).find((r) => r.id === id);
  if (!row) throw new Error(`unknown session id: ${id}`);
  if (usd !== undefined && !(Number.isFinite(usd) && usd >= 0)) throw new Error("usd must be a non-negative number");
  withLock(path, () => appendFileSync(path, `${[now(), id, row.kind, row.scenario, row.arm, row.run, row.model, status, usd ?? ""].join("\t")}\n`));
}

/** Total USD recorded on finish lines. */
export const spentUsd = (path) => readLedger(path).reduce((sum, row) => sum + (row.usd ?? 0), 0);
