#!/usr/bin/env node
// jev: one decision of a coding session, asked to Jev (TypeSafe's judgment model) over its direct API, answered with a verdict to follow.
//   node jev.mjs <<'EOF'
//   decision: what is being decided
//   task: the user's request
//   fact: what was learned (any number of fact: and done: lines)
//   a: one concrete step
//   b: another
//   step: Editing line 12 of x.kt to ...   (a phrase that starts with an -ing verb; the gates below with no text are written from it)
//   gate in_scope:                          no text: "<step> is exactly what the user asked for."
//   gate reversible:                        no text: "<step> can be undone without losing anything."
//   gate safe: a statement Jev rates true or false
//   EOF
//   node jev.mjs --check      one tiny live request: is Jev reachable with the key found?
//   node jev.mjs --log [N]    the last N (default 20) decisions of the log
//   node jev.mjs --off        the user ended the loop: the skill's gate hook (gate-hook.mjs) lets every call through until the next --check
// Lines, not JSON, because Claude Code's Bash check refuses a command with a brace next to a quote, so a JSON request never runs.
// A JSON request ({"decision", "state", "options", "gates"}) is still read when the text starts with "{", for use outside Claude Code.
// The request may also be the first argument or come from --file <path>. `options` becomes one Jev choice question, each gate one noul
// question (the probability that the statement is true). Provider: TYPESAFE_API_KEY (direct, the default) or OPENROUTER_API_KEY, from the
// environment or the macOS Keychain (services claude-code-jev-typesafe / claude-code-jev-openrouter); JEV_PROVIDER and JEV_MODEL override.
// Every answered decision is appended to JEV_DECISION_LOG (default ~/.claude/jev-decision-loop/decisions.jsonl) without its state.
// Exit codes: 0 answered (whatever the verdict), 2 bad request, 3 refused before sending (looks like a secret, too long), 4 Jev unavailable.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GO_MIN = 0.6; // the chosen option needs at least this probability...
export const GO_MARGIN = 0.2; // ...and this lead over the runner-up
export const YES_MIN = 0.7; // a gate is true at or above this, false at or below NO_MAX, unsure between
export const NO_MAX = 0.3;
export const MAX_REQUEST_CHARS = 24_000;
const ID = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** Gates with no text of their own get their statement from the `step:` line; the wording is the one measured in PRIVATE.md («Jev decision loop»). */
export const STEP_GATES = {
  in_scope: (step) => `${step} is exactly what the user asked for.`,
  reversible: (step) => `${step} can be undone without losing anything.`,
};
const TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

export const PROVIDERS = {
  typesafe: { env: "TYPESAFE_API_KEY", service: "claude-code-jev-typesafe", url: (env) => `${(env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "")}/v1/systemone` },
  openrouter: { env: "OPENROUTER_API_KEY", service: "claude-code-jev-openrouter", url: () => "https://openrouter.ai/api/alpha/decisions" },
};
// jev-1.14 and ~typesafe/jev-latest are blocked by the OpenRouter guardrail of this account (2026-10-25); 1.13 answers on both providers.
export const DEFAULT_MODEL = "typesafe/jev-1.13";

const SECRETS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["password assignment", /\b(password|passwd|secret|api_?key|token)\s*[:=]\s*["'][^\s"']{8,}["']/i],
];

export class Refused extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** `gates` with every STEP_GATES gate that has no text written from `step`; a gate that has text is kept as written. */
function withStepStatements(gates, step) {
  if (!gates || typeof gates !== "object" || Array.isArray(gates)) return gates;
  const out = { ...gates };
  for (const [id, statement] of Object.entries(STEP_GATES)) {
    if (!Object.hasOwn(out, id) || typeof out[id] !== "string" || out[id].trim()) continue;
    const phrase = String(step ?? "").trim().replace(/[.\s]+$/, "");
    if (!phrase) throw new Refused(2, `gate ${id} has no statement: write a "step:" line (a phrase that starts with an -ing verb, for example "Editing line 12 of strings.xml to change login_button from Log in to Sign in") or write the statement after "gate ${id}:"`);
    if (!/^[A-Za-z]+ing\b/.test(phrase)) throw new Refused(2, `"step:" must start with an -ing verb ("Editing line 12 of strings.xml to ...", "Running npm test"): the gates read it as "<step> is exactly what the user asked for."`);
    out[id] = statement(phrase);
  }
  return out;
}

/** The request in canonical form: `options` as an object (an array becomes a, b, c...), ids checked, at least one question. */
export function normalize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refused(2, "the request must be a JSON object");
  const decision = String(raw.decision ?? raw.question ?? "").trim();
  if (!decision) throw new Refused(2, 'missing "decision": one line saying what is being decided');
  if (raw.state === undefined || raw.state === null || raw.state === "") throw new Refused(2, 'missing "state": the facts Jev needs (task, evidence, constraints)');
  let options = raw.options ?? null;
  if (Array.isArray(options)) options = Object.fromEntries(options.map((text, i) => [String.fromCharCode(97 + i), text]));
  const gates = withStepStatements(raw.gates ?? raw.checks ?? null, raw.step);
  for (const [what, group] of [["options", options], ["gates", gates]]) {
    if (group === null) continue;
    if (typeof group !== "object" || Array.isArray(group)) throw new Refused(2, `"${what}" must be an object of id: text`);
    for (const [id, text] of Object.entries(group)) {
      if (!ID.test(id)) throw new Refused(2, `${what} id "${id}" must be a letter followed by letters, digits or _ (at most 40)`);
      if (typeof text !== "string" || !text.trim()) throw new Refused(2, `${what} "${id}" needs a non-empty text`);
    }
  }
  const optionCount = options ? Object.keys(options).length : 0;
  if (optionCount === 1) throw new Refused(2, 'one option is not a decision: give 2-5 options, or put the statement under "gates"');
  if (optionCount > 8) throw new Refused(2, "more than 8 options: narrow them down first");
  if (gates && Object.hasOwn(gates, "next")) throw new Refused(2, 'gate id "next" is reserved for the options');
  if (!optionCount && !(gates && Object.keys(gates).length)) throw new Refused(2, 'nothing to ask: give "options" (2-8) and/or "gates"');
  return { decision, state: raw.state, options: optionCount ? options : null, gates: gates && Object.keys(gates).length ? gates : null };
}

const LINE = /^\s*(decision|task|fact|done|step|[a-h]|gate\s+[A-Za-z][A-Za-z0-9_]{0,39})\s*:\s?(.*)$/i;

/** The raw request for the line format: decision, task, fact, done and step lines, one line per option (a-h) and per gate ("gate <id>:").
 * A line that does not start with one of those keys continues the line before it. */
export function parseLines(text) {
  const entries = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = LINE.exec(line);
    if (match) entries.push([match[1].toLowerCase().replace(/\s+/, " "), match[2].trim(), match[1]]);
    else if (entries.length) entries.at(-1)[1] = `${entries.at(-1)[1]} ${line.trim()}`.trim();
    else throw new Refused(2, `line ${index + 1} does not start with a key: write "decision: ...", "task: ...", "fact: ...", "done: ...", "step: ...", "a: ..." or "gate <id>: ..."`);
  }
  const raw = { decision: "", state: { task: "", facts: [], done: [] }, options: null, gates: null };
  for (const [key, value, written] of entries) {
    if (key === "decision" || key === "task") {
      const slot = key === "task" ? raw.state : raw;
      if (slot[key]) throw new Refused(2, `two "${key}:" lines: write one`);
      slot[key] = value;
    } else if (key === "fact") raw.state.facts.push(value);
    else if (key === "done") raw.state.done.push(value);
    else if (key === "step") {
      if (raw.step) throw new Refused(2, 'two "step:" lines: write one');
      raw.step = value;
    } else {
      const [group, id] = key.startsWith("gate ") ? ["gates", written.trim().split(/\s+/)[1]] : ["options", key];
      raw[group] ??= {};
      if (Object.hasOwn(raw[group], id)) throw new Refused(2, `two lines for ${group === "gates" ? `gate ${id}` : `option ${id}`}: write one`);
      raw[group][id] = value;
    }
  }
  if (!raw.state.task) throw new Refused(2, 'missing "task:": the user\'s request, in their words');
  return raw;
}

/** The Jev {state, questions} body for a normalized request. */
export function toQuestions(request) {
  const questions = {};
  if (request.options) {
    questions.next = { type: "choice", instructions: `Decision of a coding agent: ${request.decision}. Given the state, which option should the agent take now?`, criteria: request.options };
  }
  for (const [id, text] of Object.entries(request.gates ?? {})) questions[id] = { type: "noul", instructions: text };
  return { state: request.state, questions };
}

/** A refusal reason when the serialized body looks like it carries a secret or is too long, else null. */
export function screen(body, key = "") {
  const text = JSON.stringify(body);
  if (text.length > MAX_REQUEST_CHARS) return { code: 3, message: `the request has ${text.length} characters (limit ${MAX_REQUEST_CHARS}): summarize the state` };
  if (key && text.includes(key)) return { code: 3, message: "the request contains the API key itself" };
  for (const [kind, re] of SECRETS) if (re.test(text)) return { code: 3, message: `the request looks like it contains a secret (${kind}): remove it` };
  return null;
}

const pct = (p) => (typeof p === "number" ? p.toFixed(2) : "?");

/** The truth table: answers -> { verdict: GO|UNSURE|STOP, chosen, reason, lines } . */
export function verdict(request, answers) {
  const lines = [];
  let chosen = null;
  let unsure = [];
  const stops = [];
  if (request.options) {
    const answer = answers?.next;
    const probs = answer?.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : null;
    if (!probs || typeof answer.choice !== "string" || !Object.hasOwn(request.options, answer.choice)) throw new Refused(4, "Jev returned no usable choice for the options");
    const ranked = Object.keys(request.options).map((id) => [id, Number(probs[id] ?? 0)]).sort((a, b) => b[1] - a[1]);
    lines.push(`options: ${ranked.map(([id, p]) => `${id} ${pct(p)}`).join(" | ")}`);
    const [top, second = [null, 0]] = ranked;
    chosen = top[0];
    // Rounded to the two decimals Jev reports, so that 0.6 vs 0.4 is a lead of 0.2 and not 0.19999999999999996.
    if (top[1] < GO_MIN || Math.round((top[1] - second[1]) * 100) < Math.round(GO_MARGIN * 100)) unsure.push(`no clear option (${top[0]} ${pct(top[1])} vs ${second[0] ?? "-"} ${pct(second[1])})`);
  }
  for (const id of Object.keys(request.gates ?? {})) {
    const p = answers?.[id]?.noul;
    if (typeof p !== "number") throw new Refused(4, `Jev returned no probability for gate "${id}"`);
    const state = p >= YES_MIN ? "yes" : p <= NO_MAX ? "NO" : "unsure";
    lines.push(`gate ${id}: ${pct(p)} ${state}`);
    if (state === "NO") stops.push(`gate ${id} is false (${pct(p)})`);
    else if (state === "unsure") unsure.push(`gate ${id} is unsure (${pct(p)})`);
  }
  if (stops.length) return { verdict: "STOP", chosen, reason: stops.join("; "), lines };
  if (unsure.length) return { verdict: "UNSURE", chosen, reason: unsure.join("; "), lines };
  return { verdict: "GO", chosen, reason: "", lines };
}

export function render(request, result) {
  const out = [...result.lines];
  if (result.verdict === "GO") {
    out.push(result.chosen ? `VERDICT: GO ${result.chosen} -- ${request.options[result.chosen]}` : "VERDICT: GO -- every gate holds");
    out.push(`${result.chosen ? `Next tool call: exactly option ${result.chosen}, nothing else.` : "Next tool call: the action these gates were about."} The call after it is a new Jev decision, even when it looks obvious (reading what a search found, retrying a failed search, answering).`);
  } else if (result.verdict === "UNSURE") {
    out.push(`VERDICT: UNSURE -- ${result.reason}${result.chosen ? ` (leaning ${result.chosen})` : ""}`);
    const settle = "ask a new Jev decision whose options are the reads or searches that would settle it, do the one it picks, add the fact and ask this decision again.";
    // No gates means the options change nothing (SKILL.md asks for a gate before every change), so a wrong pick costs one read.
    if (result.chosen && !request.gates) out.push(`Next tool call: option ${result.chosen} if it only reads (a Read, a search, a listing): it is the cheapest read, and a wrong one costs little. If it changes anything, ${settle}`);
    else out.push(`Next: ${settle}`);
    out.push("UNSURE again on the same options after that: ask the user, with these numbers. New options are a new decision.");
  } else {
    out.push(`VERDICT: STOP -- ${result.reason}`);
    out.push("Do not take this path. Change the options (or the plan) and ask Jev again; if no safe option is left, ask the user.");
  }
  return out.join("\n");
}

function keychain(service) {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The provider to use, its key and where the key came from; null when no key is found. */
export function resolveProvider(env = process.env, readKeychain = keychain) {
  const wanted = env.JEV_PROVIDER ? [env.JEV_PROVIDER] : ["typesafe", "openrouter"];
  for (const name of wanted) {
    const provider = PROVIDERS[name];
    if (!provider) throw new Refused(2, `JEV_PROVIDER must be typesafe or openrouter, not "${name}"`);
    if (env[provider.env]) return { name, key: env[provider.env], source: `$${provider.env}`, url: provider.url(env), model: env.JEV_MODEL || DEFAULT_MODEL };
    const key = readKeychain(provider.service);
    if (key) return { name, key, source: `Keychain ${provider.service}`, url: provider.url(env), model: env.JEV_MODEL || DEFAULT_MODEL };
  }
  return null;
}

const retryable = (status) => status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);

/** POST {model, state, questions}; retries network errors, 408/409/429 and 5xx. Returns {answers, ms}. */
export async function ask(provider, body, fetchImpl = fetch) {
  const started = Date.now();
  let last = "no attempt";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetchImpl(provider.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json", Accept: "application/json", "X-Title": "jev-decision-loop" },
        body: JSON.stringify({ model: provider.model, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      last = `request failed (${error?.name === "TimeoutError" ? "timeout" : "network"})`;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
      continue;
    }
    const text = await response.text();
    if (response.ok) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Refused(4, "Jev answered with something that is not JSON"); }
      if (!parsed?.answers || typeof parsed.answers !== "object") throw new Refused(4, "Jev answered without answers");
      return { answers: parsed.answers, ms: Date.now() - started, model: parsed.model || provider.model };
    }
    let message = "";
    try { message = JSON.parse(text)?.error?.message ?? ""; } catch {}
    last = `HTTP ${response.status}${message ? `: ${String(message).split(provider.key).join("[redacted]").split("\n")[0].slice(0, 160)}` : ""}`;
    if (!retryable(response.status) || attempt === ATTEMPTS) break;
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw new Refused(4, `${provider.name} ${provider.model}: ${last}`);
}

export function logPath(env = process.env) {
  return env.JEV_DECISION_LOG || join(homedir(), ".claude", "jev-decision-loop", "decisions.jsonl");
}

function log(entry, env) {
  try {
    const path = logPath(env);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {}
}

/** JSON when the text starts with "{", else the line format. */
export function parseRequest(text) {
  return text.trim().startsWith("{") ? JSON.parse(text) : text.trim() ? parseLines(text) : null;
}

async function readRequest(args) {
  const fileAt = args.indexOf("--file");
  if (fileAt >= 0) return readFileSync(args[fileAt + 1], "utf8");
  if (args[0] && !args[0].startsWith("--")) return args[0];
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const unavailable = (why) => `JEV UNAVAILABLE: ${why}\nVERDICT: UNSURE -- Jev did not answer, so nothing is decided. Tell the user; do not continue as if Jev had said GO.`;

function noKey() {
  const here = dirname(fileURLToPath(import.meta.url));
  return unavailable(`no key: set TYPESAFE_API_KEY (https://typesafe.ai) or OPENROUTER_API_KEY (https://openrouter.ai/keys) in the environment, or store one with: bash ${join(here, "register-jev-key.sh")} register typesafe|openrouter`);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args[0] === "--off") {
    console.log("JEV LOOP OFF: the gate lets every tool call through for the rest of this session; `--check` switches it on again.");
    return 0;
  }
  if (args[0] === "--log") {
    const path = logPath(env);
    const rows = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
    const n = Number(args[1]) > 0 ? Number(args[1]) : 20;
    for (const row of rows.slice(-n)) {
      const e = JSON.parse(row);
      console.log(`${e.at} ${e.verdict}${e.chosen ? ` ${e.chosen}` : ""} ${e.ms}ms ${e.decision} [${e.cwd}]`);
    }
    console.log(`${rows.length} decisions in ${path}`);
    return 0;
  }
  let provider;
  try {
    provider = resolveProvider(env);
  } catch (error) {
    console.log(`JEV REQUEST REFUSED: ${error.message}`);
    return error instanceof Refused ? error.code : 2;
  }
  if (!provider) { console.log(noKey()); return 4; }
  const check = args[0] === "--check";
  let request;
  try {
    const raw = check
      ? { decision: "connectivity check", state: { note: "a connectivity check of the jev-decision-loop skill" }, gates: { ok: "This request is a connectivity check." } }
      : parseRequest(await readRequest(args));
    request = normalize(raw);
  } catch (error) {
    console.log(`JEV REQUEST REFUSED: ${error instanceof SyntaxError ? `the request is not valid JSON (${error.message})` : error.message}`);
    return error instanceof Refused ? error.code : 2;
  }
  const body = toQuestions(request);
  const refusal = screen(body, provider.key);
  if (refusal) { console.log(`JEV REQUEST REFUSED: ${refusal.message}. Nothing was sent.`); return refusal.code; }
  try {
    const { answers, ms, model } = await ask(provider, body);
    if (check) { console.log(`JEV OK: ${provider.name} ${model} answered in ${ms} ms (key from ${provider.source}).`); return 0; }
    const result = verdict(request, answers);
    console.log(`JEV ${request.decision} (${provider.name} ${model}, ${ms} ms)\n${render(request, result)}`);
    log({ at: new Date().toISOString(), cwd: process.cwd(), provider: provider.name, model, ms, decision: request.decision, options: request.options ? Object.keys(request.options) : [], gates: Object.keys(request.gates ?? {}), answers, verdict: result.verdict, chosen: result.chosen }, env);
    return 0;
  } catch (error) {
    if (error instanceof Refused) { console.log(unavailable(error.message)); return error.code; }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
