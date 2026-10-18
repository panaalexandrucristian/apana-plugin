#!/usr/bin/env node
// Start ONE live test session. Usage:
//   node run-session.mjs --scenario activation|conditions|bug|combos|trace|nocode|confine --arm ON|OFF --run N [--kind planned|reserve|retry|smoke|pilot|diagnostic]
//   node run-session.mjs ... --dry-run     (prints the command and the environment keys; starts nothing, records nothing)
// The budget refuses the start (exit 3) when the cap, the plan, the reserve or the USD guard says so.
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBudget } from "./lib/budget.mjs";
import { probePrompt } from "./lib/confine.mjs";
import { buildArgs, buildEnv, ensurePluginCopy, promptFor, runSession } from "./lib/run.mjs";

const flags = {};
const rest = process.argv.slice(2);
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--dry-run") flags.dryRun = true;
  else flags[rest[i].replace(/^--/, "")] = rest[++i];
}
try {
  const budget = loadBudget();
  const root = process.env.LTD_ROOT ?? join(homedir(), "Dev", "jev-test-runs", "logic-test-debug");
  if (!flags.scenario || !flags.arm || !flags.run) throw new Error("usage: --scenario S --arm ON|OFF --run N [--kind K] [--dry-run]");
  const plugin = ensurePluginCopy({ dest: join(root, "plugin"), ref: budget.pluginRef ?? "HEAD" });
  if (flags.dryRun) {
    console.log(JSON.stringify({ args: buildArgs({ prompt: flags.scenario === "confine" ? probePrompt(join(root, "sentinel")) : promptFor(flags.scenario, flags.run), pluginDir: plugin.dir, sessionId: "<uuid>" }), envKeys: Object.keys(buildEnv({ arm: flags.arm, cacheDir: "<run>/cache" })), pluginCommit: plugin.commit }, null, 2));
  } else {
    const verdict = await runSession({ budget, scenario: flags.scenario, arm: flags.arm, run: flags.run, kind: flags.kind ?? "planned", claudeBin: process.env.LTD_CLAUDE_BIN ?? "claude", pluginDir: plugin.dir, pluginCommit: plugin.commit, root });
    console.log(JSON.stringify({ id: verdict.id, status: verdict.status, turns: verdict.turns, usd: verdict.usd, model: verdict.model, loaded: verdict.score.loaded, directiveDelivered: verdict.score.directiveDelivered, record: verdict.score.record.present, success: verdict.evaluation?.success ?? null, dir: verdict.dir }, null, 2));
  }
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(String(error?.message).startsWith("refused:") ? 3 : 1);
}
