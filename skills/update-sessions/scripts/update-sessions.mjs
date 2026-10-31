// update-sessions: updates the apana plugin on disk, then types /reload-plugins into every idle Claude Code session of iTerm2 whose prompt is empty and checks that each one reloaded.
// Usage: node update-sessions.mjs [--self <sessionId>] [--dry-run]. Exit 0 = all reloaded or queued, 2 = bad arguments, 3 = some session not reloaded, 4 = the update on disk failed, 5 = iTerm2 cannot be read.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ItermError, createIterm, runOsascript } from "./iterm.mjs";
import { classifyScreen, confirmReload, gateBeforeScreen, parsePs, readRegistry } from "./sessions.mjs";

const PLUGIN = "apana@apana-private";
const MARKETPLACE = "apana-private";
const COMMAND = "/reload-plugins";
const USAGE = "usage: node update-sessions.mjs [--self <sessionId>] [--dry-run]";
const CONFIRM_MS = 20000; // assumed; to be tuned on the live smoke test
const POLL_MS = 1000;

const SELF_RESULT = "this session: runs right after this reply";
const TEXT_IN_PROMPT = `prompt has text: send or clear it, then type ${COMMAND}`;

function parseArgs(argv) {
  const options = { self: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--self" && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) { options.self = argv[i + 1]; i += 1; }
    else return null;
  }
  return options;
}

function updateOnDisk(deps) {
  for (const args of [["plugin", "marketplace", "update", MARKETPLACE], ["plugin", "update", PLUGIN]]) {
    const r = deps.runCmd("claude", args, { cwd: deps.home });
    if (r.status !== 0) return `claude ${args.join(" ")} failed (exit ${r.status}): ${String(r.error?.message || r.stderr || r.stdout || "no output").trim()}`;
  }
  return null;
}

const countsText = (c) => `Reloaded: ${c.plugins} plugins · ${c.skills} skills · ${c.agents} agents · ${c.hooks} hooks`;

/** One row { name, tty, state, result, done } for a session; types into it unless dryRun. `done` = counts as handled (exit 0). */
async function handle(proc, ctx, isSelf) {
  const { deps, options, registry, itermSessions } = ctx;
  const entry = registry.get(proc.pid);
  const row = { name: entry?.name ?? `pid ${proc.pid}`, tty: proc.tty.replace("/dev/", ""), done: false };
  const gate = gateBeforeScreen({ entry, matches: itermSessions.filter((s) => s.tty === proc.tty).length, isSelf });
  if (!gate.ok) return { ...row, state: "skipped", result: gate.reason };
  try {
    const before = deps.iterm.read(proc.tty);
    const screen = classifyScreen(before);
    if (screen.state !== "empty") return { ...row, state: "skipped", result: screen.state === "text" ? TEXT_IN_PROMPT : screen.reason };
    if (options.dryRun) return { ...row, state: isSelf ? "would queue" : "would reload", result: isSelf ? SELF_RESULT : "idle, prompt empty", done: true };
    deps.iterm.write(proc.tty, COMMAND);
    if (isSelf) return { ...row, state: "queued", result: SELF_RESULT, done: true };
    const deadline = deps.now() + CONFIRM_MS;
    do {
      await deps.sleep(POLL_MS);
      const c = confirmReload(before, deps.iterm.read(proc.tty));
      if (!c.confirmed) continue;
      if (c.status === "held") return { ...row, state: "held", result: `an MCP change was held back: type ${COMMAND} --force in that session to apply it` };
      const shown = c.counts ? countsText(c.counts) : c.line;
      return { ...row, state: c.status, result: [shown, ...(c.status === "warning" ? c.notes : [])].join(" | "), done: true };
    } while (deps.now() < deadline);
    return { ...row, state: "typed, not confirmed", result: `the session got the command but no Reloaded: line appeared in ${CONFIRM_MS / 1000} s: look at it, or type ${COMMAND} again` };
  } catch (error) {
    if (!(error instanceof ItermError)) throw error;
    return { ...row, state: "failed", result: `iTerm2: ${error.message.replace(/\s+/g, " ")}: look at that session, it may or may not have got the command; type ${COMMAND} if it did not reload` };
  }
}

function table(rows) {
  const cells = [{ name: "session", tty: "tty", state: "state", result: "result" }, ...rows];
  const width = (key) => Math.max(...cells.map((r) => r[key].length));
  const [w1, w2, w3] = ["name", "tty", "state"].map(width);
  return cells.map((r) => `${r.name.padEnd(w1)}  ${r.tty.padEnd(w2)}  ${r.state.padEnd(w3)}  ${r.result}`).join("\n");
}

/** The whole command with its machine in `deps`; returns { code, text }. */
export async function main(argv, deps) {
  const options = parseArgs(argv);
  if (!options) return { code: 2, text: USAGE };
  const before = deps.installed()?.version ?? null;
  let header;
  if (options.dryRun) header = `apana: ${before ?? "not installed"} on disk (dry run: no update)`;
  else {
    const failure = updateOnDisk(deps);
    if (failure) return { code: 4, text: failure };
    const after = deps.installed()?.version;
    if (!after) return { code: 4, text: `${PLUGIN} is not in installed_plugins.json after the update` };
    header = after === before ? `apana: ${after} (unchanged)` : `apana: ${before ?? "not installed"} -> ${after}`;
  }
  let itermSessions;
  try { itermSessions = deps.iterm.sessions(); } catch (error) {
    if (error instanceof ItermError) return { code: 5, text: `${header}\n${error.message}` };
    throw error;
  }
  const registry = deps.registry();
  const ctx = { deps, options, registry, itermSessions };
  const procs = parsePs(deps.psText());
  const isSelf = (proc) => options.self !== null && registry.get(proc.pid)?.sessionId === options.self;
  const ordered = [...procs.filter((p) => !isSelf(p)), ...procs.filter(isSelf)];
  const rows = [];
  for (const proc of ordered) rows.push(await handle(proc, ctx, isSelf(proc)));
  const lines = [header, "", table(rows)];
  if (procs.length === 0) lines.push("no Claude Code session with a terminal is running");
  return { code: rows.every((r) => r.done) ? 0 : 3, text: lines.join("\n") };
}

function realDeps() {
  const home = homedir();
  return {
    home,
    runCmd: (cmd, args, { cwd }) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 180000 }),
    installed: () => {
      try { return JSON.parse(readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8")).plugins?.[PLUGIN]?.[0] ?? null; } catch { return null; }
    },
    psText: () => spawnSync("ps", ["-axo", "pid,ppid,tty,command"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).stdout ?? "",
    registry: () => readRegistry(join(home, ".claude/sessions")),
    iterm: createIterm(runOsascript),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, text } = await main(process.argv.slice(2), realDeps());
  process.stdout.write(`${text}\n`);
  process.exitCode = code;
}
