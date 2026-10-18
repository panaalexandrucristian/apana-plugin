#!/usr/bin/env node
// Runs the planned sessions in their pre-registered order, one at a time, skipping the ones already started, and stops
// at the first session that is not complete (a limit, an error, a refusal): a retry is a new session that has to be
// declared as reserve on purpose, never an automatic loop. It also stops at once when a session touched a path outside
// its workspace. A session starts only after the confinement probe has passed (see lib/run.mjs). Usage:
//   node campaign.mjs --list                          (the order and what is left; starts nothing)
//   node campaign.mjs [--only SCENARIO[,SCENARIO]] [--limit N]
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBudget } from "./lib/budget.mjs";
import { campaignOrder, remaining } from "./lib/campaign.mjs";
import { readLedger } from "./lib/ledger.mjs";
import { ensurePluginCopy, runSession } from "./lib/run.mjs";

const flags = {};
const rest = process.argv.slice(2);
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--list") flags.list = true;
  else flags[rest[i].replace(/^--/, "")] = rest[++i];
}
const budget = loadBudget();
const root = process.env.LTD_ROOT ?? join(homedir(), "Dev", "jev-test-runs", "logic-test-debug");
const only = flags.only ? flags.only.split(",") : null;
const todo = remaining(campaignOrder(budget.plan.planned), readLedger(budget.ledger).filter((row) => row.status === "started")).filter((e) => !only || only.includes(e.scenario));
const batch = flags.limit ? todo.slice(0, Number(flags.limit)) : todo;
if (flags.list) {
  console.log(JSON.stringify({ left: todo.length, next: batch.map((e) => `${e.scenario}/${e.arm}/${e.run}`) }, null, 1));
  process.exit(0);
}
const plugin = ensurePluginCopy({ dest: join(root, "plugin"), ref: budget.pluginRef ?? "HEAD" });
for (const entry of batch) {
  const verdict = await runSession({ budget, scenario: entry.scenario, arm: entry.arm, run: entry.run, kind: "planned", claudeBin: process.env.LTD_CLAUDE_BIN ?? "claude", pluginDir: plugin.dir, pluginCommit: plugin.commit, root });
  console.log(JSON.stringify({ id: verdict.id, scenario: entry.scenario, arm: entry.arm, run: entry.run, status: verdict.status, turns: verdict.turns, usd: verdict.usd, loaded: verdict.score.loaded, directive: verdict.score.directiveDelivered, record: verdict.score.record.present, success: verdict.evaluation?.success ?? null, denials: verdict.permissionDenials }));
  if (verdict.outside?.some((o) => !o.denied)) {
    console.log(`STOP: ${verdict.id} used a path outside its workspace (${verdict.outside.filter((o) => !o.denied).map((o) => `${o.tool} ${o.path}`).join("; ")}); nothing further was started`);
    process.exit(5);
  }
  if (verdict.status !== "complete") {
    console.log(`STOP: ${verdict.id} ended with status ${verdict.status}; nothing further was started`);
    process.exit(4);
  }
}
console.log(`done: ${batch.length} sessions`);
