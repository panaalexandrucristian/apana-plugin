// What a user prompt asks of apana's modes, read from its text and its skill mentions. Pure: nothing is written, so the prompt
// hook (which may run more than once for one prompt, and for a prompt that is never admitted) can store the result in the
// message's metadata and nothing else. The modes are switched on later, from the admitted message (see modes.mjs).
import { isBareCommand } from "../class-graph-nudge/classify.mjs";

export const MAX_INTENT_TEXT = 8192;
const KINDS = Object.freeze(["scope", "jev", "class-graph"]);

const SCOPE = /^\s*\/apana:scope(?:\s|$)/;
const JEV = /^\s*\/apana:jev-decision-loop(?:\s|$)/;

/** {v: 1, kind, text} for a prompt that starts a mode, else null. `skills` are the ids of the skills the user attached. */
export function deriveIntent(text, skills = []) {
  if (typeof text !== "string" || text.length > MAX_INTENT_TEXT) return null;
  if (SCOPE.test(text)) return { v: 1, kind: "scope", text: text.trim() };
  if (JEV.test(text) || skills.includes("jev-decision-loop")) return { v: 1, kind: "jev", text: text.trim() };
  if (isBareCommand(text)) return { v: 1, kind: "class-graph", text: text.trim() };
  return null;
}

/** The intent stored in a message's metadata, validated again because metadata can come from any client; null when it is not one. */
export function storedIntent(metadata) {
  const value = metadata?.apana;
  if (value === null || typeof value !== "object" || value.v !== 1 || !KINDS.includes(value.kind)) return null;
  if (typeof value.text !== "string" || value.text.length > MAX_INTENT_TEXT) return null;
  return { v: 1, kind: value.kind, text: value.text };
}
