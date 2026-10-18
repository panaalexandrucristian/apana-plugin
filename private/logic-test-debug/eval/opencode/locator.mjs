// Does the directive stay out of the read-only locator subagent of the flow? A session against the stand-in provider whose main agent
// calls the subagent `jev-locator` (the flow, switched on with JEV_FLOW=on, registers it). The probe plugin records, for every model
// request, which agent made it and whether the directive was in its system prompt. No model, no credentials, no cost.
// Usage: node locator.mjs <run dir> <plugin dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFINED_PERMISSION } from "./confine.mjs";
import { PROBE_PLUGIN } from "./real.mjs";
import { runSession } from "./run.mjs";

export async function checkLocator({ dir, pluginDir }) {
  const { LOGIC_DIRECTIVE } = await import(pathToFileURL(join(pluginDir, "private/logic-test-debug/check.mjs")).href);
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "utils.js"), "export const sum = (a, b) => a - b;\n");
  const log = join(dir, "probe.jsonl");
  const script = [{ name: "subagent", args: { agent: "jev-locator", description: "find sum", prompt: "Where is the function sum defined?" } }];
  const permission = { ...CONFINED_PERMISSION, subagent: "allow", task: "allow" };
  const r = await runSession({ dir, pluginDir: [pluginDir, PROBE_PLUGIN], prompt: "Fix the bug in utils.js: the function sum returns the wrong value.", mode: "script", script, permission, env: { JEV_FLOW: "on", PROBE_LOG: log, PROBE_DIRECTIVE: LOGIC_DIRECTIVE }, timeoutMs: 180000, cwd: ws, keepWorkspace: true });
  const requests = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.at === "context").map((x) => ({ agent: x.agent, directive: x.directive })) : [];
  const locator = requests.filter((x) => x.agent === "jev-locator");
  const main = requests.filter((x) => x.agent !== "jev-locator");
  return { exit: r.exit, requests, pass: locator.length > 0 && locator.every((x) => !x.directive) && main.length > 0 && main.every((x) => x.directive) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, pluginDir] = process.argv.slice(2);
  console.log(JSON.stringify(await checkLocator({ dir, pluginDir }), null, 2));
}
