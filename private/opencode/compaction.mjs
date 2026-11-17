// compact-session on OpenCode 2.3.0. The user's command asks OpenCode for a compaction (the request is only admitted, not done);
// the `compaction` hook then supplies, in place of a model summary, the verified transcript that compact.py prepares. Nothing
// here ever falls back to the model's summarizer: a failure throws, which 2.3.0 records as a failed compaction and which keeps
// the whole history. Per session, in plugin storage: requested -> preparing -> installed | noop | failed -> reported.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./compact.py", import.meta.url));
export const STALE_MS = 20 * 60_000;
const TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

/** Runs compact.py on {sessionId, messages}. `children` collects the processes so that unloading the plugin can end them. */
export function prepare(snapshot, { env = process.env, children = new Set() } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(snapshot);
    const child = spawn("python3", ["-I", "-B", SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let size = 0;
    let overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      children.delete(child);
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.stdout.on("data", (data) => {
      size += data.length;
      if (size > MAX_OUTPUT) {
        overflow = true;
        child.kill("SIGKILL");
      } else stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data) => {
      if (stderr.length < 4000) stderr += data.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      done();
      if (code !== 0 || overflow) {
        const line = stderr.split("\n").find((l) => l.startsWith("compact-session:")) ?? "";
        const error = new Error("the compactor failed");
        error.detail = line.slice(0, 240);
        return reject(error);
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("the compactor returned invalid output"));
      }
    });
    child.stdin.end(payload);
  });
}

const valid = (r) =>
  r !== null && typeof r === "object" && typeof r.text === "string" && r.text.length > 0 && typeof r.artifact === "string" &&
  r.artifact.startsWith("/") && Number.isSafeInteger(r.beforeChars) && Number.isSafeInteger(r.afterChars) && r.beforeChars > 0 && r.afterChars > 0;

// The message of a thrown error is what OpenCode stores in the failed compaction; its stack would only add paths.
const fail = (message) => {
  const error = new Error(message);
  error.stack = message;
  return error;
};

const successText = (s) =>
  `Context compacted in the same session. Characters (measured; n=1): ${s.before} -> ${s.after}. Recoverable history: ${s.artifact}`;
const unconfirmedText = (s) =>
  `The verified replacement was prepared (characters, measured; n=1: ${s.before} -> ${s.after}) but OpenCode did not record it, so the context is unchanged. The prepared files are in ${s.artifact}.`;
const noopText = (s) =>
  `Context unchanged: the verified replacement would not reduce context. Prepared transcript characters (measured; n=1): ${s.before} -> ${s.after}. The current context was kept. OpenCode 2.3.0 has no result for a verified no-op, so it records this run as a failed compaction.`;
const failedText = (s) =>
  `Context unchanged: the compact-session replacement could not be prepared${s.reason ? ` (${s.reason})` : ""}. No model summary was requested; OpenCode records this run as a failed compaction.`;

/**
 * @param ctx plugin context (session, storage). @param options.prepareSnapshot replaces prepare() in tests.
 * The returned `install(keep)` registers the compaction hook through `keep` (which remembers the registration for rollback).
 */
export function createCompaction(ctx, { prepareSnapshot = prepare, now = Date.now, newToken = randomUUID } = {}) {
  const children = new Set();
  const key = (sessionID) => `compact/${sessionID}`;
  const get = (sessionID) => ctx.storage.get(key(sessionID));
  const put = (sessionID, state) => ctx.storage.set(key(sessionID), state);
  const fresh = (state) => state && typeof state.at === "number" && now() - state.at <= STALE_MS;

  /** Asks OpenCode for a compaction and records that the next one is ours. Throws when it cannot, leaving nothing pending. */
  async function request(sessionID, delivery = "steer") {
    const current = await get(sessionID);
    if ((current?.state === "requested" || current?.state === "preparing") && fresh(current)) {
      throw new Error("A compact-session request is already pending in this session");
    }
    const token = newToken();
    // Before the call: OpenCode may run the hook before compact() returns.
    await put(sessionID, { state: "requested", token, at: now() });
    try {
      await ctx.session.compact({ sessionID, delivery });
    } catch {
      if ((await get(sessionID))?.token === token) await ctx.storage.remove(key(sessionID));
      throw new Error("compact-session could not ask OpenCode for a compaction; the context is unchanged");
    }
    return token;
  }

  async function onCompaction(event) {
    const sessionID = event.sessionID;
    const state = await get(sessionID);
    // Any other compaction (the user's /compact, an automatic one) is left to OpenCode.
    if (state?.state !== "requested" || !fresh(state)) return;
    const { token } = state;
    await put(sessionID, { state: "preparing", token, at: now() });
    let result;
    try {
      result = await prepareSnapshot({ sessionId: sessionID, messages: event.messages }, { children });
      if (!valid(result)) throw new Error("the compactor returned an invalid replacement");
    } catch (error) {
      await put(sessionID, { state: "failed", token, at: now(), reason: typeof error?.detail === "string" ? error.detail : "" });
      throw fail("Apana compact-session: the verified replacement could not be prepared; the context is unchanged and no summary was requested.");
    }
    const sizes = { before: result.beforeChars, after: result.afterChars, artifact: result.artifact };
    if (result.afterChars >= result.beforeChars) {
      await put(sessionID, { state: "noop", token, at: now(), ...sizes });
      throw fail(`Apana compact-session: the verified replacement would not reduce the context (${sizes.before} -> ${sizes.after} characters); the context is unchanged (no-op).`);
    }
    await put(sessionID, { state: "installed", token, at: now(), ...sizes });
    // keepID undefined: OpenCode keeps no recent tail beside the text, so the replacement is exactly the verified transcript.
    event.result = { summary: result.text, metadata: { keepID: undefined, apana: { token, artifact: sizes.artifact, beforeChars: sizes.before, afterChars: sizes.after } } };
  }

  /**
   * The finished outcome to tell the model in the turn of `latestUserID`, or null. The first call that sees a finished outcome
   * ties it to that user message and keeps returning it while that message is the latest one; a newer message ends it. A prompt
   * that is never admitted never reaches here, so it consumes nothing.
   */
  async function report(sessionID, latestUserID) {
    const state = await get(sessionID);
    if (!state) return null;
    if (state.state === "requested" || state.state === "preparing") {
      if (!fresh(state)) await ctx.storage.remove(key(sessionID));
      return null;
    }
    if (state.state === "reported") {
      if (state.mid !== undefined && state.mid === latestUserID) return state.text;
      await ctx.storage.remove(key(sessionID));
      return null;
    }
    let text;
    if (state.state === "installed") {
      let messages;
      try {
        messages = await ctx.session.context({ sessionID });
      } catch {
        return null;
      }
      const recorded = messages.some((m) => m?.type === "compaction" && m.status === "completed" && m.metadata?.apana?.token === state.token);
      text = recorded ? successText(state) : unconfirmedText(state);
    } else text = state.state === "noop" ? noopText(state) : failedText(state);
    await put(sessionID, { state: "reported", token: state.token, at: now(), text, mid: latestUserID });
    return text;
  }

  return {
    request,
    report,
    async install(keep) {
      await keep(ctx.session.hook("compaction", onCompaction));
    },
    dispose() {
      for (const child of children) child.kill("SIGKILL");
      children.clear();
    },
  };
}
