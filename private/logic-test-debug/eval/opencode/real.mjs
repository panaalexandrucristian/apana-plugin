// One OpenCode session with a REAL model, confined by CONFINED_PERMISSION (see confine.mjs) and watched by a probe plugin.
// Everything the session does is read afterwards from its own database (OpenCode 2.0.22 stores a session as rows of
// `session_message` with a JSON `data` column: user messages {text}, assistant messages {content: [{type: "text"|"tool", ...}], tokens, cost}).
// The model's credentials are imported once into a template data folder and copied into each session, so nothing of the user's own
// OpenCode state is used or changed, and the template is removed when the campaign ends.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateRun } from "../lib/evaluate.mjs";
import { behaviourFrom } from "../lib/report.mjs";
import { changedFiles, createWorkspace } from "../lib/workspace.mjs";
import { CONFINED_PERMISSION, confinementProven } from "./confine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROBE_PLUGIN = join(HERE, "probe-plugin");
const OPENCODE = process.env.LTD_OPENCODE ?? "opencode";
export const MODEL = "github-copilot/claude-haiku-5.5";

export const openCodeVersion = () => spawnSync(OPENCODE, ["--version"], { encoding: "utf8", timeout: 20000 }).stdout.trim();

const DEFAULT_CAPS = { planned: 4, total: 6 };
/** The caps of a root: caps.json when the campaign wrote one, else 4 planned and 6 in all. */
export function capsOf(root) {
  try {
    const caps = JSON.parse(readFileSync(join(root, "caps.json"), "utf8"));
    if (Number.isInteger(caps.planned) && Number.isInteger(caps.total) && caps.planned > 0 && caps.total >= caps.planned) return caps;
  } catch {
    // No file, or not valid: the defaults.
  }
  return DEFAULT_CAPS;
}

/**
 * Session accounting: one line per start and per finish; refuses a start past the cap. A session that made no model request at all
 * (an infrastructure failure before the model was reached) is voided with a reason and does not count toward either cap; the void
 * line stays in the ledger and the report lists it.
 */
export function ledgerStart(root, { id, kind, scenario, arm, run }) {
  const file = join(root, "ledger.tsv");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  // A void line cancels the starts of the same id written before it, so an id can be used again after a voided attempt.
  const voidTimes = lines.filter((l) => l[2] === "void").map((l) => [l[1], l[0]]);
  const started = lines.filter((l) => l[2] === "started" && !voidTimes.some(([id, at]) => id === l[1] && at >= l[0]));
  const planned = started.filter((l) => l[3] === "planned").length;
  const caps = capsOf(root);
  if (started.length >= caps.total) throw new Error(`cap reached: ${started.length} of ${caps.total} sessions already started`);
  if (kind === "planned" && planned >= caps.planned) throw new Error(`cap reached: ${planned} of ${caps.planned} planned sessions already started`);
  appendFileSync(file, `${new Date().toISOString()}\t${id}\tstarted\t${kind}\t${scenario}\t${arm}\t${run}\n`);
}
export const ledgerFinish = (root, id, status) => appendFileSync(join(root, "ledger.tsv"), `${new Date().toISOString()}\t${id}\t${status}\n`);
export const ledgerVoid = (root, id, reason) => appendFileSync(join(root, "ledger.tsv"), `${new Date().toISOString()}\t${id}\tvoid\t${reason}\n`);

/** Reads the stored messages of a session database as parsed JSON, in order. */
export function readMessages(dbPath) {
  const out = spawnSync("sqlite3", ["-readonly", dbPath, "select type || char(9) || data from session_message order by seq;"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`cannot read the session database: ${out.stderr.slice(0, 200)}`);
  return out.stdout.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { type: line.slice(0, tab), data: JSON.parse(line.slice(tab + 1)) };
  });
}

const field = (text, name) => text.match(new RegExp(`^\\s*[*_]{0,2}${name}[*_]{0,2}:[*_]{0,2}\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;

/** What the model did, from the stored messages. Pure. */
export function summarizeMessages(messages, skillId = "logic-test-debug") {
  const assistant = messages.filter((m) => m.type === "assistant");
  const items = assistant.flatMap((m) => m.data.content ?? []);
  const tools = items.filter((c) => c.type === "tool").map((c) => ({ name: c.name, status: c.state?.status ?? null, errorType: c.state?.error?.type ?? null, errorMessage: c.state?.error?.message ?? "", input: c.state?.input ?? null }));
  const texts = items.filter((c) => c.type === "text").map((c) => c.text);
  const finalText = (assistant.at(-1)?.data.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const all = texts.join("\n");
  const record = { scope: field(all, "Scope"), method: field(all, "Method"), result: field(all, "Result") };
  const sum = (pick) => assistant.reduce((n, m) => n + (pick(m.data) ?? 0), 0);
  return {
    assistantMessages: assistant.length,
    toolCalls: tools.map((t) => t.name),
    skillLoaded: tools.some((t) => t.name === "skill" && t.status === "completed" && t.input?.id === skillId),
    skillAttempts: tools.filter((t) => t.name === "skill").length,
    rejected: tools.filter((t) => t.errorType === "permission.rejected").map((t) => ({ name: t.name })),
    // A call of a tool the session is not offered (shell, web ...). Ordinary failures of a tool that exists (a text to replace that is not found) are in toolErrors.
    unavailable: tools.filter((t) => /No tool named/.test(t.errorMessage)).map((t) => t.name),
    toolErrors: tools.filter((t) => t.errorType === "tool.execution" && !/No tool named/.test(t.errorMessage)).map((t) => t.name),
    record: { ...record, present: Boolean(record.scope && record.method && record.result) },
    finalText,
    finished: assistant.at(-1)?.data.finish ?? null,
    tokens: { input: sum((d) => d.tokens?.input), output: sum((d) => d.tokens?.output), reasoning: sum((d) => d.tokens?.reasoning) },
    cost: sum((d) => d.cost),
  };
}

/** The probe plugin's log: how many main-agent model requests there were and in how many the directive was present. Pure. */
export function summarizeProbe(logText) {
  const rows = logText.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.at === "context" && r.agent !== "jev-locator");
  return { modelRequests: rows.length, withDirective: rows.filter((r) => r.directive).length, firstHasDirective: rows[0]?.directive === true };
}

/** Imports the user's GitHub Copilot credential into a template data folder through a pipe; the secret is never printed or held here. */
export function prepareCredentials(root) {
  const template = join(root, "cred-template");
  rmSync(template, { recursive: true, force: true });
  for (const name of ["config/opencode", "data", "cache", "state", "tmp"]) mkdirSync(join(template, name), { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: join(template, "config"), XDG_DATA_HOME: join(template, "data"), XDG_CACHE_HOME: join(template, "cache"), XDG_STATE_HOME: join(template, "state"), TMPDIR: join(template, "tmp") };
  const exported = spawnSync(OPENCODE, ["auth", "export", "--standalone", "GitHub Copilot"], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  if (exported.status !== 0 || !exported.stdout.trim()) throw new Error(`credential export failed (status ${exported.status})`);
  const imported = spawnSync(OPENCODE, ["auth", "import", "--standalone"], { env, input: exported.stdout, encoding: "utf8", timeout: 60000 });
  if (imported.status !== 0) throw new Error(`credential import failed (status ${imported.status})`);
  // The model catalogue is kept in the database (key models-dev:catalog) and is loaded in the background on first start; a session that
  // starts right away finds no model ("Model unavailable"). The catalogue is public; copy it from the user's own database, read-only.
  const userDb = join(process.env.HOME, ".local/share/opencode/opencode.db");
  const seeded = spawnSync("sqlite3", [join(template, "data/opencode/opencode.db"), `ATTACH 'file:${userDb}?mode=ro' AS u; INSERT OR REPLACE INTO kv SELECT * FROM u.kv WHERE key='models-dev:catalog'; DETACH u;`], { encoding: "utf8", timeout: 60000 });
  if (seeded.status !== 0) throw new Error(`catalogue copy failed: ${seeded.stderr.slice(0, 200)}`);
  return template;
}
export const removeCredentials = (root) => rmSync(join(root, "cred-template"), { recursive: true, force: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Polls the server's model list until it names the model. True when it does within the time. */
async function waitForModel({ url, env, model, cwd, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const out = spawnSync(OPENCODE, ["models", "--server", url], { cwd, env, encoding: "utf8", timeout: 20000 });
    if ((out.stdout ?? "").split("\n").includes(model)) return true;
  }
  return false;
}

// The oracles of `combos` and `trace` run code the agent wrote (its tests, its modules) with the evaluator's rights, and no sandbox
// holds them here. Before they run, the files the agent changed or added are scanned for imports and calls that reach outside a
// pure function; a hit skips the oracle (the session counts as not demonstrated and says why) instead of running the code.
const RISKY = /\b(?:child_process|worker_threads|cluster|dgram|inspector|repl|vm)\b|\bnode:(?:net|http|https|http2|dns|tls|fs|fs\/promises)\b|from\s+["'](?:fs|fs\/promises|net|http|https|dns|tls)["']|require\s*\(\s*["'](?:fs|net|http|https|dns|tls)["']|\bprocess\.(?:binding|dlopen|kill|chdir|env)\b|\bfetch\s*\(|\bimport\s*\(\s*(?!["']\.{1,2}\/)/;
export function scanAgentCode(workspace, scenario) {
  if (scenario !== "combos" && scenario !== "trace") return [];
  const { changed, added } = changedFiles(workspace, scenario);
  const hits = [];
  for (const name of [...changed, ...added].filter((n) => /\.(?:m?js|cjs)$/.test(n))) {
    const text = readFileSync(join(workspace, name), "utf8");
    const match = text.match(RISKY);
    if (match) hits.push(`${name}: ${match[0].trim().slice(0, 40)}`);
  }
  return hits;
}

const TEST_FILE = { conditions: "test/access.test.mjs", combos: "test/pricing.test.mjs", trace: "test/route.test.mjs" };
const TOTALS = { conditions: 136, combos: 13, trace: 47 };

/** The score used for the hard tasks: combos counts the faulty versions the agent's tests catch, only when both clean versions pass (as in lib/report.mjs). */
export function oracleScore(scenario, oracle) {
  if (scenario === "combos") return oracle.clean?.correct && oracle.clean?.equivalent ? (oracle.killed ?? []).length : 0;
  return oracle.passed ?? 0;
}

export function realConfig({ pluginDirs, model = MODEL }) {
  return {
    plugin: pluginDirs,
    mcp: { servers: { jev: { type: "local", command: ["node", "-e", "setTimeout(()=>{},1000)"] } } },
    model,
    small_model: model,
    permission: CONFINED_PERMISSION,
    autoupdate: false,
    share: "disabled",
  };
}

/**
 * Runs one planned or reserve session. arm "ON": plugin as shipped. arm "OFF": the same plugin with APANA_LOGIC_TEST_DEBUG=off.
 * Returns the verdict (also written to runs/<id>/verdict.json).
 */
export async function runReal({ root, id, kind, scenario, arm, run, prompt, pluginDir, timeoutMs = Number(process.env.LTD_OC_SESSION_TIMEOUT_MS) || 600000, model = MODEL }) {
  const version = openCodeVersion();
  if (!confinementProven(root, version)) throw new Error("no valid confinement proof for this permission set and OpenCode version: run the probe first");
  if (!existsSync(join(root, "cred-template"))) throw new Error("credentials not prepared");
  ledgerStart(root, { id, kind, scenario, arm, run });
  const dir = join(root, "runs", id);
  rmSync(dir, { recursive: true, force: true });
  for (const name of ["config/opencode", "cache", "state", "tmp", "wsparent"]) mkdirSync(join(dir, name), { recursive: true });
  cpSync(join(root, "cred-template", "data"), join(dir, "data"), { recursive: true });
  const workspace = createWorkspace(scenario, join(dir, "wsparent"));
  const probeLog = join(dir, "probe.jsonl");
  const { LOGIC_DIRECTIVE } = await import(pathToFileURL(join(pluginDir, "private/logic-test-debug/check.mjs")).href);
  writeFileSync(join(dir, "config/opencode/opencode.jsonc"), JSON.stringify(realConfig({ pluginDirs: [pluginDir, PROBE_PLUGIN], model }), null, 2));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_STATE_HOME: join(dir, "state"),
    TMPDIR: join(dir, "tmp"),
    PROBE_LOG: probeLog,
    PROBE_DIRECTIVE: LOGIC_DIRECTIVE,
    ...(arm === "OFF" ? { APANA_LOGIC_TEST_DEBUG: "off" } : {}),
  };
  const started = Date.now();
  // A server of its own, started first and given time to learn its models: with `run --standalone` the run starts at once, and on
  // OpenCode 2.0.22 the GitHub Copilot models arrive a few seconds after boot ("Model unavailable", or a default endpoint that answers 404).
  env.OPENCODE_SERVER_PASSWORD = randomBytes(12).toString("hex");
  env.PROBE_PROVIDERS = model.split("/")[0];
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(OPENCODE, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  server.stdout.on("data", (c) => (output += "[server] " + String(c).replace(/server password \S+/g, "server password <hidden>")));
  server.stderr.on("data", (c) => (output += "[server] " + c));
  const killGroup = (child) => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  const ready = await waitForModel({ url, env, model, cwd: workspace, timeoutMs: 90000 });
  let exit = null;
  let timedOut = false;
  if (ready) {
    const child = spawn(OPENCODE, ["run", "--server", url, "-m", model, prompt], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    exit = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
    clearTimeout(timer);
    killGroup(child);
  } else {
    output += `model ${model} never appeared in the server's model list\n`;
  }
  killGroup(server);
  writeFileSync(join(dir, "output.txt"), output.slice(0, 200000));
  let messages = [];
  let readError = null;
  try {
    messages = readMessages(join(dir, "data/opencode/opencode.db"));
  } catch (error) {
    readError = String(error.message).slice(0, 200);
  }
  const session = summarizeMessages(messages);
  const probe = existsSync(probeLog) ? summarizeProbe(readFileSync(probeLog, "utf8")) : { modelRequests: 0, withDirective: 0, firstHasDirective: false };
  const risky = scanAgentCode(workspace, scenario);
  const oracle = risky.length
    ? { scenario, oracle: { total: TOTALS[scenario], passed: 0, failures: [`oracle not run: the agent's code uses ${risky.join("; ")}`], skipped: true }, files: changedFiles(workspace, scenario), scored: false, safe: false, success: false }
    : evaluateRun(scenario, workspace);
  const testPath = TEST_FILE[scenario] ? join(workspace, TEST_FILE[scenario]) : null;
  const behaviour = behaviourFrom({ verdict: { scenario: scenario === "conditions" ? "conditions" : scenario, evaluation: { files: oracle.files } }, finalText: session.finalText, testSource: testPath && existsSync(testPath) ? readFileSync(testPath, "utf8") : null });
  const complete = exit === 0 && !timedOut && session.finished === "stop";
  // Voided: the model was never reached, or the provider answered with an error and the model produced nothing (no text, no tool call).
  const voided = (probe.modelRequests === 0 && session.assistantMessages === 0) || (session.assistantMessages <= 1 && session.toolCalls.length === 0 && session.finalText === "" && session.finished === "error");
  if (voided) ledgerVoid(root, id, `no model request (exit ${exit}): ${output.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n")[0].slice(0, 160)}`);
  const verdict = { id, kind, scenario, arm, run, model, version, exit, timedOut, complete, voided, seconds: Math.round((Date.now() - started) / 1000), readError, session: { ...session, finalText: session.finalText.slice(0, 1500) }, probe, oracle: { passed: oracle.oracle.passed, total: oracle.oracle.total, success: oracle.success, safe: oracle.safe, skipped: oracle.oracle.skipped === true, score: oracleScore(scenario, oracle.oracle), killed: oracle.oracle.killed ?? null, survived: oracle.oracle.survived ?? null, clean: oracle.oracle.clean ?? null, failures: (oracle.oracle.failures ?? []).slice(0, 5), outOfScope: oracle.files.outOfScope }, behaviour, workspace };
  writeFileSync(join(dir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  if (!voided) ledgerFinish(root, id, complete ? "complete" : "incomplete");
  return verdict;
}
