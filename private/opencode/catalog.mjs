// What the OpenCode side of apana offers: an explicit list of skills (the rest are tools of Claude Code and stay there), their
// text adapted to OpenCode's tools, and the Markdown commands. Read once at plugin setup: an edit of a SKILL.md or a command
// file reaches OpenCode when the plugin is set up again (a restart), because the registry does not watch these files.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Skills that run in OpenCode. A new directory under skills/ must be added here or to CLAUDE_ONLY_SKILLS (a test enforces it). */
export const OPENCODE_SKILLS = Object.freeze([
  "android-ui-step", "assess-complexity", "class-graph", "code-rag", "code-rag-setup", "compact-handoff", "compact-session",
  "explica-clar", "harness2", "install-opencode-auto", "jev-decision-loop", "logic-test-debug", "opencode-plugin-skills-sync", "opencode-shell-guard",
  "pr-convention-check", "review-diff", "review-plan", "scope", "uninstall-opencode-auto", "variant-check",
]);

/** Skills that manage Claude Code itself (launchers, wrappers, its transcripts and sessions). They are never registered here. */
export const CLAUDE_ONLY_SKILLS = Object.freeze([
  "claude-copilot", "claude-openai", "improve-skill", "install-claude-auto", "uninstall-claude-auto", "uninstall-claude-copilot",
  "uninstall-claude-openai", "uninstall-claude-scope", "update-sessions",
]);

/** The skill whose own adapter (private/logic-test-debug/opencode.mjs) registers it and delivers its directive. */
const ADAPTER_SKILLS = Object.freeze(["logic-test-debug"]);

const FIELDS = ["name", "description", "disable-model-invocation"];

/** Reads the repository's small frontmatter dialect (one `key: value` per line), not general YAML. */
export function markdown(source) {
  const lines = String(source).split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("missing frontmatter");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("unclosed frontmatter");
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z][a-z-]*):[ \t]*(.*)$/.exec(line);
    if (!match || !FIELDS.includes(match[1])) continue;
    if (Object.hasOwn(fields, match[1])) throw new Error("duplicate field");
    let value = match[2].trim();
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'")) throw new Error("unclosed scalar");
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    if (typeof value !== "string" || !value) throw new Error("invalid scalar");
    fields[match[1]] = value;
  }
  if (!fields.description) throw new Error("missing description");
  return { fields, body: lines.slice(end + 1).join("\n") };
}

const COMMON_NOTE = [
  "OpenCode adapter. The tool names in these instructions are Claude Code's: Bash = `shell`, Read = `read`, Grep = `grep`,",
  "Glob = `glob`, Edit = `edit`, Write = `write`, AskUserQuestion = `question`, Agent = `subagent`, Skill = `skill`.",
  "`$ARGUMENTS` is what the user typed after the command (`/apana:<skill> ...`), without the command name; it is empty when",
  "the message has nothing after it. Frontmatter fields such as `allowed-tools` and `hooks` are not applied in OpenCode: its own",
  "permissions decide what runs, and nothing here grants one. Write each command as one plain command, as shown.",
].join(" ");

const SUBAGENT_NOTE = [
  "Where these instructions start a subagent: use the `subagent` tool. It starts a child session in the background with its own",
  "permissions (a \"read-only\" label is an instruction, not a sandbox) and its report arrives later as a `<subagent>` message.",
  "If `subagent` is not offered to you, do the job yourself.",
].join(" ");

const SPECIAL = {
  "review-diff": SUBAGENT_NOTE,
  "review-plan": SUBAGENT_NOTE,
  scope: [
    "The Apana adapter enforces this gate. It starts with the command `/apana:scope <task>`; loading this skill alone does not",
    "start it. The adapter tells you the proposal path and the nonce in its notes. While it is on, only direct `read`, `glob`, `grep`",
    "and `question` calls, the write of the proposal, and (after approval) `edit`/`write` on the approved paths and the approved",
    "test commands through `shell` are allowed; Code Mode (`execute`), MCP tools, `subagent` and any other tool are refused.",
    "A `shell` call must run in the project directory and not in the background. Jev decision loop and scope cannot be on in the",
    "same session. This is a tool gate, not an operating-system sandbox.",
  ].join(" "),
  "jev-decision-loop": [
    "The Apana adapter enforces this mode, not frontmatter hooks: every direct tool call needs a fresh `GO` from `jev.mjs`",
    "(one `GO`, one call), and the end of a turn is checked once. It starts with the command `/apana:jev-decision-loop`, an",
    "`@jev-decision-loop` mention, or when you load this skill because the user asked for it. Code Mode (`execute`) is refused",
    "while it is on: use the direct tools. `jev.mjs --off` ends the mode. It cannot start while `scope` is on in the session.",
    "Run `jev.mjs` with the `shell` tool, as one command.",
  ].join(" "),
};

const COMPACT_SESSION = [
  "# compact-session in OpenCode",
  "",
  "This skill is explicit-only. The user starts it with the command `/apana:compact-session`: the Apana adapter then asks",
  "OpenCode for a compaction of this session and supplies the replacement itself. No model turn is needed and nothing is",
  "emulated with shell commands, `/compact` or a model-written summary.",
  "",
  "The replacement is the same verified, deterministic compact transcript that Claude Code gets: ordinary user and assistant",
  "text stays whole, long tool content is moved to recoverable files under `~/.claude/handoffs/` (do not delete them: a later",
  "context may refer to them), the exact request is archived, and reasoning is archive-only. The check covers the prepared",
  "text, not every byte of the request. Media and provider checkpoints are not supported and make the compaction fail",
  "closed.",
  "",
  "If the replacement would not be smaller, or anything fails, the context stays as it is and no summarizer runs. OpenCode",
  "2.3.0 has no result for \"verified, nothing to do\", so it records such a run as a failed compaction; the report you may",
  "receive on the next turn says which of success, no-op and failure it was. That report describes a finished run, not a",
  "request to run it again. If you are reading this because the user only mentioned the skill, tell them to run the command.",
  "",
].join("\n");

/** The text a skill has in OpenCode: variables replaced, plus the adapter's note. `skill` is {id, path, content}. */
export function contentFor(skill, root = ROOT) {
  if (skill.id === "compact-session") return COMPACT_SESSION;
  const body = skill.content.replaceAll("${CLAUDE_SKILL_DIR}", () => dirname(skill.path)).replaceAll("${CLAUDE_PLUGIN_ROOT}", () => root);
  const note = [COMMON_NOTE, SPECIAL[skill.id]].filter(Boolean).join("\n\n");
  return `${note}\n\n${body}`;
}

/** Skills and commands of a checkout. Throws on a skill that is listed twice, unclassified or whose file does not match. */
export async function loadCatalog(root = ROOT) {
  const dirs = (await readdir(join(root, "skills"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const known = new Set([...OPENCODE_SKILLS, ...CLAUDE_ONLY_SKILLS]);
  if (known.size !== OPENCODE_SKILLS.length + CLAUDE_ONLY_SKILLS.length) throw new Error("a skill is classified twice");
  const skills = [];
  for (const name of dirs) {
    const path = join(root, "skills", name, "SKILL.md");
    let source;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!known.has(name)) throw new Error(`skill ${name} is not classified`);
    if (!OPENCODE_SKILLS.includes(name)) continue;
    const { fields, body } = markdown(source);
    if (fields.name !== name) throw new Error(`skill ${name}: name mismatch`);
    const skill = { id: name, name, description: fields.description, path, content: body, autoinvoke: fields["disable-model-invocation"] !== "true" };
    skills.push({ ...skill, content: contentFor(skill, root), adapter: ADAPTER_SKILLS.includes(name) });
  }
  for (const name of OPENCODE_SKILLS) if (!skills.some((skill) => skill.id === name)) throw new Error(`skill ${name} is missing`);
  const commands = [];
  for (const file of (await readdir(join(root, "commands"))).filter((name) => name.endsWith(".md")).sort()) {
    const { fields, body } = markdown(await readFile(join(root, "commands", file), "utf8"));
    commands.push({ name: `apana:${file.slice(0, -3)}`, description: fields.description, content: body });
  }
  return { skills, commands };
}
