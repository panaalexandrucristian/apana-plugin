// The pre-registered session budget of the live tests, enforced mechanically on top of the ledger: a total cap with
// no sessions used elsewhere, planned runs per scenario and arm, a reserve for everything else, and a USD guard.
// The numbers live in eval/budget.json, set by the user's delegated decision; nothing here has a default.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { allowance, readLedger, spentUsd, startSession } from "./ledger.mjs";

export const BUDGET_PATH = fileURLToPath(new URL("../budget.json", import.meta.url));
import { ARMS } from "./campaign.mjs";

export function loadBudget(path = process.env.LTD_BUDGET ?? BUDGET_PATH) {
  const budget = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["sessionsCap", "prior", "usdGuard"]) if (!Number.isFinite(budget[key]) || budget[key] < 0) throw new Error(`budget.json: ${key} must be a non-negative number`);
  const planned = Object.values(budget.plan.planned).reduce((a, b) => a + b, 0);
  if (planned + budget.plan.reserve > budget.sessionsCap - budget.prior) throw new Error("budget.json: the plan plus the reserve exceeds the cap");
  const ledger = (process.env.LTD_LEDGER ?? budget.ledger).replace(/^~(?=\/)/, homedir());
  return { ...budget, ledger };
}

/** Why a start is refused, or null. `rows` are the ledger rows (start lines have status "started"). */
export function refusal(budget, request, path = budget.ledger) {
  const starts = readLedger(path).filter((row) => row.status === "started");
  const { kind, scenario, arm } = request;
  if (allowance({ path, cap: budget.sessionsCap, prior: budget.prior }) < 1) return "the session cap is used up";
  if (spentUsd(path) >= budget.usdGuard) return `the USD guard of ${budget.usdGuard} is reached (spent ${spentUsd(path).toFixed(2)})`;
  if (kind === "planned") {
    const wanted = budget.plan.planned[scenario];
    if (wanted === undefined) return `unknown scenario: ${scenario}`;
    const arms = ARMS[scenario];
    if (!arms.includes(arm)) return `scenario ${scenario} has no arm ${arm}`;
    const perArm = wanted / arms.length;
    const done = starts.filter((row) => row.kind === "planned" && row.scenario === scenario && row.arm === arm).length;
    if (done >= perArm) return `the planned ${perArm} runs of ${scenario} arm ${arm} are used; a further run must be declared as reserve or retry`;
  } else {
    const spent = starts.filter((row) => row.kind !== "planned").length;
    if (spent >= budget.plan.reserve) return `the reserve of ${budget.plan.reserve} is used`;
  }
  return null;
}

/** Start a session if the budget allows; throws with the reason otherwise. */
export function startBudgeted(budget, request) {
  return startSession({
    path: budget.ledger,
    cap: budget.sessionsCap,
    prior: budget.prior,
    ...request,
    guard: () => {
      const reason = refusal(budget, request);
      if (reason) throw new Error(`refused: ${reason}`);
    },
  });
}

export function status(budget) {
  const path = budget.ledger;
  const starts = readLedger(path).filter((row) => row.status === "started");
  const byScenario = {};
  for (const row of starts) byScenario[`${row.scenario}/${row.arm}/${row.kind}`] = (byScenario[`${row.scenario}/${row.arm}/${row.kind}`] ?? 0) + 1;
  return { cap: budget.sessionsCap, prior: budget.prior, started: starts.length, allowance: allowance({ path, cap: budget.sessionsCap, prior: budget.prior }), usdSpent: spentUsd(path), usdGuard: budget.usdGuard, byScenario };
}
