// opencode-auto, server part (OpenCode 2.3.0): hands a marked session off to a new one before its context fills up.
// The TUI part (tui.mjs) marks the sessions of a TUI that was started by `opencode-auto` (metadata apana.auto, which carries the settings)
// and follows `apana.next` to the new session; this part never sees the TUI's environment, so the mark is the only thing it goes by.
// What it relies on was measured, not read: see PRIVATE.md, "opencode-auto". In short: there is one instance of this plugin per location and
// every instance receives the events of every location (so an instance acts only on its own location's sessions); metadata is replaced
// as a whole on update; interrupt ends a running tool and the step at once but not the background subagents; the handoff must precede
// OpenCode's own compaction, which starts at the next turn once the context reaches its ceiling.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.url is the real path of the file, also when the plugin folder is reached through a link (measured).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const REQUIRED = [
  "event.subscribe", "model.list", "session.get", "session.create", "session.prompt", "session.update", "session.interrupt", "session.remove",
  "tool.hook",
];
export const EVENT_TYPES = Object.freeze([
  "session.created", "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.step.ended",
]);
const ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

export const DEFAULTS = Object.freeze({ tokens: 200_000, margin: 15_000, deferExtra: 30_000, cooldown: 60, max: 0, skills: "none" });
const RETRY_MS = 60_000;
const SCRIPT_TIMEOUT_MS = 90_000;
const LIST_TIMEOUT_MS = 30_000;
const INTERRUPT_WAIT_MS = 10_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const TRACKED = 2000;
// OpenCode's own compaction ceiling: window - max(15% of the window, 16k when the window is at least 32k) (source of 2.3.0 and a measured bracket).
const RESERVE_SHARE = 0.15;
const RESERVE_MIN = 16_000;
// A mode that stays on until the user ends it: reloaded after the handoff when the session loaded it (same list as claude-auto).
const KEPT_SKILLS = ["caveman"];

const REFUSAL = "Apana auto: the context is nearly full, so this session is being handed off to a new one. Stop here and do not retry this call.";

/** The size of the context at the end of a step, the way OpenCode counts it for its compaction; null when the event carries no usage. */
export function contextOf(tokens) {
  if (!tokens || !Number.isFinite(tokens.input) || !Number.isFinite(tokens.output)) return null;
  return tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) + tokens.output + (tokens.reasoning ?? 0);
}

/** The window a model really has: the smaller of `input` and `context` when both are set, else whichever is. */
export function windowOf(limit) {
  if (!limit) return null;
  const window = limit.input && limit.context ? Math.min(limit.input, limit.context) : limit.input || limit.context;
  return Number.isFinite(window) && window > 0 ? window : null;
}

export const ceilingOf = (window) => window - Math.max(Math.floor(window * RESERVE_SHARE), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0);

/**
 * Where a handoff starts: `step` at the end of a step, `tool` before a tool call (`margin` earlier, so that a tool result does not land in a
 * context that is almost full). Both stay `margin` below OpenCode's compaction ceiling, so that the handoff comes first.
 */
export function limitsOf(settings, window) {
  const cap = window ? ceilingOf(window) : Infinity;
  return { step: Math.max(1, Math.min(settings.tokens, cap - settings.margin)), tool: Math.max(1, Math.min(settings.tokens, cap) - settings.margin) };
}

const whole = (value, min, max, fallback) => (Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback);

/** The settings in `metadata.apana.auto`, each checked on its own; what is missing or wrong falls back to the default. */
export function settingsOf(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const tokens = whole(a.tokens, 1_000, 10_000_000, DEFAULTS.tokens);
  return {
    tokens,
    margin: whole(a.margin, 0, tokens, Math.min(DEFAULTS.margin, tokens)),
    deferExtra: whole(a.deferExtra, 0, 10_000_000, DEFAULTS.deferExtra),
    cooldown: whole(a.cooldown, 0, 86_400, DEFAULTS.cooldown),
    max: whole(a.max, 0, 1_000_000, DEFAULTS.max),
    skills: typeof a.skills === "string" && /^[\w:.,-]{0,200}$/.test(a.skills) ? a.skills.trim() || DEFAULTS.skills : DEFAULTS.skills,
    dir: typeof a.dir === "string" && isAbsolute(a.dir) && !a.dir.includes("\0") ? a.dir : null,
    chain: whole(a.chain, 0, 1_000_000, 0),
  };
}

/** A shell-quoted word as Python's shlex.quote writes it (a bare word, or single-quoted parts) -> the word; null when it is not closed. */
export function unquote(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return null;
      out += text.slice(i + 1, end);
      i = end + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The two things make_context.py prints for OpenCode that the new session needs: the note and the prompt it suggests. Null when either is missing. */
export function parseHandoff(stdout) {
  const ready = /^ready: (.+)$/m.exec(stdout)?.[1];
  const quoted = /^[ \t]*opencode --prompt (.+)$/m.exec(stdout)?.[1];
  const prompt = quoted === undefined ? null : unquote(quoted.trim());
  return ready && prompt ? { ready: ready.trim(), prompt } : null;
}

/** What the new session is told after the note's own prompt: keep working (the note itself says "answer and wait"), and who was still running. */
export function continuation(tokens, running = []) {
  return (
    ` Sesiunea precedentă a fost oprită automat la ~${Math.round(tokens / 1000)}k tokeni de context, ca lucrul să continue în această sesiune nouă. ` +
    "Excepție de la regula „răspunde și așteaptă”: după ce ai citit nota, reia imediat lucrul din punctul în care a rămas (ultimul lucru din transcript), " +
    "fără să repeți acțiuni deja terminate. Dacă pasul următor este ireversibil sau cere decizia mea, oprește-te și întreabă." +
    (running.length
      ? ` Subagenții (sesiuni copil) cu id-urile ${running.join(", ")} încă rulau când s-a făcut handoff-ul. Continuă în fundal, dar rezultatul lor ajunge în sesiunea veche, nu în aceasta: ` +
        "verifică ce au făcut și relansează-i numai dacă lucrul lor nu e terminat și nu i-am oprit eu. Nu aștepta o notificare de la ei."
      : "") +
    " Aceasta este continuarea aceleiași sarcini, nu o cerere de rezumat al transferului. Păstrează cerințele utilizatorului pentru răspunsul final, inclusiv formatul exact. " +
    "Dacă utilizatorul a cerut doar un anumit text, răspunsul final conține numai acel text, fără rezumat, explicații sau raport suplimentar despre transfer."
  );
}

const has = (ctx, path) => typeof path.split(".").reduce((value, key) => value?.[key], ctx) === "function";
const describe = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Runs make_context.py. `children` collects the processes so that unloading the plugin can end them. Never rejects. */
function runScript(script, args, timeoutMs, { env = process.env, children = new Set() } = {}) {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", "-B", script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const keep = (current, data) => (current.length < MAX_OUTPUT ? current + data.toString("utf8") : current);
    child.stdout.on("data", (data) => (stdout = keep(stdout, data)));
    child.stderr.on("data", (data) => (stderr = keep(stderr, data)));
    const finish = (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stdout, stderr });
    };
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/**
 * @param ctx plugin context. @param options paths and clocks, all replaceable by a test: stateDir (the `enabled` file and auto.log), dataDir (the notes),
 * db, script, run(args, timeoutMs) -> {code, stdout, stderr}, now, log(message), waitMs (how long to wait for execution.interrupted).
 */
export function createAuto(ctx, options = {}) {
  const env = options.env ?? process.env;
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const stateDir = options.stateDir ?? join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "apana", "auto");
  const dataDir = options.dataDir ?? join(dataHome, "opencode", "apana");
  const db = options.db ?? join(dataHome, "opencode", "opencode.db");
  const script = options.script ?? join(ROOT, "skills", "compact-handoff", "scripts", "make_context.py");
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? INTERRUPT_WAIT_MS;
  const processes = new Set();
  const run = options.run ?? ((args, timeoutMs) => runScript(script, args, timeoutMs, { env, children: processes }));
  const log =
    options.log ??
    ((message) => {
      try {
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(join(stateDir, "auto.log"), `${new Date(now()).toISOString()} ${message}\n`);
      } catch {
        // The log is a convenience; losing a line must not stop a handoff.
      }
    });
  const here = ctx.location?.directory ? real(ctx.location.directory) : null;

  const last = new Map(); // session -> context at the end of its last step
  const children = new Map(); // subagent session -> { parent, running }
  const claims = new Set(); // sessions whose handoff is running or done in this process (a written `next` covers a restart)
  const failedAt = new Map();
  const waiters = new Map(); // session -> resolvers waiting for the end of its execution
  const noted = new Set();
  const models = { at: 0, list: [] };
  let lastHandoff = null;

  const enabled = () => existsSync(join(stateDir, "enabled"));
  const isOwn = (directory) => here === null || (typeof directory === "string" && real(directory) === here);
  const cap = (map) => {
    while (map.size > TRACKED) {
      const oldest = [...map.keys()].find((key) => !map.get(key)?.running) ?? map.keys().next().value;
      map.delete(oldest);
    }
  };
  const note = (key, message) => {
    if (noted.has(key)) return;
    noted.add(key);
    if (noted.size > TRACKED) noted.delete(noted.values().next().value);
    log(message);
  };

  const getInfo = async (sessionID) => {
    try {
      return await ctx.session.get({ sessionID });
    } catch {
      return null;
    }
  };
  const rootOf = (id) => {
    let current = id;
    for (let hops = 0; hops < 16 && children.has(current); hops += 1) current = children.get(current).parent;
    return current;
  };
  const runningUnder = (root) => [...children].filter(([id, child]) => child.running && rootOf(id) === root).map(([id]) => id);

  async function windowFor(model) {
    if (!model?.id) return null;
    if (now() - models.at > 60_000) {
      try {
        models.list = (await ctx.model.list())?.data ?? [];
        models.at = now();
      } catch {
        return null;
      }
    }
    return windowOf(models.list.find((m) => m.id === model.id && (m.providerID ?? m.provider) === model.providerID)?.limit);
  }

  /** The settings of a session this plugin may hand off: a root session that is marked and has not been handed off. Else null. */
  function marked(info) {
    if (!info || info.parentID) return null;
    const apana = info.metadata?.apana;
    if (!apana || typeof apana !== "object" || apana.next !== undefined) return null;
    return apana.auto && typeof apana.auto === "object" ? settingsOf(apana.auto) : null;
  }

  /** Why a handoff must not start now (a reason), or the subagents that are running. Nothing here awaits: the claim that follows is atomic with it. */
  function admit(sessionID, total, settings, limits) {
    if (claims.has(sessionID)) return { why: "claimed" };
    if (lastHandoff !== null && now() - lastHandoff < settings.cooldown * 1000) return { why: "cooldown", text: `${total} tokens but the last handoff is younger than ${settings.cooldown}s; skipped` };
    const failed = failedAt.get(sessionID);
    if (failed !== undefined && now() - failed < RETRY_MS) return { why: "failed" };
    if (settings.max > 0 && settings.chain >= settings.max) return { why: "max", text: `${total} tokens but the limit of ${settings.max} handoffs is reached; skipped` };
    const busy = runningUnder(sessionID);
    if (busy.length && total < limits.step + settings.deferExtra) return { why: "deferred", text: `${total} tokens >= ${limits.step} but ${busy.length} subagent(s) still running (${busy.join(", ")}); handoff deferred` };
    return { busy };
  }

  /** Starts a handoff when one is due and allowed -> whether it started. The claim is taken before anything is awaited. */
  function trigger(sessionID, info, settings, total, limits, via) {
    const verdict = admit(sessionID, total, settings, limits);
    if (verdict.why) {
      if (verdict.text) note(`${sessionID}:${verdict.why}`, `${sessionID} ${verdict.text}`);
      return false;
    }
    claims.add(sessionID);
    void handoff(sessionID, info, settings, total, verdict.busy, via);
    return true;
  }

  function waitForEnd(sessionID) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    if (!waiters.has(sessionID)) waiters.set(sessionID, new Set());
    waiters.get(sessionID).add(resolve);
    const timer = setTimeout(resolve, waitMs);
    const cancel = () => {
      clearTimeout(timer);
      waiters.get(sessionID)?.delete(resolve);
    };
    return { promise: promise.then(cancel), cancel };
  }

  async function interrupt(sessionID) {
    const waiting = waitForEnd(sessionID);
    let result;
    try {
      result = await ctx.session.interrupt({ sessionID, resume: false });
    } catch (error) {
      waiting.cancel();
      throw error;
    }
    if (!result?.interrupted) return waiting.cancel();
    await waiting.promise;
  }

  /** The make_context.py options for the skills: none (also unset), all, or names. A kept skill that the session loaded is always added. */
  async function skillsArgs(want, sessionID) {
    if (want === "all") return [];
    const names = want === "none" ? [] : [...new Set(want.split(",").map((n) => n.trim()).filter(Boolean))];
    const listed = await run(["--opencode", db, "--session", sessionID, "--list-skills"], LIST_TIMEOUT_MS);
    if (listed.code !== 0) {
      log(`${sessionID}: --list-skills exit ${listed.code}; no skills reloaded`);
      return ["--no-skills"];
    }
    const loaded = listed.stdout.split("\n").filter((l) => l.startsWith("skill: ") && l.endsWith(" characters") && l.includes(" | ")).map((l) => l.slice(7, l.lastIndexOf(" | ")));
    const chosen = names.filter((n) => loaded.includes(n));
    for (const name of loaded) if (KEPT_SKILLS.includes(name.split(":").pop()) && !chosen.includes(name)) chosen.push(name);
    return chosen.length ? ["--skills", chosen.join(",")] : ["--no-skills"];
  }

  /** The handoff itself. Never rejects: a failure releases the claim (a retry waits RETRY_MS) and is only logged. */
  async function handoff(sessionID, info, settings, total, busy, via) {
    let made = null;
    try {
      await interrupt(sessionID);
      const short = sessionID.replace(/[^A-Za-z0-9]/g, "").replace(/^ses/, "").slice(0, 8);
      const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").slice(0, 15);
      const folder = join(settings.dir ?? join(dataDir, "handoffs", "auto"), `${short}-${stamp}`);
      const result = await run(["--opencode", db, folder, "--session", sessionID, ...(await skillsArgs(settings.skills, sessionID))], SCRIPT_TIMEOUT_MS);
      const note = result.code === 0 ? parseHandoff(result.stdout) : null;
      if (!note) throw new Error(`make_context.py exit ${result.code}: ${(result.stderr || result.stdout).slice(-300).trim()}`);
      // Read again: the TUI or the user may have changed the metadata while the note was written, and an update replaces it as a whole.
      const fresh = (await getInfo(sessionID)) ?? info;
      const apana = { ...(fresh.metadata?.apana ?? {}) };
      delete apana.next;
      const auto = { ...(apana.auto && typeof apana.auto === "object" ? apana.auto : {}), chain: settings.chain + 1 };
      made = await ctx.session.create({
        ...(fresh.agent ? { agent: fresh.agent } : {}),
        ...(fresh.model ? { model: fresh.model } : {}),
        ...(fresh.location ? { location: fresh.location } : {}),
        metadata: { ...fresh.metadata, apana: { ...apana, auto } },
      });
      await ctx.session.prompt({ sessionID: made.id, text: note.prompt + continuation(total, busy) });
      try {
        const latest = (await getInfo(sessionID)) ?? fresh;
        await ctx.session.update({ sessionID, metadata: { ...latest.metadata, apana: { ...(latest.metadata?.apana ?? {}), next: made.id } } });
      } catch (error) {
        // The new session exists and has its prompt: running another handoff would make a second one. Only the TUI's jump is lost.
        log(`${sessionID}: the new session ${made.id} is running but \`next\` was not written (${describe(error)})`);
      }
      lastHandoff = now();
      log(`${sessionID}: ${total} tokens; handoff (${via}) to ${made.id}, note ${note.ready}${busy.length ? `, subagents left running: ${busy.join(", ")}` : ""}`);
    } catch (error) {
      if (made) await ctx.session.remove({ sessionID: made.id }).catch(() => {});
      claims.delete(sessionID);
      failedAt.set(sessionID, now());
      log(`${sessionID}: handoff failed (${describe(error)}); a retry waits ${RETRY_MS / 1000}s`);
    }
  }

  async function onStepEnded(event) {
    const data = event.data ?? {};
    const total = contextOf(data.tokens);
    if (typeof data.sessionID !== "string" || total === null) return; // a step without usage says nothing about the context
    if (event.location?.directory !== undefined && !isOwn(event.location.directory)) return; // another location's instance handles it
    last.set(data.sessionID, total);
    cap(last);
    if (!enabled()) return;
    const info = await getInfo(data.sessionID);
    if (!info || !isOwn(info.location?.directory)) return;
    const settings = marked(info);
    if (!settings) return;
    const limits = limitsOf(settings, await windowFor(info.model));
    if (total >= limits.step) trigger(data.sessionID, info, settings, total, limits, "step");
  }

  async function onEvent(event) {
    const data = event?.data ?? {};
    switch (event?.type) {
      case "session.created":
        if (typeof data.parentID === "string" && typeof data.sessionID === "string") {
          children.set(data.sessionID, { parent: data.parentID, running: false });
          cap(children);
        }
        break;
      case "session.execution.started":
        if (children.has(data.sessionID)) children.get(data.sessionID).running = true;
        break;
      case "session.step.ended":
        await onStepEnded(event);
        break;
      default:
        if (ENDED.has(event?.type)) {
          if (children.has(data.sessionID)) children.get(data.sessionID).running = false;
          for (const resolve of waiters.get(data.sessionID) ?? []) resolve();
        }
    }
  }

  /**
   * Before a tool call: refuses it (by throwing) once the handoff is due or under way. Measured on 2.3.2: the refused call does not run, but the handoff
   * interrupts the session at once, so its model gets no further request and never reads this text; a call the interrupt reaches first does not
   * run either, which is why only the unit tests (not the runtime test) show the throw itself matters. A parallel call of the same step is refused too.
   */
  async function beforeTool(event) {
    const sessionID = event?.sessionID;
    if (typeof sessionID !== "string" || !enabled()) return;
    if (claims.has(sessionID)) throw new Error(REFUSAL); // a parallel call of the step that started the handoff, or one that came after it
    const total = last.get(sessionID);
    if (total === undefined) return;
    const info = await getInfo(sessionID);
    if (!info || !isOwn(info.location?.directory)) return;
    const settings = marked(info);
    if (!settings) return;
    const limits = limitsOf(settings, await windowFor(info.model));
    if (total < limits.tool) return;
    if (claims.has(sessionID) || trigger(sessionID, info, settings, total, limits, "tool")) throw new Error(REFUSAL);
  }

  async function consume(events) {
    for await (const event of events) {
      try {
        await onEvent(event);
      } catch (error) {
        log(`event ${event?.type}: ${describe(error)}`);
      }
    }
  }

  return {
    beforeTool,
    consume,
    start: (signal) => consume(ctx.event.subscribe({ types: [...EVENT_TYPES], signal })),
    dispose: () => {
      for (const child of processes) child.kill("SIGKILL");
      for (const set of waiters.values()) for (const resolve of set) resolve();
    },
  };
}

/** Registers the tool hook and the event subscription. Throws, with nothing left registered, when OpenCode lacks a capability. */
export async function setupAuto(ctx, env = process.env, options = {}) {
  for (const path of REQUIRED) if (!has(ctx, path)) throw new Error(`OpenCode does not offer ${path}`);
  const auto = createAuto(ctx, { env, ...options });
  const controller = new AbortController();
  const hook = await ctx.tool.hook("execute.before", auto.beforeTool);
  let running;
  try {
    running = auto.start(controller.signal).catch(() => {});
  } catch (error) {
    // The subscription is made when start is called, so a failure there comes out here, with the hook already registered.
    controller.abort();
    await hook.dispose();
    throw error;
  }
  return {
    dispose: async () => {
      controller.abort();
      auto.dispose();
      await Promise.allSettled([hook.dispose(), running]);
    },
  };
}
