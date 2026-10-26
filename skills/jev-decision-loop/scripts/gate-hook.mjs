#!/usr/bin/env node
// gate-hook: the skill's hooks, which make "Jev takes every decision" a mechanism instead of an instruction.
//   node gate-hook.mjs pre    PreToolUse: refuses a tool call that no Jev decision allowed; the jev.mjs calls themselves pass
//   node gate-hook.mjs post   PostToolUse on Bash: reads the VERDICT of a jev.mjs call; GO, or an UNSURE leaning to an option
//                             of a decision without gates, allows exactly one tool call
//   node gate-hook.mjs stop   Stop: refuses, once, the end of a turn unless the last decision picked the reply
//                             (an "Answer the user" option with a done gate, or "Ask the user")
// State per session in JEV_GATE_DIR (default ~/.claude/jev-decision-loop/gate): <session>.token, one allowed tool call, taken
// with rename so that of two parallel calls only one gets it (two unlinks of one file can both succeed on macOS); <session>.reply, the last decision covers ending the turn;
// <session>.off, after `jev.mjs --off` (the user said stop) until the next `jev.mjs --check`. Subagents are left alone.
// Any error lets the call through: a broken gate must not lock the session.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const JEV = join(dirname(fileURLToPath(import.meta.url)), "jev.mjs");
const STALE_MS = 7 * 24 * 3600 * 1000;
const CALL = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*node\s+(?:"[^"]*\/jev\.mjs"|'[^']*\/jev\.mjs'|[^\s"']*\/jev\.mjs|jev\.mjs)(?:\s+(--check|--off|--log(?:\s+\d+)?))?(?:\s+2>&1)?(?:\s+<<-?\s*(['"]?)([A-Za-z_]+)\2)?(?:\s+2>&1)?\s*$/;
const REPLY = /^(Answer|Ask) the user\b/i;

/** The jev.mjs call a Bash command is, or null: one `node .../jev.mjs` with a flag or a heredoc and nothing after it. */
export function jevCall(command) {
  const lines = String(command ?? "").split("\n");
  const m = CALL.exec(lines[0]);
  if (!m) return null;
  const flag = m[1]?.split(/\s/)[0] ?? null;
  if (!m[3]) return lines.slice(1).some((l) => l.trim()) ? null : { flag, body: "" };
  if (flag) return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === m[3]);
  if (end < 0 || lines.slice(end + 1).some((l) => l.trim())) return null;
  return { flag, body: lines.slice(1, end).join("\n") };
}

/** What a jev.mjs answer allows: { token } one tool call, { reply } ending the turn. */
export function allowance(body, stdout) {
  const v = /^VERDICT: (GO|UNSURE|STOP)\b(.*)$/m.exec(stdout ?? "");
  if (!v || /^JEV UNAVAILABLE/m.test(stdout)) return { token: false, reply: false };
  const gates = /^\s*gate\s+[A-Za-z][A-Za-z0-9_]*\s*:/im.test(body);
  if (v[1] === "UNSURE") return { token: !gates && /\(leaning [a-h]\)\s*$/.test(v[2]), reply: false };
  if (v[1] === "STOP") return { token: false, reply: false };
  const picked = / -- (.*)$/.exec(v[2])?.[1] ?? "";
  const done = /^\s*gate\s+done\s*:/im.test(body);
  return { token: true, reply: /^Ask the user\b/i.test(picked) || (done && (REPLY.test(picked) || /every gate holds/.test(picked))) };
}

const ASK = `ask Jev first, then do exactly the option it picks:\nnode ${JEV} <<'EOF'\ndecision: <what is being decided>\ntask: <the user's request; the first decision of the session only>\nfact: <what you learned, with file:line>\na: <one concrete step>\nb: <another>\nEOF\nOne GO allows one tool call; the call after it is a new decision.`;
const DENY = `No Jev decision allows this tool call (jev-decision-loop is on: Jev takes every decision of this session). Do not retry the same call: ${ASK}`;
const STOP = `No Jev decision covers ending this turn. Before you reply, ask Jev the last decision, with the reply as an option and the done gate:\nnode ${JEV} <<'EOF'\ndecision: whether to give the final answer now\ntask: <the user's request; the first decision of the session only>\nfact: <the facts, with file:line>\na: Answer the user: <the answer in one line>\nb: <the best step that would still check something>\ngate done: The facts in the state show that the user's request is fully done.\nEOF\nWhen you need the user instead, make the option "Ask the user: <the question>". Then reply as Jev picks (or do the step it picks).`;

function paths(sessionId, env) {
  const dir = env.JEV_GATE_DIR || join(homedir(), ".claude", "jev-decision-loop", "gate");
  const id = String(sessionId || "none").replace(/[^A-Za-z0-9_-]/g, "_");
  return { dir, token: join(dir, `${id}.token`), reply: join(dir, `${id}.reply`), off: join(dir, `${id}.off`) };
}

const put = (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ""); };
const drop = (path) => { try { unlinkSync(path); return true; } catch { return false; } };
const take = (path) => {
  const mine = `${path}.${process.pid}`;
  try { renameSync(path, mine); } catch { return false; }
  rmSync(mine, { force: true });
  return true;
};

function prune(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { force: true });
  }
}

/** One hook event; returns the JSON to print, or null to let it through. */
export function handle(event, input, env = process.env) {
  if (input.agent_id) return null;
  const p = paths(input.session_id, env);
  const call = input.tool_name === "Bash" ? jevCall(input.tool_input?.command) : null;
  if (event === "pre") {
    if (call?.flag === "--off") { put(p.off); drop(p.token); drop(p.reply); return null; }
    if (call?.flag === "--check") drop(p.off);
    if (existsSync(p.off)) return null;
    if (call) { if (call.flag !== "--log") { drop(p.token); drop(p.reply); } return null; }
    drop(p.reply);
    if (take(p.token)) return null;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY } };
  }
  if (event === "post") {
    if (!call || call.flag || existsSync(p.off)) return null;
    const r = input.tool_response;
    const { token, reply } = allowance(call.body, typeof r === "string" ? r : `${r?.stdout ?? ""}\n${r?.stderr ?? ""}`);
    if (token) put(p.token); else drop(p.token);
    if (reply) put(p.reply); else drop(p.reply);
    return null;
  }
  if (event === "stop") {
    if (existsSync(p.off)) return null;
    if (existsSync(p.reply) || input.stop_hook_active) {
      drop(p.reply); drop(p.token);
      try { prune(p.dir); } catch {}
      return null;
    }
    return { decision: "block", reason: STOP };
  }
  return null;
}

async function cli() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const out = handle(process.argv[2], JSON.parse(text));
  if (out) process.stdout.write(JSON.stringify(out) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await cli(); } catch (error) { process.stderr.write(`gate-hook: ${error.message}\n`); }
}
