// The rules of opencode-shell-guard and OpenCode's way of matching them, shared by the OpenCode plugin that applies them
// (plugin/server.js) and by shell-guard.mjs, which sets the plugin up. No imports, so the plugin loads it as it is.

/** In order, the last matching rule wins: one deny for any command whose text holds `grep `, then the commands that may hold the text without running grep. */
export const RULES = Object.freeze([
  ["*grep *", "deny"],
  ["git *grep *", "allow"],
  ["pgrep *", "allow"],
  ["rg *", "allow"],
  ...["echo", "printf", "cat", "tee", "gh", "python3", "node", "sed", "perl"].map((command) => [`${command} *`, "allow"]),
].map(([resource, effect]) => Object.freeze({ action: "shell", resource, effect })));

/** OpenCode's Wildcard.match (packages/core/src/util/wildcard.ts, the same in the 2.4.2 binary) off Windows: `*` is any text, `?` one character, a trailing ` *` also matches nothing. */
export function match(input, pattern) {
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", "s").test(input.replaceAll("\\", "/"));
}

/** The effect of the last rule that matches one shell command (one part of a pipeline or list, as OpenCode splits it), or "allow" when none does. */
export function decide(rules, command) {
  const valid = (rule) => rule && typeof rule.action === "string" && typeof rule.resource === "string";
  return rules.findLast((rule) => valid(rule) && match("shell", rule.action) && match(command, rule.resource))?.effect ?? "allow";
}

/** What a refused command gets back, instead of OpenCode's bare `Permission denied: shell`. */
export function refusal(command) {
  const shown = command.length > 120 ? `${command.slice(0, 117)}...` : command;
  return [
    `opencode-shell-guard refused \`${shown}\`: grep is not allowed in shell commands here (the text \`grep \` was found).`,
    "Rewrite the command with `rg` (also to filter output: `... | rg pattern`), `git grep` in a repository, or the grep tool;",
    "do not retry it or ask the user. In rg, `-E` is the encoding, not extended regex: `grep -E 'a|b' f` is `rg 'a|b' f`.",
  ].join(" ");
}

/** The plugin's permission.evaluate hook: a shell request with one denied command is refused, with the reason as its message. */
export function evaluate(event) {
  if (event?.action !== "shell" || event.effect === "deny" || !Array.isArray(event.resources)) return;
  const denied = event.resources.find((command) => typeof command === "string" && decide(RULES, command) === "deny");
  if (denied === undefined) return;
  event.effect = "deny";
  event.message = refusal(denied);
}
