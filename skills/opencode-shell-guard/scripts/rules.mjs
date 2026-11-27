// The rules of opencode-shell-guard and OpenCode's way of matching them, shared by the OpenCode plugin that applies them
// (plugin/server.js) and by shell-guard.mjs, which sets the plugin up. No imports, so the plugin can load its text as a data: URL.

/** The historical grep rules, also used by the installer to remove that exact old configuration. */
export const RULES = Object.freeze([
  ["*grep *", "deny"],
  ["git *grep *", "allow"],
  ["pgrep *", "allow"],
  ["rg *", "allow"],
  ...["echo", "printf", "cat", "tee", "gh", "python3", "node", "sed", "perl"].map((command) => [`${command} *`, "allow"]),
].map(([resource, effect]) => Object.freeze({ action: "shell", resource, effect })));

export const FIND_SAMPLE = "find . -type f -name '*.kt'";
export const FD_EXAMPLE = "fd -HI -s -t f -g '*.kt' .";

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

/**
 * Whether the grep rule refuses a shell command: it still does with every `pgrep` in it set aside (upper case, which
 * the case-sensitive match does not take for grep). So pgrep inside another command (`ps -p $(pgrep x)`, refused live) passes, while a
 * pgrep only lifts a refusal: `pgrep -f 'grep x'` stays allowed by its own rule, `ps -p $(pgrep x) $(grep -l y f)` stays refused.
 */
export function refuses(command) {
  return decide(RULES, command) === "deny" && decide(RULES, command.replaceAll("pgrep", "PGREP")) === "deny";
}

const SHELL_TOKEN = new RegExp([
  /(?<space>(?:[ \t]+|\\\n)+)/,
  /(?<comment>#[^\n]*)/,
  /(?<separator>\n|&&|\|\||\|&|;|&(?!>)|\|)/,
  /(?<redirect>\d*(?:<<<|<<-?|<>|<&|>>|>&|>\||>|<)|&>>?)/,
  /(?<word>(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\\[\s\S]|[^ \t\n'"`\\;|&<>()])+)/,
].map((pattern) => pattern.source).join("|"), "y");

function hasNestedExpansion(word) {
  for (const { groups } of word.matchAll(/'[^']*'|\\[\s\S]|"(?<double>(?:\\[\s\S]|[^"\\])*)"|(?<expansion>\$[({])/g)) {
    if (groups.expansion || /(?<!\\)(?:\\\\)*\$[({]/.test(groups.double ?? "")) return true;
  }
  return false;
}

// OpenCode already separates top-level pipelines and substitutions; `sh -c` arrives as one resource. Keep quoting in
// the tokens so a quoted operator, comment or assignment prefix never acquires a special meaning.
function* shellCommands(command) {
  let words = [];
  let redirectTarget = false;
  let heredoc = false;
  let offset = 0;
  while (offset < command.length) {
    SHELL_TOKEN.lastIndex = offset;
    const match = SHELL_TOKEN.exec(command);
    if (!match) {
      if (!redirectTarget && words.length === 1 && command[offset] === "(") return; // A function header.
      break;
    }
    offset = SHELL_TOKEN.lastIndex;
    const { separator, redirect, word } = match.groups;
    if (separator) {
      if (words.length) yield words;
      if (heredoc && separator === "\n") return; // The following lines can be here-document data.
      words = [];
      redirectTarget = false;
    } else if (redirect) {
      redirectTarget = true;
      heredoc ||= /^\d*<<-?$/.test(redirect);
    } else if (word) {
      if (!redirectTarget) words.push(word);
      redirectTarget = false;
      // Nested expansions can contain their own quotes; their apparent separators aren't part of this command.
      if (hasNestedExpansion(word)) break;
    }
  }
  if (words.length) yield words;
}

/** Decode a shell word without expanding it; null means it doesn't have a statically known value. */
function literal(word) {
  if (word === undefined) return null;
  let dynamic = false;
  const value = word.replace(/'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])|[$`~*?\[]/g, (_part, single, double, escaped) => {
    if (single !== undefined) return single;
    if (double !== undefined) {
      return double.replace(/\\(["\\$`\n])|[$`]/g, (part, quoted) => {
        if (quoted === undefined) dynamic = true;
        return quoted === "\n" ? "" : quoted ?? part;
      });
    }
    if (escaped !== undefined) return escaped === "\n" ? "" : escaped;
    dynamic = true;
    return "";
  });
  return dynamic ? null : value;
}

// An unfamiliar option may take the next word as its argument. In that case there is no known command position.
function afterOptions(words, start, flags, valueOptions) {
  for (let index = start; index < words.length; index += 1) {
    const option = literal(words[index]);
    if (option === "--") return index + 1;
    if (!option?.startsWith("-") || option === "-") return index;
    if (option.startsWith("--")) {
      const equal = option.indexOf("=");
      const name = equal === -1 ? option : option.slice(0, equal);
      if (valueOptions.includes(name)) {
        if (equal === -1) index += 1;
      } else if (!flags.includes(option)) return -1;
      continue;
    }
    for (let letter = 1; letter < option.length; letter += 1) {
      const name = `-${option[letter]}`;
      if (valueOptions.includes(name)) {
        if (letter === option.length - 1) index += 1;
        break;
      }
      if (!flags.includes(name)) return -1;
    }
  }
  return words.length;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function delegatedCommand(name, words, start) {
  switch (name) {
    case "command":
      return afterOptions(words, start, ["-p"], []);
    case "env": {
      let index = afterOptions(words, start, ["-i", "--ignore-environment", "-v", "--debug"], ["-u", "--unset", "-C", "--chdir"]);
      if (index < 0) return -1;
      if (literal(words[index]) === "-") index += 1;
      while (ASSIGNMENT.test(words[index] ?? "") || ASSIGNMENT.test(literal(words[index]) ?? "")) index += 1;
      return index;
    }
    case "timeout": {
      const duration = afterOptions(words, start, ["--foreground", "--preserve-status", "-v", "--verbose"],
        ["-k", "--kill-after", "-s", "--signal"]);
      return duration < 0 ? -1 : duration + 1;
    }
    case "xargs":
      return afterOptions(words, start,
        ["-0", "-o", "-p", "-r", "-t", "-x", "--null", "--open-tty", "--interactive", "--no-run-if-empty", "--verbose", "--exit"],
        ["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "--arg-file", "--delimiter", "--eof", "--replace",
          "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]);
    default:
      return -1;
  }
}

function shellScript(words, start) {
  for (let index = start; index < words.length; index += 1) {
    const option = literal(words[index]);
    if (["--login", "--noprofile", "--norc", "--posix", "--restricted"].includes(option)) continue;
    if (!/^[-+](?:[abcefhiklmnprtuvxBCEHPT]+[oO]?|[oO])$/.test(option ?? "")) break;
    if (/[oO]$/.test(option)) index += 1;
    if (option.startsWith("-") && option.includes("c")) return literal(words[index + 1]);
  }
  return null;
}

function runsFind(resource) {
  const scripts = [resource];
  while (scripts.length) {
    for (const words of shellCommands(scripts.pop())) {
      let index = 0;
      while (ASSIGNMENT.test(words[index] ?? "")) index += 1;
      while (index >= 0 && index < words.length) {
        const name = literal(words[index])?.split("/").at(-1);
        if (name === "find") return true;
        if (name === "bash" || name === "sh") {
          const script = shellScript(words, index + 1);
          if (script !== null) scripts.push(script);
          break;
        }
        index = delegatedCommand(name, words, index + 1);
      }
    }
  }
  return false;
}

function shownCommand(command) {
  return command.length > 120 ? `${command.slice(0, 117)}...` : command;
}

const grepAdvice = [
  "grep is not allowed in shell commands here (the text `grep ` was found).",
  "Rewrite the command with `rg` (also to filter output: `... | rg pattern`), `git grep` in a repository, or the grep tool;",
  "do not retry it or ask the user. In rg, `-E` is the encoding, not extended regex: `grep -E 'a|b' f` is `rg 'a|b' f`.",
].join(" ");

/** What a grep denial gets back, instead of OpenCode's bare `Permission denied: shell`. */
export function refusal(command) {
  return `opencode-shell-guard refused \`${shownCommand(command)}\`: ${grepAdvice}`;
}

function findRefusal(command, alsoGrep) {
  const message = `opencode-shell-guard refused \`${shownCommand(command)}\`: find is not allowed in shell commands here. ` +
    `Rewrite the search with \`fd\` instead of retrying. For example, \`${FIND_SAMPLE}\` becomes \`${FD_EXAMPLE}\`. ` +
    "Check `fd --help` for options that need a different expression.";
  return alsoGrep ? `${message} ${grepAdvice}` : message;
}

/** The plugin's permission.evaluate hook: a shell request with one denied command is refused, with the reason as its message. */
export function evaluate(event) {
  if (event?.action !== "shell" || event.effect === "deny" || !Array.isArray(event.resources)) return;
  for (const command of event.resources) {
    if (typeof command !== "string") continue;
    const find = runsFind(command);
    const grep = refuses(command);
    if (!find && !grep) continue;
    event.effect = "deny";
    event.message = find ? findRefusal(command, grep) : refusal(command);
    return;
  }
}
