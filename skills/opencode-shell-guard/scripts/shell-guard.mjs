#!/usr/bin/env node
// Sets up opencode-shell-guard in OpenCode's global config folder: bash as "shell" in the config, the plugin that refuses grep and find in
// shell commands linked into plugins/, and a marked note in the AGENTS.md beside the config. It also removes the 13 grep rules that
// earlier versions wrote into "permissions": a rule there that denies ends OpenCode's check before any plugin runs, so the refusal would
// name no reason. The config is edited as text, so comments and the order of the other keys stay; it is read as OpenCode reads it (JSONC:
// comments, trailing commas). Node stdlib only.
import { spawnSync } from "node:child_process";
import {
  accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FD_EXAMPLE, FIND_SAMPLE, RULES, decide } from "./rules.mjs";

/** Commands the plugin refuses; the check warns when "permissions" refuses one itself, before the plugin can say why. */
export const SAMPLES = Object.freeze(["grep -n x file", "bash -c 'echo hi | grep hi'", "/usr/bin/grep x file", FIND_SAMPLE]);

const NOTE_START = "<!-- opencode-shell-guard -->";
const NOTE_END = "<!-- /opencode-shell-guard -->";

/** The block written to AGENTS.md next to the config, so the model uses rg and fd from the first call. */
export const NOTE = [
  NOTE_START,
  "- OpenCode refuses every shell command that runs grep: any part of it whose text contains `grep ` (grep and a space), also after `|`",
  "  or `&&`, inside `bash -c '...'`, and as `/usr/bin/grep`, `egrep` or `fgrep`. The refusal starts with `opencode-shell-guard refused`.",
  "  Do not retry the command or ask the user about it: rewrite it with `rg` (also to filter output: `... | rg pattern`), `git grep` in a",
  "  repository, or the `grep` tool. In `rg`, `-E` is the encoding, not extended regex: `grep -E 'a|b' f` is `rg 'a|b' f`. Commands that",
  "  start with `rg`, `git`, `pgrep`, `echo`, `printf`, `cat`, `tee`, `gh`, `python3`, `node`, `sed` or `perl` may contain the text `grep `,",
  "  for example in a quoted argument.",
  "- For filesystem searches, use `fd`. OpenCode refuses `find` as a command, including through `command`, `env`, `timeout`, `xargs`",
  `  and literal commands in \`bash -c\` or \`sh -c\`. For example, rewrite \`${FIND_SAMPLE}\` as \`${FD_EXAMPLE}\`.`,
  NOTE_END,
].join("\n");

const LINK_NAME = "opencode-shell-guard";
const OWN_PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const BASH_CANDIDATES = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"];
const SCHEMA = "https://opencode.ai/config.json";

export class JsoncError extends Error {}

/** Parses a JSONC object and keeps where each top-level member and each comment is, so a member can be replaced in place. */
export function parseJsonc(text) {
  let i = 0;
  const comments = [];
  const fail = (message) => {
    const before = text.slice(0, i).split("\n");
    throw new JsoncError(`${message} at line ${before.length}, column ${before.at(-1).length + 1}`);
  };
  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "﻿") i++;
      else if (c === "/" && text[i + 1] === "/") {
        const start = i;
        const end = text.indexOf("\n", i);
        i = end < 0 ? text.length : end;
        comments.push([start, i]);
      } else if (c === "/" && text[i + 1] === "*") {
        const start = i;
        const end = text.indexOf("*/", i + 2);
        if (end < 0) fail("unclosed comment");
        i = end + 2;
        comments.push([start, i]);
      } else return;
    }
  };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== "\n") {
      if (text[i] === "\\") i += 2;
      else if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    fail("unclosed string");
  };
  const value = () => {
    skip();
    if (text[i] === "{") return object().value;
    if (text[i] === "[") return array();
    if (text[i] === '"') return string();
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!literal) fail("unexpected character");
    i += literal[0].length;
    return JSON.parse(literal[0]);
  };
  const array = () => {
    i++;
    const out = [];
    for (;;) {
      skip();
      if (text[i] === "]") return i++, out;
      out.push(value());
      skip();
      if (text[i] === ",") i++;
      else if (text[i] === "]") return i++, out;
      else fail("expected , or ]");
    }
  };
  const object = () => {
    const open = i++;
    const out = Object.create(null);
    const members = [];
    for (;;) {
      skip();
      if (text[i] === "}") return i++, { value: out, members, open };
      if (text[i] !== '"') fail("expected a key");
      const keyStart = i;
      const key = string();
      skip();
      if (text[i] !== ":") fail("expected :");
      i++;
      skip();
      const valueStart = i;
      out[key] = value();
      const member = { key, keyStart, valueStart, valueEnd: i, commaEnd: null };
      members.push(member);
      skip();
      if (text[i] === ",") member.commaEnd = ++i;
      else if (text[i] === "}") return i++, { value: out, members, open };
      else fail("expected , or }");
    }
  };
  skip();
  if (text[i] !== "{") fail("the config is not an object");
  const root = object();
  skip();
  if (i < text.length) fail("unexpected text after the object");
  for (const key of ["shell", "permissions"]) {
    if (root.members.filter((m) => m.key === key).length > 1) throw new JsoncError(`"${key}" appears more than once`);
  }
  return { ...root, comments };
}

const sameRule = (a, b) => a && typeof a === "object" && Object.keys(a).length === 3 && a.action === b.action && a.resource === b.resource && a.effect === b.effect;
const isGuardRule = (rule) => RULES.some((guard) => sameRule(rule, guard));

/** The user's own rules in their order: the list without the 13 grep rules that earlier versions of this skill wrote. */
export function ownRules(current = []) {
  return current.filter((rule) => !isGuardRule(rule));
}

function bashMajor(path) {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return null;
  }
  const run = spawnSync(path, ["-c", 'echo "${BASH_VERSINFO[0]}"'], { encoding: "utf8", timeout: 5000 });
  const major = Number.parseInt(run.stdout, 10);
  return run.status === 0 && Number.isInteger(major) ? major : null;
}

/** The shell to write: --shell, else an existing bash, else the first bash 4+ found, else the first bash found. */
function chooseShell(current, forced, out) {
  if (forced) {
    if (bashMajor(forced) === null) throw new Error(`--shell ${forced} is not an executable bash`);
    return forced;
  }
  if (typeof current === "string" && basename(current) === "bash" && bashMajor(current) !== null) return current;
  const found = BASH_CANDIDATES.map((path) => [path, bashMajor(path)]).filter(([, major]) => major !== null);
  const modern = found.find(([, major]) => major >= 4);
  if (modern) return modern[0];
  if (found.length) {
    out("warn", `only bash ${found[0][1]} found (${found[0][0]}); install a newer bash (for example with Homebrew) for associative arrays and mapfile`);
    return found[0][0];
  }
  throw new Error(`no bash found in ${BASH_CANDIDATES.join(", ")}; pass --shell <path to bash>`);
}

function indentOf(text, root) {
  const first = root.members[0];
  if (!first) return "  ";
  const lineStart = text.lastIndexOf("\n", first.keyStart) + 1;
  const indent = text.slice(lineStart, first.keyStart);
  return /^[ \t]+$/.test(indent) ? indent : "  ";
}

const formatRule = (rule) => (rule && typeof rule === "object" && !Array.isArray(rule)
  ? `{ ${Object.entries(rule).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`
  : JSON.stringify(rule));
const formatRules = (rules, indent) => `[\n${rules.map((rule) => `${indent}${indent}${formatRule(rule)}`).join(",\n")}\n${indent}]`;

/** Sets one top-level member: replaces its value in place, or adds it after `after` (or first) when it is missing. */
function setMember(text, key, valueText, after) {
  const root = parseJsonc(text);
  const member = root.members.find((m) => m.key === key);
  if (member) return text.slice(0, member.valueStart) + valueText + text.slice(member.valueEnd);
  const indent = indentOf(text, root);
  const line = `${JSON.stringify(key)}: ${valueText}`;
  const previous = root.members.findLast((m) => after.includes(m.key));
  if (previous?.commaEnd) return `${text.slice(0, previous.commaEnd)}\n${indent}${line},${text.slice(previous.commaEnd)}`;
  if (previous) return `${text.slice(0, previous.valueEnd)},\n${indent}${line}${text.slice(previous.valueEnd)}`;
  const at = root.open + 1;
  return `${text.slice(0, at)}\n${indent}${line}${root.members.length ? "," : "\n"}${text.slice(at)}`;
}

/** Removes one top-level member and its comma, and its line when nothing else is on it; a comment after the previous member stays. */
function removeMember(text, key) {
  const root = parseJsonc(text);
  const index = root.members.findIndex((m) => m.key === key);
  const member = root.members[index];
  const lineStart = text.lastIndexOf("\n", member.keyStart - 1) + 1;
  const ownLine = lineStart > 0 && /^[ \t]*$/.test(text.slice(lineStart, member.keyStart));
  // On a line shared with other members, the spaces on one side of the member go with it, so no double space is left.
  const trimEnd = (part) => (ownLine ? part : part.replace(/[ \t]+$/, ""));
  if (member.commaEnd) {
    const rest = /^[ \t]*\r?\n/.exec(text.slice(member.commaEnd));
    if (ownLine && rest) return text.slice(0, lineStart) + text.slice(member.commaEnd + rest[0].length);
    return text.slice(0, member.keyStart) + text.slice(member.commaEnd).replace(/^[ \t]+/, "");
  }
  const lineBreak = ownLine ? lineStart - (text[lineStart - 2] === "\r" ? 2 : 1) : member.keyStart;
  const previous = root.members[index - 1];
  if (!previous) return trimEnd(text.slice(0, Math.max(lineBreak, root.open + 1))) + text.slice(member.valueEnd);
  return text.slice(0, previous.commaEnd - 1) + trimEnd(text.slice(previous.commaEnd, Math.max(lineBreak, previous.commaEnd))) + text.slice(member.valueEnd);
}

export function configFile(configDir) {
  for (const name of ["opencode.jsonc", "opencode.json"]) if (existsSync(join(configDir, name))) return join(configDir, name);
  return join(configDir, "opencode.jsonc");
}

/** Where the note is in an AGENTS.md text, or null; a lone or doubled marker throws, so nothing is guessed. */
function findNote(text) {
  const start = text.indexOf(NOTE_START);
  const end = text.indexOf(NOTE_END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || text.includes(NOTE_START, start + 1) || text.includes(NOTE_END, end + 1)) {
    throw new Error(`the markers ${NOTE_START} and ${NOTE_END} are not one pair in this order`);
  }
  return { start, end: end + NOTE_END.length };
}

/** The AGENTS.md text with the current note: an older one replaced in place, else the note added at the end after a blank line. */
export function withNote(text) {
  const at = findNote(text);
  if (at) return text.slice(0, at.start) + NOTE + text.slice(at.end);
  if (!text) return `${NOTE}\n`;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${text.endsWith("\n\n") ? "" : "\n"}${NOTE}\n`;
}

/** The folder the link points to: this skill's plugin/, or the marketplace clone's when this copy is in the plugin cache, which every update replaces. */
export function pluginSource(own, home, out) {
  if (`${own}${sep}`.includes(`${sep}${join("plugins", "cache")}${sep}`)) {
    const clone = join(home, ".claude", "plugins", "marketplaces", "apana-private", "skills", "opencode-shell-guard", "plugin");
    if (existsSync(join(clone, "server.js"))) return clone;
    out("warn", `this copy of the skill is in the plugin cache and the marketplace clone has no ${clone}, so the link will break when the plugin is updated; update the marketplace (\`claude plugin marketplace update apana-private\`) and run this again`);
  }
  return own;
}

/** What is at the link's place: nothing, something that is not a link, or a link and the target it names. */
function linkState(link) {
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return { kind: "missing" };
  }
  return stat.isSymbolicLink() ? { kind: "link", target: readlinkSync(link) } : { kind: "other" };
}

/** Writes through a symlink, after a timestamped backup of an existing file, by a rename so no reader sees half a file. */
function replaceFile(file, exists, text, newMode, out) {
  const target = exists ? realpathSync(file) : file;
  const mode = exists ? statSync(target).mode & 0o777 : newMode;
  if (exists) {
    const backup = `${file}.bak-shell-guard-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}`;
    copyFileSync(target, backup);
    out("info", `backup: ${backup}`);
  }
  const temporary = `${target}.tmp-shell-guard-${process.pid}`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, target);
  out("ok", `wrote ${file}`);
}

/** Points the link at the plugin folder, replacing an older link by a rename, so OpenCode never sees the place empty. */
function replaceLink(link, target, out) {
  mkdirSync(dirname(link), { recursive: true });
  const temporary = `${link}.tmp-${process.pid}`;
  symlinkSync(target, temporary);
  renameSync(temporary, link);
  out("ok", `linked ${link} -> ${target}`);
}

function reportNote(configDir, out) {
  const agents = join(configDir, "AGENTS.md");
  if (!existsSync(agents)) return out("warn", `${agents} does not exist, so the model is not told to use rg and fd`);
  const text = readFileSync(agents, "utf8");
  let at;
  try {
    at = findNote(text);
  } catch (error) {
    return out("fail", `${agents}: ${error.message}`);
  }
  if (!at) out("warn", `${agents} has no note telling the model to use rg and fd`);
  else if (text.slice(at.start, at.end) !== NOTE) out("warn", `the note in ${agents} is not the current one`);
  else out("ok", `${agents} tells the model to use rg instead of grep and fd instead of find`);
}

function reportPlugin(link, source, out) {
  const state = linkState(link);
  if (state.kind === "missing") return out("warn", `${link} is missing, so OpenCode does not refuse grep or find in shell commands`);
  if (state.kind === "other") return out("fail", `${link} exists and is not a link`);
  const target = resolve(dirname(link), state.target);
  if (!existsSync(join(target, "server.js"))) return out("warn", `${link} points to ${state.target}, which has no server.js, so OpenCode does not refuse grep or find in shell commands`);
  if (realpathSync(target) !== realpathSync(source)) return out("warn", `${link} points to ${state.target}, not to ${source}`);
  out("ok", `${link} -> ${state.target}: plugin files for the grep and find refusals are linked`);
}

function report(config, file, configDir, link, source, out) {
  const shell = config.shell;
  if (typeof shell !== "string") out("warn", `"shell" is not set in ${file}; OpenCode then uses $SHELL or /bin/zsh`);
  else if (basename(shell) !== "bash") out("warn", `"shell" is ${shell}, not bash`);
  else {
    const major = bashMajor(shell);
    if (major === null) out("fail", `"shell" is ${shell}, which is not an executable bash`);
    else out(major >= 4 ? "ok" : "warn", `"shell" is ${shell} (bash ${major})`);
  }
  reportPlugin(link, source, out);
  const rules = Array.isArray(config.permissions) ? config.permissions : [];
  if (config.permissions !== undefined && !Array.isArray(config.permissions)) out("fail", `"permissions" is not an array of rules`);
  const leftover = rules.filter(isGuardRule).length;
  if (leftover) out("warn", `"permissions" still holds ${leftover} of the ${RULES.length} grep rules that earlier versions of this skill wrote; the plugin applies them now`);
  const early = SAMPLES.filter((command) => decide(rules, command) === "deny");
  if (early.length) out("warn", `"permissions" refuses ${early.map((command) => JSON.stringify(command)).join(", ")} itself, before the plugin runs, so the refusal says only \`Permission denied: shell\``);
  if (!leftover && !early.length) out("ok", `"permissions" leaves the grep and find samples to the plugin`);
  if (config.permission !== undefined) out("warn", `the deprecated V1 key "permission" is set too; its rules were not checked`);
  const other = join(configDir, basename(file) === "opencode.jsonc" ? "opencode.json" : "opencode.jsonc");
  if (existsSync(other)) {
    try {
      const keys = ["shell", "permissions"].filter((key) => parseJsonc(readFileSync(other, "utf8")).value[key] !== undefined);
      if (keys.length) out("warn", `${other} also sets ${keys.join(" and ")}; OpenCode combines both files, check with \`opencode debug config\``);
    } catch (error) {
      out("warn", `${other} is not valid JSON or JSONC: ${error.message}`);
    }
  }
  reportNote(configDir, out);
}

export function run(argv, { env = process.env, platform = process.platform, home = homedir(), ownPlugin = OWN_PLUGIN } = {}) {
  const lines = [];
  const out = (level, message) => lines.push(`${level} ${message}`);
  const finish = (code) => ({ code, output: lines.join("\n") + (lines.length ? "\n" : "") });
  const stop = (code, message) => (out("fail", message), finish(code));
  const args = { check: false, dryRun: false, configDir: null, shell: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if ((arg === "--config-dir" || arg === "--shell") && argv[i + 1]) args[arg === "--shell" ? "shell" : "configDir"] = argv[++i];
    else return stop(2, `usage: shell-guard.mjs [--check | --dry-run] [--config-dir DIR] [--shell PATH]; unknown or incomplete argument ${arg}`);
  }
  if (args.check && args.dryRun) return stop(2, "usage: --check and --dry-run cannot be used together");
  if (platform === "win32") return stop(1, "Windows is not supported: OpenCode's shell there is not bash by default");

  const configDir = args.configDir ?? join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const file = configFile(configDir);
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : null;
  let parsed = null;
  try {
    if (exists) parsed = parseJsonc(text);
  } catch (error) {
    return stop(1, `${file} is not valid JSON or JSONC: ${error.message}; nothing was changed`);
  }
  const config = parsed?.value ?? {};
  const link = join(configDir, "plugins", LINK_NAME);
  const source = pluginSource(ownPlugin, home, out);
  if (args.check) {
    if (!exists) out("warn", `${file} does not exist`);
    report(config, file, configDir, link, source, out);
    return finish(lines.some((line) => !line.startsWith("ok ")) ? 1 : 0);
  }

  if (config.permissions !== undefined && !Array.isArray(config.permissions)) return stop(1, `"permissions" in ${file} is not an array; nothing was changed`);
  const agents = join(configDir, "AGENTS.md");
  const agentsText = existsSync(agents) ? readFileSync(agents, "utf8") : null;
  let agentsNext;
  try {
    agentsNext = withNote(agentsText ?? "");
  } catch (error) {
    return stop(1, `${agents}: ${error.message}; nothing was changed`);
  }
  const state = linkState(link);
  if (state.kind === "other") return stop(1, `${link} exists and is not a link; nothing was changed`);
  let shell;
  try {
    shell = chooseShell(config.shell, args.shell, out);
  } catch (error) {
    return stop(1, error.message);
  }
  let next = text ?? `{\n  "$schema": ${JSON.stringify(SCHEMA)}\n}\n`;
  const indent = indentOf(next, parseJsonc(next));
  if (config.shell !== shell) next = setMember(next, "shell", JSON.stringify(shell), ["$schema"]);
  const own = ownRules(config.permissions);
  const removed = Array.isArray(config.permissions) ? config.permissions.length - own.length : 0;
  if (removed) {
    const member = parsed.members.find((m) => m.key === "permissions");
    if (parsed.comments.some(([start, end]) => start < member.valueEnd && end > member.valueStart)) out("warn", `the comments inside "permissions" are not kept (they stay in the backup)`);
    next = own.length ? setMember(next, "permissions", formatRules(own, indent), []) : removeMember(next, "permissions");
  }
  const configChanged = next !== text;
  const noteChanged = agentsNext !== agentsText;
  const linkChanged = state.kind !== "link" || state.target !== source;
  if (!configChanged && !noteChanged && !linkChanged) {
    out("ok", `nothing to change in ${file}, ${agents} and ${link}`);
    report(config, file, configDir, link, source, out);
    return finish(0);
  }
  if (linkChanged) out("info", `${link} -> ${source}: ${state.kind === "missing" ? "a new link" : `replaces the link to ${state.target}`} (OpenCode loads the plugin within about 10 s, without a restart)`);
  if (config.shell !== shell) out("info", `"shell": ${config.shell === undefined ? "not set" : JSON.stringify(config.shell)} -> ${JSON.stringify(shell)}`);
  if (removed) {
    out("info", own.length
      ? `"permissions": the ${removed} grep rule(s) are removed, the plugin applies them now; your ${own.length} rule(s) stay in their order`
      : `"permissions" is removed: it held only the ${removed} grep rule(s), which the plugin applies now`);
  }
  if (noteChanged) {
    const how = agentsText === null ? "a new file with the note" : findNote(agentsText) ? "the note is replaced by the current one" : "the note is added at the end";
    out("info", `${agents}: ${how} (use rg and fd); the rest of the file stays`);
  }
  if (args.dryRun) {
    if (noteChanged) for (const line of NOTE.split("\n")) out("info", `| ${line}`);
    out("info", "--dry-run: nothing was written");
    return finish(0);
  }

  // The link first: if it cannot be made, the config keeps the rules that still refuse grep, without a reason.
  try {
    if (linkChanged) replaceLink(link, source, out);
    mkdirSync(configDir, { recursive: true });
    if (noteChanged) replaceFile(agents, agentsText !== null, agentsNext, 0o644, out);
    if (configChanged) replaceFile(file, exists, next, 0o600, out);
  } catch (error) {
    return stop(1, `writing stopped: ${error.message}`);
  }
  report(parseJsonc(next).value, file, configDir, link, source, out);
  return finish(lines.some((line) => line.startsWith("fail ")) ? 1 : 0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, output } = run(process.argv.slice(2));
  process.stdout.write(output);
  process.exitCode = code;
}
