// The logic of update-sessions that has no effects: which processes are Claude Code sessions, what the registry says about them, whether the prompt box on a screen is empty,
// and whether a typed /reload-plugins ran. The only I/O is readRegistry. The shapes it matches are the ones measured on real data (see the fixtures of the tests).
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const WINDOW = 25;
const COMMAND = "/reload-plugins";
const isRule = (line) => /^\s*──/.test(line);
const isBlank = (line) => /^\s*$/.test(line); // \s includes U+00A0, which Claude Code prints after an empty prompt sign

/** The processes of `ps -axo pid,ppid,tty,command` that are Claude Code sessions with a terminal: basename of argv[0] is exactly `claude`. The tty is named as iTerm2 names it (/dev/ttys000). */
export function parsePs(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(line);
    if (!m || m[3] === "??" || basename(m[4]) !== "claude") continue;
    found.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: `/dev/${m[3]}` });
  }
  return found;
}

/** pid -> the parsed ~/.claude/sessions/<pid>.json (status, name, sessionId, …). The <pid>.<64 hex>.key files are not read; a missing folder or a file being rewritten leaves the pid out. */
export function readRegistry(dir) {
  const registry = new Map();
  let names = [];
  try { names = readdirSync(dir); } catch { return registry; }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try { registry.set(parseInt(name, 10), JSON.parse(readFileSync(join(dir, name), "utf8"))); } catch { /* gone or half written: unknown */ }
  }
  return registry;
}

const linesOf = (text) => {
  const lines = text.replace(ANSI, "").split("\n");
  while (lines.length > 0 && isBlank(lines.at(-1))) lines.pop(); // iTerm2 pads blank rows below the screen
  return lines;
};

/** The live prompt box: the last ❯ row of the last 25 lines that has a ── rule directly above it and another ── rule below its continuation rows. An echo or a menu row has no rule above. */
function findBox(lines) {
  for (let i = lines.length - 1; i >= Math.max(1, lines.length - WINDOW); i -= 1) {
    if (!/^\s*❯/.test(lines[i]) || !isRule(lines[i - 1])) continue;
    const bottom = lines.findIndex((line, j) => j > i && isRule(line));
    if (bottom !== -1) return { top: i - 1, prompt: i, bottom };
  }
  return null;
}

/** { state: "empty" | "text" | "unknown", reason? } for the prompt of a screen. Empty = nothing after ❯ and nothing on its continuation rows (a prompt that began with Shift+Enter). */
export function classifyScreen(text) {
  const lines = linesOf(text);
  const box = findBox(lines);
  if (!box) return { state: "unknown", reason: `no prompt box on screen (a menu or dialog is open?): close it, then type ${COMMAND}` };
  const empty = /^\s*❯\s*$/.test(lines[box.prompt]) && lines.slice(box.prompt + 1, box.bottom).every(isBlank);
  return { state: empty ? "empty" : "text" };
}

/** The checks that need no screen. `entry` = registry entry or undefined, `matches` = how many iTerm2 sessions have the tty. The invoking session is busy by definition, so its status is not asked. */
export function gateBeforeScreen({ entry, matches, isSelf }) {
  if (!entry) return { ok: false, reason: `no registry file for this process (too new, or gone): type ${COMMAND} in it by hand` };
  if (matches === 0) return { ok: false, reason: `not an iTerm2 session: type ${COMMAND} in it by hand` };
  if (matches > 1) return { ok: false, reason: `its tty is listed by ${matches} iTerm2 sessions: type ${COMMAND} in the right one by hand` };
  if (isSelf || entry.status === "idle") return { ok: true };
  if (entry.status === "busy") return { ok: false, reason: `busy: type ${COMMAND} when it is idle` };
  if (entry.status === "waiting") return { ok: false, reason: `waiting for your answer in the session: answer there, then type ${COMMAND}` };
  return { ok: false, reason: `status "${entry.status}": type ${COMMAND} when it is idle` };
}

const aboveBox = (text) => {
  const lines = linesOf(text);
  const box = findBox(lines);
  if (!box) return null;
  const above = lines.slice(0, box.top);
  while (above.length > 0 && isBlank(above.at(-1))) above.pop();
  return above;
};

const countOf = (line, noun) => { const m = new RegExp(`(\\d+) ${noun}s?\\b`).exec(line); return m ? Number(m[1]) : null; };

/**
 * Did the /reload-plugins typed between the screens `before` and `after` run? Yes when the text above the live box changed and now ends with the echo of the command followed by
 * a `⎿ Reloaded: …` line (an old pair that was already there does not count). Returns { confirmed: false } or { confirmed: true, status, counts, line, notes }:
 * status "reloaded" | "warning" (errors during load, dependencies resolved) | "held" (an MCP change held back, needs --force); counts is null when the numbers are in a format not known.
 */
export function confirmReload(before, after) {
  const now = aboveBox(after);
  if (!now) return { confirmed: false };
  const was = aboveBox(before);
  if (was && was.length === now.length && was.every((line, i) => line === now[i])) return { confirmed: false };
  const echo = now.findLastIndex((line) => new RegExp(`^\\s*❯\\s+${COMMAND}\\s*$`).test(line));
  if (echo === -1) return { confirmed: false };
  const block = now.slice(echo + 1).filter((line) => !isBlank(line));
  const first = /^\s*⎿\s+(Reloaded:.*?)\s*$/.exec(block[0] ?? "");
  if (!first) return { confirmed: false };
  const line = first[1];
  const notes = block.slice(1).map((note) => note.replace(/^\s*⎿\s*/, "").trim());
  const counts = Object.fromEntries(["plugin", "skill", "agent", "hook"].map((noun) => [`${noun}s`, countOf(line, noun)]));
  const all = [line, ...notes];
  const status = all.some((text) => /--force|changes MCP tools/i.test(text)) ? "held" : all.some((text) => /errors? during load|dependenc/i.test(text)) ? "warning" : "reloaded";
  return { confirmed: true, status, counts: Object.values(counts).every((n) => n !== null) ? counts : null, line, notes };
}
