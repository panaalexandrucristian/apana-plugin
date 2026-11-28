// The modes of apana on OpenCode: the Jev decision loop (one Jev decision per tool call) and the
// class-graph reminders. The logic is the one Claude Code runs (jev-decision-loop/gate-hook.mjs,
// class-graph-nudge/hook.mjs); this file only connects it to OpenCode's hooks.
//
// Admission is not execution. The `prompt` hook may run more than once for one prompt, and for a prompt that is never admitted,
// so it only writes the intent into the message's metadata (a pure function of the text, see intents.mjs). The modes are
// switched on from the `context` hook, which sees the admitted messages: a cursor per session remembers the latest user message
// already handled, so each message is handled once, a forked session does not inherit the modes of the history it copied, and a
// failed or concurrent preparation changes nothing. Gates only restrict: they never grant what OpenCode's permissions deny.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { handleNudgeHook } from "../class-graph-nudge/hook.mjs";
import { splitSegments } from "../class-graph-nudge/classify.mjs";
import { extractPromptText } from "../logic-test-debug/opencode.mjs";
import { handle as jevGate, jevCall, loopOff, loopReset } from "../../skills/jev-decision-loop/scripts/gate-hook.mjs";
import { ROOT } from "./catalog.mjs";
import { deriveIntent, storedIntent } from "./intents.mjs";

const JEV_SCRIPT = join(ROOT, "skills", "jev-decision-loop", "scripts", "jev.mjs");
// The only variables a command may set in front of jev.mjs (the skill documents JEV_MODEL); anything else is not a Jev call.
const SAFE_JEV_ENV = /^(?:JEV_MODEL|JEV_PROVIDER)=[A-Za-z0-9_./:@-]+$/;
const GATE_NAMES = { read: "Read", grep: "Grep", glob: "Glob", question: "AskUserQuestion", edit: "Edit", write: "Write", shell: "Bash", subagent: "Agent" };
const SKILL_OF = { jev: "jev-decision-loop", "class-graph": "class-graph" };
const MAX_NOTES = 8;
// This scope-related note was stored against a Jev message, not a scope message.
const LEGACY_JEV_SCOPE_NOTE = "Apana: the Jev decision loop cannot start while scope is on in this session; the two gates would block each other. Nothing was changed. Use another session for Jev (scope has no off switch).";

export const TEXT = {
  jevOn: "Apana: the Jev decision loop is on. Every tool call needs a fresh Jev decision (`GO`), Code Mode (`execute`) is refused, and `jev.mjs --off` ends the mode.",
  notOwned: (kind) => `Apana: the skill id "${SKILL_OF[kind]}" is used by another source in this session, so the Apana ${kind} mode was not started.`,
  jevCode: "Apana: the Jev decision loop is on and one decision covers one call, so Code Mode (`execute`) is refused. Use the direct tools.",
};

/** A name for the file-based state of the shared modules (they want a UUID v4); derived from the session id, never shared with Claude. */
export function localID(id) {
  if (typeof id !== "string" || !id || id.length > 256) throw new Error("invalid session id");
  const h = createHash("sha256").update(`opencode:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The environment the shared modules read: state under OpenCode's state folder, and no Claude Code plugin option. */
export function adapterEnv(env = process.env) {
  const home = join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "apana");
  const out = {
    ...env,
    APANA_CLASS_GRAPH_STATE_DIR: env.APANA_CLASS_GRAPH_STATE_DIR || join(home, "class-graph"),
    JEV_GATE_DIR: env.JEV_GATE_DIR || join(home, "jev"),
  };
  delete out.CLAUDE_PLUGIN_OPTION_CLASS_GRAPH_NUDGE;
  return out;
}

const textOf = (result) => {
  if (typeof result === "string") return result;
  const parts = Array.isArray(result?.content) ? result.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text) : [];
  if (typeof result?.output === "string") parts.push(result.output);
  return parts.join("\n");
};

/** The jev.mjs of this plugin called as the skill says: `[JEV_MODEL=x] node <this plugin's jev.mjs> [flag | <<EOF ... EOF]`. */
export function isOwnJevCall(command, cwd) {
  if (typeof command !== "string" || !jevCall(command)) return false;
  const line = command.split("\n")[0];
  if (/[`]|\$[({]/.test(line.replace(JEV_SCRIPT, ""))) return false;
  const words = splitSegments(line)[0]?.words ?? [];
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) {
    if (!SAFE_JEV_ENV.test(words[at])) return false;
    at += 1;
  }
  const script = words[at + 1];
  return words[at] === "node" && typeof script === "string" && !script.split("/").includes("..") && resolve(cwd, script) === JEV_SCRIPT;
}

export function createModes(ctx, { env, owns }) {
  const jevKey = (sid) => `jev/${sid}`;
  const stopKey = (sid) => `jev-stop/${sid}`;
  const cursorKey = (sid) => `cursor/${sid}`;
  const notesKey = (sid) => `notes/${sid}`;

  const rootFor = async (sid) => {
    const session = await ctx.session.get({ sessionID: sid });
    const directory = session?.location?.directory;
    if (typeof directory !== "string" || !directory) throw new Error("the session's directory is unavailable");
    return directory;
  };
  const jevActive = async (sid) => (await ctx.storage.get(jevKey(sid))) === true && !loopOff(localID(sid), env);
  const activateJev = async (sid) => {
    loopReset(localID(sid), env);
    await ctx.storage.set(jevKey(sid), true);
    await ctx.storage.remove(stopKey(sid));
  };

  async function addNote(sid, note) {
    const previous = await ctx.storage.get(notesKey(sid));
    const list = Array.isArray(previous) ? previous : [];
    await ctx.storage.set(notesKey(sid), [...list, note].slice(-MAX_NOTES));
  }

  /** Starts the mode a message asked for and returns its note, if any. */
  async function applyIntent(sid, intent) {
    if (!(await owns(SKILL_OF[intent.kind]))) return TEXT.notOwned(intent.kind);
    if (intent.kind === "jev") {
      await activateJev(sid);
      return TEXT.jevOn;
    }
    const cwd = await rootFor(sid);
    handleNudgeHook("UserPromptSubmit", { session_id: localID(sid), prompt: intent.text, cwd }, env);
    return null;
  }

  /** Prompt hook: the intent goes into the message's metadata and nothing else is written (it can run again for the same prompt). */
  async function onPrompt(event) {
    const text = extractPromptText(event);
    if (text === null) return;
    const skills = (event.prompt?.skills ?? []).map((s) => s?.id).filter((id) => typeof id === "string");
    const intent = deriveIntent(text, skills);
    const { apana, ...rest } = event.metadata ?? {};
    if (intent) event.metadata = { ...rest, apana: intent };
    else if (apana !== undefined) event.metadata = rest;
  }

  /**
   * Context hook: handles the user messages not handled before and returns the notes for this request. `messages` are the
   * request's messages (user messages carry their id and the metadata the prompt hook stored).
   */
  async function onContext({ sessionID: sid, messages }) {
    const users = messages.filter((m) => m?.role === "user" && typeof m.id === "string");
    const latestUser = users.at(-1);
    const latest = latestUser?.id;
    const notes = [];
    if (latest !== undefined) {
      const cursor = await ctx.storage.get(cursorKey(sid));
      const seen = typeof cursor === "string" ? users.findIndex((m) => m.id === cursor) : -1;
      // First sight of a session, or the cursor message is gone (compacted away): only the newest message counts, so a fork
      // or a plugin installed late does not replay what the history copied.
      const fresh = seen >= 0 ? users.slice(seen + 1) : [users.at(-1)];
      for (const message of fresh) {
        const intent = storedIntent(message.metadata);
        if (!intent) continue;
        const note = await applyIntent(sid, intent);
        if (note) await addNote(sid, { text: note, mid: message.id });
      }
      if (cursor !== latest) {
        const stop = await ctx.storage.get(stopKey(sid));
        if (stop !== undefined && stop !== latest) await ctx.storage.remove(stopKey(sid));
        await ctx.storage.set(cursorKey(sid), latest);
      }
    }
    // Notes of this turn stay while its message is the latest, except for notes from the removed scope mode.
    // One-shot notes (no `mid`) are given once.
    const stored = await ctx.storage.get(notesKey(sid));
    const latestIsScope = latestUser?.metadata?.apana?.kind === "scope";
    const kept = (Array.isArray(stored) ? stored : []).filter(
      (n) => typeof n?.text === "string" && (
        n.mid === undefined || (n.mid === latest && !latestIsScope && n.text !== LEGACY_JEV_SCOPE_NOTE)
      ),
    );
    for (const n of kept) notes.push(n.text);
    const next = kept.filter((n) => n.mid !== undefined);
    if (Array.isArray(stored) && (kept.length !== stored.length || next.length !== kept.length)) {
      if (next.length) await ctx.storage.set(notesKey(sid), next);
      else await ctx.storage.remove(notesKey(sid));
    }
    notes.push(...(await reminders(sid)));
    return notes;
  }

  /** What each request is told about the modes that are on, read from their state (so it survives a reload and a restart). */
  async function reminders(sid) {
    const out = [];
    try {
      const reminder = handleNudgeHook("UserPromptSubmit", { session_id: localID(sid), prompt: "continue" }, env);
      if (reminder) out.push(reminder.hookSpecificOutput.additionalContext);
    } catch {
      // A reminder is guidance; its state being unreadable is not a reason to stop the request.
    }
    return out;
  }
  function toolInput(event, cwd) {
    const input = event.input ?? {};
    const file = typeof input.path === "string" ? resolve(cwd, input.path) : undefined;
    return { ...input, file_path: file, glob: input.include, "-i": input.caseSensitive === false };
  }

  const ownJev = (input, cwd) =>
    input?.background !== true && isOwnJevCall(input?.command, input?.workdir !== undefined ? resolve(cwd, String(input.workdir)) : cwd);

  /** Tool hook, before a call: throwing refuses the call (OpenCode returns the message to the model as the tool's error). */
  async function beforeTool(event) {
    const sid = event.sessionID;
    const jev = await jevActive(sid);
    const searchLike = event.tool === "shell" || event.tool === "grep";
    if (!jev && !searchLike) return;
    let cwd;
    const sessionDir = async () => (cwd ??= await rootFor(sid));
    if (jev) {
      const dir = await sessionDir();
      if (event.tool === "execute") throw new Error(TEXT.jevCode);
      const own = event.tool === "shell" && ownJev(event.input, dir);
      const name = own ? "Bash" : GATE_NAMES[event.tool] === "Bash" ? "Shell" : (GATE_NAMES[event.tool] ?? event.tool);
      const input = { session_id: localID(sid), tool_name: name, tool_input: toolInput(event, dir) };
      const blocked = jevGate("pre", input, env);
      if (blocked) throw new Error(blocked.hookSpecificOutput.permissionDecisionReason);
      // `jev.mjs --off` ends the mode here as well, so that Code Mode is allowed again.
      if (own && jevCall(event.input.command)?.flag === "--off") await ctx.storage.remove(jevKey(sid));
    }
    if (!searchLike) return;
    try {
      const dir = await sessionDir();
      const toolName = event.tool === "shell" ? "Bash" : "Grep";
      const found = handleNudgeHook("PreToolUse", { session_id: localID(sid), cwd: dir, tool_name: toolName, tool_input: toolInput(event, dir) }, env);
      if (found) await addNote(sid, { text: found.hookSpecificOutput.additionalContext });
    } catch {
      // The class-graph nudge is guidance only.
    }
  }

  /** Tool hook, after a call: a finished Jev call grants (or not) the next call; a model that loaded the Jev skill starts the loop. */
  async function afterTool(event) {
    if (event.status !== "completed") return;
    const sid = event.sessionID;
    if (event.tool === "skill" && event.input?.id === "jev-decision-loop") {
      if (await owns("jev-decision-loop")) await activateJev(sid);
      return;
    }
    if (event.tool !== "shell" || !(await jevActive(sid))) return;
    const cwd = await rootFor(sid);
    if (!ownJev(event.input, cwd)) return;
    jevGate("post", { session_id: localID(sid), tool_name: "Bash", tool_input: { command: event.input.command }, tool_response: textOf(event.result) }, env);
  }

  /**
   * Idle hook: the end of a turn is checked once, like the Stop hook. Work that this session itself still runs will wake the hook
   * again; work of a child session will not, so it does not hold the check back.
   */
  async function onIdle(event) {
    const sid = event.sessionID;
    if (event.background.some((b) => b?.sessionID === sid)) return;
    if (!(await jevActive(sid))) return;
    const stop = await ctx.storage.get(stopKey(sid));
    const out = jevGate("stop", { session_id: localID(sid), stop_hook_active: stop !== undefined }, env);
    if (out?.decision === "block") {
      const syn = await ctx.session.synthetic({ sessionID: sid, text: out.reason });
      await ctx.storage.set(stopKey(sid), typeof syn?.id === "string" ? syn.id : true);
    } else if (stop !== undefined) await ctx.storage.remove(stopKey(sid));
  }

  return { onPrompt, onContext, beforeTool, afterTool, onIdle };
}
