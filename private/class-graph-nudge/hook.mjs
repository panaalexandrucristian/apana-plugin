// class-graph nudge, Claude Code adapter. With the class-graph mode switched on for a session (a bare /apana:class-graph),
// it keeps the skill in view: a one-line reminder on each later prompt and, when a Bash command is a plain text search
// for a project class or member name (the Bash tool or the Grep tool), one note that names the class-graph command to run instead. It only adds context:
// it never blocks, never changes a command, never calls a model, and a failure is the caller's to isolate
// (scripts/apana-hook.mjs loads this module by a guarded dynamic import, like logic-test-debug).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCommand, classifyGrepInput, isBareCommand } from "./classify.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MODE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_NUDGES = 3;

/**
 * APANA_CLASS_GRAPH_NUDGE is the legacy override; otherwise CLAUDE_PLUGIN_OPTION_CLASS_GRAPH_NUDGE is read.
 * Absent, "on" or "both" = reminder and nudge; "a"/"nudge-only" = nudge only;
 * "b"/"reminder-only" = reminder only; any other value = off.
 * The mode itself (the bare slash) is always recorded, so the parts can be switched without losing it.
 */
export function nudgeParts(env) {
  const legacy = env?.APANA_CLASS_GRAPH_NUDGE;
  const raw = legacy ?? env?.CLAUDE_PLUGIN_OPTION_CLASS_GRAPH_NUDGE;
  if (raw === undefined) return { reminder: true, nudge: true };
  const value = String(raw).trim().toLowerCase();
  if (["on", "1", "true", "ab", "both"].includes(value)) return { reminder: true, nudge: true };
  if (value === "a" || value === "nudge-only") return { reminder: false, nudge: true };
  if (value === "b" || value === "reminder-only") return { reminder: true, nudge: false };
  return { reminder: false, nudge: false };
}

const stateDir = (env) => env?.APANA_CLASS_GRAPH_STATE_DIR || join(homedir(), ".cache", "class-graph-mode");
const keyOf = (sessionId) => createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 24);
const hasSession = (id) => typeof id === "string" && id.length > 0;

function readState(env, sessionId, now = Date.now()) {
  try {
    const file = join(stateDir(env), `${keyOf(sessionId)}.json`);
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (!state?.on || typeof state.at !== "number" || now - state.at > MODE_TTL_MS) return null;
    return { file, state };
  } catch {
    return null;
  }
}

function writeState(env, sessionId, state) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${keyOf(sessionId)}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`);
  renameSync(temp, file);
  pruneOld(dir, state.at);
}

/** Remove mode files older than two TTLs (at most 200 entries looked at), so the folder does not grow. */
function pruneOld(dir, now) {
  try {
    for (const name of readdirSync(dir).slice(0, 200)) {
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > 2 * MODE_TTL_MS) unlinkSync(path);
    }
  } catch {
    // best effort
  }
}

const scriptsDir = () => join(PLUGIN_ROOT, "skills", "class-graph", "scripts");
const quote = (text) => (/^[A-Za-z0-9_./:@%+=,~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

/** The one-line reminder added to each prompt while the mode is on. */
export function reminderText() {
  return (
    "class-graph is ON for this session: for who uses/calls/depends on a project class or member, and for where a Kotlin function " +
    `starts and ends, run the scripts in ${scriptsDir()}/ (class-graph.mjs, find-usages.mjs, find-def.mjs) instead of rg/grep/sed, ` +
    "with --root = the tree you edit (your worktree), not another session's checkout. Literal text, resource ids and a known line range stay with rg/Read."
  );
}

/**
 * The project root to pass as --root: the nearest folder holding a Gradle settings file or a .git entry above the first
 * absolute (or cd-relative) search path, else above the session cwd, else that folder itself.
 */
export function guessRoot(found, cwd) {
  const bases = [];
  const abs = (p) => (typeof p === "string" && p ? resolve(found.cd ? resolve(cwd ?? "/", found.cd) : (cwd ?? "/"), p) : null);
  for (const p of found.paths ?? []) if (/^[~$]/.test(p) === false) bases.push(abs(p));
  if (found.cd) bases.push(resolve(cwd ?? "/", found.cd));
  if (cwd) bases.push(cwd);
  for (const base of bases.filter(Boolean)) {
    let dir = base;
    for (let depth = 0; depth < 12; depth += 1) {
      if (existsSync(join(dir, "settings.gradle.kts")) || existsSync(join(dir, "settings.gradle")) || existsSync(join(dir, ".git"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const first = bases.find(Boolean);
  if (first && existsSync(first)) {
    try {
      return statSync(first).isDirectory() ? first : dirname(first);
    } catch {
      return first;
    }
  }
  return null;
}

/** The note added to a Bash or Grep call that looks up the users of a class or member. */
export function nudgeText(found, root) {
  const r = root ? quote(root) : "<project root>";
  const name = found.names[0];
  const rest = found.names.slice(1);
  const others = rest.length ? ` (and ${rest.slice(0, 2).join(", ")}${rest.length > 2 ? `, +${rest.length - 2} more` : ""})` : "";
  const command =
    found.kind === "member"
      ? `node ${scriptsDir()}/find-usages.mjs <File.kt that declares ${name}> ${name} --root ${r} --max-hits 200 | head -n 80`
      : `node ${scriptsDir()}/class-graph.mjs ${name} --root ${r} --up 1 --down 0`;
  return (
    `class-graph is ON: this search looks for the users of ${name}${others}. If the question is who uses/calls/depends on it ` +
    `(not a rename, not literal text), run ${command} instead, once per name; --root must be the tree you edit, not another session's checkout. ` +
    "Otherwise ignore this note."
  );
}

const asContext = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

/** The output for one hook call, or null. */
export function handleNudgeHook(event, input, env = process.env, now = Date.now()) {
  if (event !== "UserPromptSubmit" && event !== "PreToolUse") return null;
  if (!hasSession(input?.session_id)) return null;
  const parts = nudgeParts(env);
  if (event === "UserPromptSubmit") {
    const prompt = input?.prompt;
    if (typeof prompt !== "string") return null;
    if (isBareCommand(prompt)) {
      writeState(env, input.session_id, { on: true, at: now, nudges: 0, names: [] });
      return null;
    }
    if (!parts.reminder) return null;
    if (/^\s*[</]/.test(prompt) || !prompt.trim()) return null; // another command, or a tool/session notification
    return readState(env, input.session_id, now) ? asContext(event, reminderText()) : null;
  }
  const tool = input?.tool_name;
  if (!parts.nudge || (tool !== "Bash" && tool !== "Grep")) return null;
  const found = tool === "Bash" ? classifyCommand(input?.tool_input?.command) : classifyGrepInput(input?.tool_input);
  if (!found) return null;
  const current = readState(env, input.session_id, now);
  if (!current) return null;
  const { state } = current;
  if ((state.nudges ?? 0) >= MAX_NUDGES) return null;
  if (found.names.every((n) => (state.names ?? []).includes(n))) return null;
  writeState(env, input.session_id, { ...state, nudges: (state.nudges ?? 0) + 1, names: [...new Set([...(state.names ?? []), ...found.names])], at: state.at });
  return asContext(event, nudgeText(found, guessRoot(found, input?.cwd)));
}

/**
 * Add a nudge output to what the other subsystems produced, without mutating it. An existing output of another event, one
 * that decides a permission (the nudge must never sit next to a deny) or one that is not a plain object is returned unchanged.
 */
export function composeNudge(existing, added) {
  if (!added) return existing ?? null;
  if (existing == null) return added;
  if (typeof existing !== "object" || Array.isArray(existing)) return existing;
  const event = added.hookSpecificOutput.hookEventName;
  const specific = existing.hookSpecificOutput;
  if (specific != null && (typeof specific !== "object" || Array.isArray(specific))) return existing;
  if (specific?.hookEventName !== undefined && specific.hookEventName !== event) return existing;
  if (specific?.permissionDecision !== undefined && specific.permissionDecision !== "allow") return existing;
  const previous = specific?.additionalContext;
  if (previous !== undefined && typeof previous !== "string") return existing;
  const text = added.hookSpecificOutput.additionalContext;
  return { ...existing, hookSpecificOutput: { ...(specific ?? {}), hookEventName: event, additionalContext: previous ? `${previous}\n${text}` : text } };
}
