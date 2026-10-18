#!/usr/bin/env node
// The only way a live test session may be started or closed. Usage:
//   node session-budget.mjs status
//   node session-budget.mjs start --kind planned|reserve|retry|smoke|pilot|diagnostic --scenario S [--arm ON|OFF] [--run N] --model M
//   node session-budget.mjs finish --id sN --status STATUS [--usd 0.04]
// `start` prints the session id and exits 0, or prints the reason and exits 3 when the budget refuses. Nothing here
// starts a model session; the caller starts one only after `start` succeeded.
import { finishSession } from "./lib/ledger.mjs";
import { loadBudget, startBudgeted, status } from "./lib/budget.mjs";

const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 2) flags[rest[i]?.replace(/^--/, "")] = rest[i + 1];

try {
  const budget = loadBudget();
  if (command === "status") console.log(JSON.stringify(status(budget), null, 2));
  else if (command === "start") {
    const row = startBudgeted(budget, { kind: flags.kind, scenario: flags.scenario, arm: flags.arm, run: flags.run, model: flags.model });
    console.log(row.id);
  } else if (command === "finish") {
    finishSession({ path: budget.ledger, id: flags.id, status: flags.status ?? "finished", usd: flags.usd === undefined ? undefined : Number(flags.usd) });
    console.log("ok");
  } else {
    console.error("usage: session-budget.mjs status | start ... | finish ...");
    process.exit(2);
  }
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(String(error?.message).startsWith("refused:") ? 3 : 1);
}
