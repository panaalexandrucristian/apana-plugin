import type { Register, TurnCompleteResult } from "claude-code";

type Prepared = {
  text: string;
  artifact: string;
  beforeChars: number;
  afterChars: number;
};

function prepared(value: unknown): value is Prepared {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Prepared;
  return typeof p.text === "string" && p.text.length > 0 &&
    typeof p.artifact === "string" && p.artifact.startsWith("/") &&
    Number.isSafeInteger(p.beforeChars) && Number.isSafeInteger(p.afterChars) &&
    p.beforeChars > 0 && p.afterChars > 0;
}

export const register: Register = (on) => {
  let active = false;
  let compacting = false;
  let installed: Prepared | undefined;
  let pendingReport: { text: string } | undefined;

  function report(result: TurnCompleteResult, status: string): TurnCompleteResult {
    pendingReport = { text: status };
    return { ...result, text: `${result.text}\n${status}` };
  }

  on("prompt.submit", async ($, e, next) => {
    const pending = pendingReport;
    if (pending === undefined) return next(e);
    const result = await next({ ...e, context: [...(e.context ?? []),
      `compact-session last result (already completed; do not rerun):\n${pending.text}`] });
    if (result.drop === undefined && pendingReport === pending) pendingReport = undefined;
    return result;
  });

  on("skill.prompt", { pluginName: "apana", skill: ["compact-session", "apana:compact-session"] }, async ($, e, next) => {
    if (e.source !== "plugin") return next(e);
    const result = await next(e);
    active = true;
    return { text: `${result.text}\ncompact-session-native-ready: the native bridge is loaded. Finish this turn without tools; the skill's Stop hook requests the one-shot compaction.` };
  }).catch(($, e, next) => {
    active = false;
    return next.called ? next(e) : { text: `${e.text}\nThe native compact-session bridge is unavailable.` };
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId !== undefined || !active) return next(e);
    active = false;
    const result = await next(e);
    try {
      const sessionId = await $.session.id();
      const request = await $.process.run([
        "python3", "-I", `${$.plugin.root}/skills/compact-session/scripts/request_compaction.py`, "take", sessionId,
      ]);
      if (request.exitCode !== 0 || request.isStdoutTruncated || request.isStderrTruncated) {
        return report(result, `Context unchanged: the skill's compaction request could not be checked. ${request.stderr}`);
      }
      const pending = JSON.parse(request.stdout);
      if (pending?.pending !== true || e.reason !== "answer" || e.isAborted) return result;
      compacting = true;
      installed = undefined;
      const replacement = await $.session.compact({ instructions: "apana:compact-session" });
      const replacementReport = installed as Prepared | undefined;
      const status = replacement.skip !== undefined ? `Context unchanged: ${replacement.skip}` :
        replacementReport === undefined ? "The compact-session bridge did not supply a replacement." :
        `Context compacted in the same session. Characters (measured; n=1): ${replacementReport.beforeChars} -> ${replacementReport.afterChars}. Recoverable history: ${replacementReport.artifact}`;
      return report(result, status);
    } catch (error) {
      return report(result, `Context replacement failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      compacting = false;
      installed = undefined;
    }
  }).catch(($, e) => {
    active = false;
    compacting = false;
    installed = undefined;
    return report({ text: e.answer }, "compact-session failed; no fallback compaction was requested.");
  });

  on("session.compact", { instructions: "apana:compact-session" }, async ($, e, next) => {
    if (e.agentId !== undefined || !compacting) return next(e);
    try {
      const sessionId = await $.session.id();
      const messages = await $.session.messages({ as: "api" });
      if (messages.length === 0) return { skip: "There is no active conversation to compact." };
      const result = await $.process.run([
        "python3", "-I", `${$.plugin.root}/skills/compact-session/scripts/compact_session.py`,
      ], {
        stdin: JSON.stringify({ sessionId, messages }),
        timeoutMs: 600000,
      });
      if (result.exitCode !== 0) return { skip: `Preparing compact context failed: ${result.stderr}` };
      if (result.isStdoutTruncated || result.isStderrTruncated) return { skip: "The compactor output was truncated." };
      const output: unknown = JSON.parse(result.stdout);
      if (!prepared(output)) return { skip: "The compactor returned an invalid replacement." };
      if (output.afterChars >= output.beforeChars) {
        return { skip: `The verified replacement would not reduce context. Prepared transcript characters (measured; n=1): ${output.beforeChars} -> ${output.afterChars}. The current context was kept.` };
      }
      installed = output;
      return { messages: [{ role: "user", text: output.text, toolUses: [] }] };
    } catch (error) {
      return { skip: `Preparing compact context failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }).catch(() => ({ skip: "compact-session failed; the standard summarizer was not requested." }));
};
