// OpenCode check with a real model. Commands (all take the run root as the first argument):
//   confine <root> <pluginDir>   prove the confinement with the stand-in provider (no model); writes confinement.json
//   credentials <root>           import the GitHub Copilot credential into a template folder (removed by `cleanup`)
//   run <root> <pluginDir> [ids] [scenario]  the four planned sessions, one after the other: ON, OFF, OFF, ON (or only the ids given,
//                                e.g. s1; `-` for all); the scenario is conditions (default), combos or trace; then an optional model id and the number of pairs (default 2, so four sessions)
//   report <root>                counts of what the stored sessions show, as markdown
//   cleanup <root>               remove the credential template
// The design (question, model, task, arms, order, what is counted, what would stop it) is in eval/README.md and was fixed before the
// first session. Cap: 4 planned sessions and 2 reserve, enforced in ledgerStart.
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promptFor } from "../lib/run.mjs";
import { CONFINED_PERMISSION, confineScript, confinementProven, judgeConfine, prepareSentinels, writeProof } from "./confine.mjs";
import { MODEL, PROBE_PLUGIN, openCodeVersion, prepareCredentials, removeCredentials, runReal, summarizeProbe } from "./real.mjs";
import { clopperPearson, compareArms, compareScores } from "../lib/stats.mjs";
import { runSession, summarizeRequests } from "./run.mjs";

/** The planned order for `pairs` pairs: odd pairs start with ON, even pairs with OFF, so a drift in time cannot favour one arm. Two pairs: ON, OFF, OFF, ON. */
export function makePlan(pairs = 2) {
  const plan = [];
  for (let k = 1; k <= pairs; k += 1) {
    const arms = k % 2 === 1 ? ["ON", "OFF"] : ["OFF", "ON"];
    arms.forEach((arm, j) => plan.push({ id: `s${plan.length + 1}`, arm, run: k, order: j }));
  }
  return plan;
}
export const PLAN = makePlan(2);

async function confine(root, pluginDir) {
  mkdirSync(root, { recursive: true });
  const version = openCodeVersion();
  const { LOGIC_DIRECTIVE } = await import(pathToFileURL(join(pluginDir, "private/logic-test-debug/check.mjs")).href);
  const probeEnv = { PROBE_LOG: join(root, "runs/confine/probe.jsonl"), PROBE_DIRECTIVE: LOGIC_DIRECTIVE };
  const sentinels = prepareSentinels(root);
  const dir = join(root, "runs/confine");
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "hello.txt"), "hello inside\n");
  const script = confineScript(workspace, sentinels);
  const r = await runSession({ dir, pluginDir: [pluginDir, PROBE_PLUGIN], prompt: "Permission test.", mode: "script", script: script.map(({ name, args }) => ({ name, args })), permission: CONFINED_PERMISSION, env: probeEnv, timeoutMs: 240000, cwd: workspace, keepWorkspace: true });
  const verdict = judgeConfine({ logText: readFileSync(join(dir, "requests.jsonl"), "utf8"), script, sentinels, workspace });
  sentinels.cleanupTmp();
  console.log(`confinement probe: exit ${r.exit}, timedOut ${r.timedOut}, pass ${verdict.pass}`);
  for (const row of verdict.table) console.log(`  ${row.ok ? "ok  " : "FAIL"} ${row.label.padEnd(26)} expected ${row.expect.padEnd(11)} got ${row.got}`);
  for (const reason of verdict.reasons) console.log(`  reason: ${reason}`);
  if (!verdict.pass) process.exitCode = 1;

  // The probe plugin must agree with what the model-side request log shows, or its numbers in real sessions mean nothing.
  const check = await runSession({ dir: join(root, "runs/probe-check"), pluginDir: [pluginDir, PROBE_PLUGIN], prompt: promptFor("conditions", 1), mode: "load-skill", permission: CONFINED_PERMISSION, env: { ...probeEnv, PROBE_LOG: join(root, "runs/probe-check/probe.jsonl") }, timeoutMs: 180000 });
  const fromRequests = summarizeRequests(readFileSync(join(root, "runs/probe-check/requests.jsonl"), "utf8")).directiveInSystem;
  const probe = summarizeProbe(readFileSync(join(root, "runs/probe-check/probe.jsonl"), "utf8"));
  const agree = probe.modelRequests === fromRequests.length && probe.withDirective === fromRequests.filter(Boolean).length && fromRequests[0] === true;
  console.log(`probe plugin check: requests ${JSON.stringify(fromRequests)} probe ${JSON.stringify(probe)} agree ${agree} (exit ${check.exit})`);
  if (!agree) process.exitCode = 1;
  if (verdict.pass && agree) {
    writeProof(root, version, pluginDir);
    console.log("confinement.json written");
  }
}

async function runAll(root, pluginDir, only = null, scenario = "conditions", model = MODEL, pairs = 2) {
  const plan = makePlan(pairs);
  writeFileSync(join(root, "caps.json"), `${JSON.stringify({ planned: plan.length, total: plan.length + 2 })}\n`);
  for (const step of plan.filter((p) => !only || only.includes(p.id))) {
    const verdict = await runReal({ root, id: step.id, kind: "planned", scenario, arm: step.arm, run: step.run, prompt: promptFor(scenario, step.run), pluginDir, model });
    if (verdict.voided) {
      console.log(`${step.id} VOIDED: no model request was made (see ledger.tsv); stopping, nothing else is started`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ id: step.id, arm: step.arm, complete: verdict.complete, seconds: verdict.seconds, skillLoaded: verdict.session.skillLoaded, record: verdict.session.record.present, directive: `${verdict.probe.withDirective}/${verdict.probe.modelRequests}`, oracle: `${verdict.oracle.passed}/${verdict.oracle.total}`, score: verdict.oracle.score, success: verdict.oracle.success }));
    if (verdict.oracle.outOfScope?.length || verdict.session.rejected.length) console.log(`  note: refused attempts ${JSON.stringify(verdict.session.rejected)}, files outside scope ${JSON.stringify(verdict.oracle.outOfScope)}`);
  }
}

export function loadVerdicts(root) {
  const runs = join(root, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs).filter((n) => /^s\d+$/.test(n) && existsSync(join(runs, n, "verdict.json"))).sort().map((n) => JSON.parse(readFileSync(join(runs, n, "verdict.json"), "utf8"))).filter((v) => !v.voided);
}

/** Markdown with counts only; nothing is tested at n = 2 per arm. Pure over the verdicts. */
export function toMarkdown(verdicts) {
  const lines = ["# logic-test-debug on OpenCode, real model: report", "", `Sessions: ${verdicts.length}. Model ${verdicts[0]?.model ?? MODEL}, OpenCode ${verdicts[0]?.version ?? "?"}, task: ${verdicts[0]?.scenario ?? "?"}. ${verdicts.filter((v) => v.arm === "ON").length >= 5 && verdicts.filter((v) => v.arm === "OFF").length >= 5 ? "The tests below were fixed before the first session." : "Counts only; with 2 sessions per arm no test is run and no effect is claimed."}`, ""];
  lines.push("| id | arm | complete | s | model requests | with directive | skill loaded | record | tools | oracle | success | refused (path) | not offered |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const v of verdicts) {
    const tools = Object.entries(v.session.toolCalls.reduce((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {})).map(([n, c]) => `${n}×${c}`).join(" ");
    lines.push(`| ${v.id} | ${v.arm} | ${v.complete} | ${v.seconds} | ${v.probe.modelRequests} | ${v.probe.withDirective} | ${v.session.skillLoaded} | ${v.session.record.present} | ${tools} | ${v.oracle.passed}/${v.oracle.total} | ${v.oracle.success} | ${v.session.rejected.length} | ${v.session.unavailable?.length ?? 0} |`);
  }
  const arm = (a) => verdicts.filter((v) => v.arm === a);
  const n = (list, pick) => list.filter(pick).length;
  lines.push("", "| arm | sessions | directive in the first request | skill loaded | record | oracle success |", "|---|---|---|---|---|---|");
  for (const a of ["ON", "OFF"]) {
    const list = arm(a);
    lines.push(`| ${a} | ${list.length} | ${n(list, (v) => v.probe.firstHasDirective)} | ${n(list, (v) => v.session.skillLoaded)} | ${n(list, (v) => v.session.record.present)} | ${n(list, (v) => v.oracle.success)} |`);
  }
  if (verdicts.some((v) => v.scenario === "combos")) {
    lines.push("", "Scores of the task `combos` (faulty versions the agent's tests catch, of 11, counted only when both clean versions pass):", "", "| id | arm | clean versions pass | caught of 11 | score | oracle skipped |", "|---|---|---|---|---|---|");
    for (const v of verdicts) lines.push(`| ${v.id} | ${v.arm} | ${v.oracle.clean ? `${v.oracle.clean.correct}, ${v.oracle.clean.equivalent}` : "-"} | ${v.oracle.killed ? v.oracle.killed.length : "-"} | ${v.oracle.score ?? "-"} | ${v.oracle.skipped === true} |`);
  }
  const withBehaviour = verdicts.filter((v) => v.behaviour);
  if (withBehaviour.length > 0) {
    lines.push("", "Behaviour measures (descriptive, not scored): the test file edited, loops in it, the answer mentions combinations or pairs, the answer names INFERENCE.", "", "| id | arm | edited tests | loops in tests | mentions combinations | mentions INFERENCE |", "|---|---|---|---|---|---|");
    for (const v of withBehaviour) lines.push(`| ${v.id} | ${v.arm} | ${v.behaviour.editedTests} | ${v.behaviour.testLoops ?? "-"} | ${v.behaviour.mentionsCombination} | ${v.behaviour.mentionsInference} |`);
  }
  if (arm("ON").length >= 5 && arm("OFF").length >= 5) {
    const yes = (list, pick) => list.filter(pick).length;
    const row = (label, pick) => {
      const c = compareArms({ onSuccess: yes(arm("ON"), pick), onN: arm("ON").length, offSuccess: yes(arm("OFF"), pick), offN: arm("OFF").length });
      return `| ${label} | ${c.on} | ${c.off} | ${c.p.toFixed(4)} | ${c.effectClaimed ? `yes (${c.direction})` : "no"} |`;
    };
    lines.push("", "Exact two-sided Fisher tests of yes/no outcomes (an effect is claimed only below 0.05):", "", "| outcome | ON | OFF | p | effect claimed |", "|---|---|---|---|---|");
    lines.push(row("skill loaded", (v) => v.session.skillLoaded), row("record written", (v) => v.session.record.present), row("a clean version failed (score 0 by the rule)", (v) => v.oracle.clean && !(v.oracle.clean.correct && v.oracle.clean.equivalent)));
    if (verdicts.some((v) => v.scenario === "combos" || v.scenario === "trace")) {
      const c = compareScores(arm("ON").map((v) => v.oracle.score ?? 0), arm("OFF").map((v) => v.oracle.score ?? 0), 0.05);
      lines.push("", `Score (the one pre-registered comparison, exact permutation test of the difference of the means, alpha 0.05): ON mean ${c.onMean.toFixed(2)}, OFF mean ${c.offMean.toFixed(2)}, p = ${c.p.toFixed(4)}, effect claimed: ${c.effectClaimed ? `yes (${c.direction})` : "no"}.`);
    }
    const failed = verdicts.filter((v) => v.oracle.clean && !(v.oracle.clean.correct && v.oracle.clean.equivalent)).length;
    if (verdicts.some((v) => v.oracle.clean)) {
      const ci = clopperPearson(failed, verdicts.length);
      lines.push("", `A clean version failed in ${failed} of ${verdicts.length} sessions (${(100 * failed / verdicts.length).toFixed(0)} %; exact 95 % interval ${(100 * ci.low).toFixed(0)} to ${(100 * ci.high).toFixed(0)} %): the share of sessions whose score the rule turns into 0.`);
    }
  }
  const outside = verdicts.filter((v) => v.oracle.outOfScope?.length);
  const everyRequest = arm("ON").length > 0 && arm("ON").every((v) => v.probe.modelRequests > 0 && v.probe.withDirective === v.probe.modelRequests);
  lines.push("", `Gates: every ON session had the directive in its first model request: ${arm("ON").length > 0 && arm("ON").every((v) => v.probe.firstHasDirective)}; in every model request of the session (plugin 0.10.4 and later): ${everyRequest}; no OFF session had it: ${arm("OFF").every((v) => v.probe.withDirective === 0)}; sessions that changed files outside the allowed edits: ${outside.length}.`);
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, root, pluginDir] = process.argv.slice(2);
  if (command === "confine") await confine(root, pluginDir);
  else if (command === "credentials") {
    prepareCredentials(root);
    console.log("credential template ready");
  } else if (command === "run") await runAll(root, pluginDir, process.argv[5] && process.argv[5] !== "-" ? process.argv[5].split(",") : null, process.argv[6] ?? "conditions", process.argv[7] ?? MODEL, Number(process.argv[8] ?? 2));
  else if (command === "report") {
    const md = toMarkdown(loadVerdicts(root));
    writeFileSync(join(root, "report.md"), md);
    console.log(md);
  } else if (command === "cleanup") {
    removeCredentials(root);
    console.log("credential template removed");
  } else {
    console.error("usage: campaign.mjs confine|credentials|run|report|cleanup <root> [pluginDir]");
    process.exitCode = 2;
  }
}
