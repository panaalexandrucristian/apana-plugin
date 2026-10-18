// logic-test-debug, Claude Code adapter. Only an enabled UserPromptSubmit whose prompt the local check finds to be
// about code adds the directive; every other event and prompt adds nothing. It never calls a model or a tool and
// stores nothing. Failures are the caller's to isolate (scripts/apana-hook.mjs loads this module by a guarded
// dynamic import).
import { classifyCodePrompt, logicEnabled, LOGIC_DIRECTIVE } from "./check.mjs";

const EVENT = "UserPromptSubmit";

/**
 * The directive output for one hook call, or null. `input.prompt` is the prompt text of the Claude Code
 * UserPromptSubmit payload (the prompt check reads the same field); a missing or non-string value gives null.
 */
export function handleLogicHook(event, input, env = process.env) {
  if (event !== EVENT) return null;
  if (!logicEnabled(env)) return null;
  const prompt = input?.prompt;
  if (typeof prompt !== "string") return null;
  if (!classifyCodePrompt(prompt).activate) return null;
  return { hookSpecificOutput: { hookEventName: EVENT, additionalContext: LOGIC_DIRECTIVE } };
}

/**
 * Add the directive to the output the other subsystems already produced, without mutating it: every existing
 * field is kept and an existing additionalContext is joined with the new one by a newline. An existing output of
 * another hook event, or one that is not a plain object, is returned unchanged.
 */
export function composeOutput(existing, added) {
  if (!added) return existing ?? null;
  if (existing == null) return added;
  if (typeof existing !== "object" || Array.isArray(existing)) return existing;
  const specific = existing.hookSpecificOutput;
  if (specific != null && (typeof specific !== "object" || Array.isArray(specific))) return existing;
  if (specific?.hookEventName !== undefined && specific.hookEventName !== EVENT) return existing;
  const previous = specific?.additionalContext;
  if (previous !== undefined && typeof previous !== "string") return existing;
  const joined = previous ? `${previous}\n${added.hookSpecificOutput.additionalContext}` : added.hookSpecificOutput.additionalContext;
  return { ...existing, hookSpecificOutput: { ...(specific ?? {}), hookEventName: EVENT, additionalContext: joined } };
}
