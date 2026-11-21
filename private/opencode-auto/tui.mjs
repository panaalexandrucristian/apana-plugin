// opencode-auto, TUI part (OpenCode 2.3.0): marks the sessions of a TUI that `opencode-auto` started and follows them to the new session.
// The launcher sets APANA_OPENCODE_AUTO for the TUI process only; the server never sees it (measured, also with a TUI connected to a separate
// server), so the mark on the session (metadata apana.auto, which carries the settings) is the only way the server part learns which sessions are
// automatic. Without the variable it marks nothing and follows nothing, and it takes the mark off a session it opens: the mark outlives the
// window that set it (the server copies it to the new session of a chain, and a marked session can be reopened in a plain `opencode`), and a
// plain window cannot follow a handoff, so the server would hand the session off under it and refuse every tool call of the old session that
// the window keeps showing (measured 2026-11-21 on 2.3.2, n=1 on the owner's machine and n=1 in live_check.py). Only sessions shown in a window
// that `opencode-auto` started are handed off (owner decision).
// Measured on 2.3.0: the TUI loads this plugin from the server's plugin folder; client.session.get returns the session itself; update replaces
// `metadata` as a whole (so it is read, changed and written back); router.navigate moves the same TUI process to the new session.

const REQUIRED = ["data.on", "ui.router.current", "ui.router.navigate", "ui.toast.show", "client.session.get", "client.session.update"];
const POLL_MS = 500;
const RETRY_MS = 5_000;
const TRACKED = 500;

// Environment variable -> the key of apana.auto the server reads (settingsOf in server.mjs checks each value again).
const NUMBERS = { APANA_OPENCODE_AUTO_TOKENS: "tokens", APANA_OPENCODE_AUTO_PRETOOL_MARGIN: "margin", APANA_OPENCODE_AUTO_DEFER_EXTRA: "deferExtra", APANA_OPENCODE_AUTO_COOLDOWN: "cooldown", APANA_OPENCODE_AUTO_MAX: "max" };
const TEXTS = { APANA_OPENCODE_AUTO_SKILLS: "skills", APANA_OPENCODE_AUTO_DIR: "dir" };

const has = (context, path) => typeof path.split(".").reduce((value, key) => value?.[key], context) === "function";
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** Whether the launcher started this TUI. */
export const isAuto = (env) => Boolean(env.APANA_OPENCODE_AUTO) && env.APANA_OPENCODE_AUTO !== "0";

/** The settings to put on a session: only what the environment sets, as numbers or text; the server falls back to its defaults for the rest. */
export function markOf(env) {
  const mark = {};
  for (const [name, key] of Object.entries(NUMBERS)) if (/^\d{1,9}$/.test(env[name] ?? "")) mark[key] = Number(env[name]);
  for (const [name, key] of Object.entries(TEXTS)) if (typeof env[name] === "string" && env[name].trim()) mark[key] = env[name].trim();
  return mark;
}

/** The line the sidebar shows for a session, or null when it is not an automatic one (a child, or one that was never marked). The server hands off only what `marked()` in server.mjs accepts, and this follows it. */
export function sidebarLabel(info) {
  if (!info || info.parentID) return null;
  const apana = object(object(info.metadata).apana);
  if (!apana.auto || typeof apana.auto !== "object") return null;
  return apana.next !== undefined ? "Auto handoff: done" : "Auto handoff: on";
}

const sessionOf = (got) => (got && typeof got === "object" && "id" in got ? got : got?.data ?? null);

/**
 * @param context the TUI plugin context. @param options pollMs (0: no polling, a test calls check()), now, retryMs, sidebar (registers the sidebar line, returns its cleanup).
 * Throws, with nothing registered, when OpenCode lacks a capability.
 */
export async function setupAutoTui(context, env = process.env, options = {}) {
  for (const path of REQUIRED) if (!has(context, path)) throw new Error(`OpenCode does not offer ${path}`);
  // The line in the sidebar belongs to the mark on the session. A window that was not started by `opencode-auto` takes the mark off the session it
  // opens, so there the line only stays on a session that was already handed off ("done"). A sidebar that cannot be registered must not stop the marking.
  let unslot = () => {};
  if (typeof options.sidebar === "function" && has(context, "ui.slot")) {
    try {
      const off = options.sidebar(context, sidebarLabel);
      if (typeof off === "function") unslot = off;
    } catch {
      // No line in the sidebar; the rest works.
    }
  }
  const auto = isAuto(env);
  const mark = markOf(env);
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? RETRY_MS;
  const router = context.ui.router;
  const marked = new Set(); // sessions that were looked at: marked or unmarked, or left as they were (a child, one already handed off, one that has the mark)
  const retryAt = new Map();
  const working = new Set(); // sessions being marked right now: a slow server must not get the same write twice
  const seen = new Set(); // sessions opened in this TUI: only those are followed (by an automatic window; a plain one follows nothing)
  const followed = new Set();
  const cap = (collection) => {
    while (collection.size > TRACKED) collection.delete(collection.keys().next().value);
  };
  const route = () => {
    try {
      return router.current();
    } catch {
      return null;
    }
  };

  /**
   * The metadata to write on a session this window opens, whole (an update replaces it), or null to leave it. An automatic window puts the mark on,
   * and a session that has it keeps it (the chain). A plain window takes it off and keeps the rest; one that has `next` is left alone, the server no
   * longer acts on it.
   */
  function changed(info) {
    const metadata = object(info.metadata);
    const apana = object(metadata.apana);
    const hasMark = Boolean(apana.auto) && typeof apana.auto === "object";
    if (auto) return !info.parentID && apana.next === undefined && !hasMark ? { ...metadata, apana: { ...apana, auto: mark } } : null;
    if (!hasMark || apana.next !== undefined) return null;
    const { auto: _mark, ...rest } = apana;
    const { apana: _apana, ...others } = metadata;
    return Object.keys(rest).length ? { ...others, apana: rest } : others;
  }

  /** Marks or unmarks a session (see `changed`). Reads it first: an update replaces the metadata as a whole. */
  async function markSession(sessionID) {
    const info = sessionOf(await context.client.session.get({ sessionID }));
    if (!info) throw new Error("no session");
    const metadata = changed(info);
    if (metadata) await context.client.session.update({ sessionID, metadata });
  }

  /** One look at the route: a session that is open and not yet looked at gets marked, or unmarked in a plain window. */
  async function check() {
    const current = route();
    if (current?.type !== "session" || typeof current.sessionID !== "string") return;
    const sessionID = current.sessionID;
    seen.add(sessionID);
    cap(seen);
    if (marked.has(sessionID) || working.has(sessionID) || (retryAt.get(sessionID) ?? 0) > now()) return;
    working.add(sessionID);
    try {
      await markSession(sessionID);
      marked.add(sessionID);
      cap(marked);
      retryAt.delete(sessionID);
    } catch {
      retryAt.set(sessionID, now() + retryMs);
      cap(retryAt);
    } finally {
      working.delete(sessionID);
    }
  }

  /** `next` appeared on a session: when it is the one that is open, the window moves to the new one. */
  function onMetadata(event) {
    const sessionID = event?.data?.sessionID;
    const next = event?.data?.metadata?.apana?.next;
    if (typeof sessionID !== "string" || typeof next !== "string" || !seen.has(sessionID) || followed.has(sessionID)) return;
    followed.add(sessionID);
    cap(followed);
    const current = route();
    try {
      if (current?.type === "session" && current.sessionID === sessionID) {
        router.navigate({ type: "session", sessionID: next });
        context.ui.toast.show({ message: "apana auto: moved to the new session", variant: "info" });
      } else {
        context.ui.toast.show({ message: `apana auto: a session was handed off to ${next}`, variant: "info" });
      }
    } catch {
      // The window stays where it is; the handoff itself has happened.
    }
    // The old session is archived once the window is no longer on it. The plugin API of the server part ignores `archived` on `session.update`
    // (measured on 2.3.2, n=1), the client of the TUI does not. A window that could not be moved keeps the session on screen.
    const after = route();
    if (after?.type === "session" && after.sessionID === sessionID) return;
    void archive(sessionID);
  }

  /** Archives a session that was handed off. A refusal leaves it in the list: the handoff itself has happened. */
  async function archive(sessionID) {
    try {
      await context.client.session.update({ sessionID, archived: true });
    } catch {
      // Left in the list of sessions.
    }
  }

  const stop = auto ? context.data.on("session.metadata.updated", onMetadata) : () => {};
  const pollMs = options.pollMs ?? POLL_MS;
  const timer = pollMs > 0 ? setInterval(() => void check(), pollMs) : null;
  void check();
  return {
    check,
    dispose: () => {
      if (timer) clearInterval(timer);
      stop();
      unslot();
    },
  };
}
