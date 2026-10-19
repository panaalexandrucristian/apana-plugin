// Checks of the skill package itself: the frontmatter, the command form SKILL.md teaches, and that nothing in the skill names a path of one person's machine. Node stdlib only.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = resolve(SCRIPTS, "..");
const skillText = readFileSync(join(SKILL, "SKILL.md"), "utf8");
const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillText) ?? [];
const description = /^description: "((?:[^"\\]|\\.)*)"$/m.exec(frontmatter ?? "")?.[1];

describe("SKILL.md", () => {
  it("has the name and a description of at most 800 characters with the cues that make the model choose it", () => {
    assert.match(frontmatter, /^name: compact-handoff$/m);
    assert.ok(description, "a quoted description line exists");
    assert.ok(description.length <= 800, `description is ${description.length} characters`);
    for (const cue of ["handoff", "CURRENT session", "NAMED OpenCode session", "din OpenCode", "HANDOFF.md", "blobs/", "fă un handoff", "mai fă o dată handoff", "Not for delegating"]) assert.ok(description.includes(cue), `description mentions: ${cue}`);
  });

  it("lets the one script run without a permission prompt, by its own directory", () => {
    assert.match(frontmatter, /^allowed-tools: Bash\(python3 \$\{CLAUDE_SKILL_DIR\}\/scripts\/make_context\.py \*\)$/m);
  });

  it("teaches plain commands: the only variable in a command line is CLAUDE_SKILL_DIR, no pipe, and every step uses the one script that the allowed-tools pattern covers", () => {
    const commandLines = body.split("\n").filter((line) => /^ {4,}\S/.test(line)).map((line) => line.trim());   // indented code, also inside a numbered list
    assert.equal(commandLines.length, 4, "four command examples: --marker, --current, --list-opencode and --opencode");
    for (const line of commandLines) {
      assert.match(line, /^python3 \$\{CLAUDE_SKILL_DIR\}\/scripts\/make_context\.py --(marker|current|list-opencode|opencode)/);
      assert.equal(line.replace(/\$\{CLAUDE_SKILL_DIR\}/g, "").includes("$"), false, `no other variable in: ${line}`);
      assert.equal(/[|;&`]|\$\(/.test(line), false, `no pipe, chain or substitution in: ${line}`);
    }
    const prefix = /^allowed-tools: Bash\((.*) \*\)$/m.exec(frontmatter)[1];   // the pattern of the frontmatter, without its trailing *
    for (const line of commandLines) assert.ok(line.startsWith(prefix + " "), `covered by the allowed-tools pattern: ${line}`);
    assert.deepEqual(commandLines.map((l) => /make_context\.py (--[a-z-]+)/.exec(l)[1]), ["--marker", "--current", "--list-opencode", "--opencode"]);
  });

  it("states the rules that protect the user: no reading the file into the conversation, no deleting handoff folders unasked, no extra verification pass", () => {
    for (const rule of ["Do not read `HANDOFF.md` or the blobs into this conversation", "Never delete a `/tmp/handoff-*`", "check whether a recent session still refers to it", "If the script fails, show the error and stop"]) assert.ok(body.includes(rule), rule);
  });
});

describe("the skill text rule", () => {
  it("is described in SKILL.md: blob mode only, isMeta, named marker, whole with --cut", () => {
    for (const part of ["Base directory for this skill: ", "`isMeta`", "not typed by the user", "names the skill", "with `--cut` it stays whole"]) assert.ok(body.includes(part), part);
  });
});

describe("the SDK prompt rule", () => {
  it("is described in SKILL.md: blob mode, promptSource sdk, not the first and not the last, over 300 characters, the marker, --cut unchanged", () => {
    for (const part of ["`promptSource` `sdk`", "except the first and the last", "longer than 300 characters", "`[user] sdk: …`", "typed, queued, suggestion_accepted and unmarked records"]) assert.ok(body.includes(part), part);
  });
});

describe("the active goal", () => {
  it("is explained in SKILL.md: the option that switches it off, the last printed line, the goal of this session that stays active, the long-goal fallback and what makes a goal active", () => {
    for (const part of ["`--no-goal`", "`active goal:` line", "as the LAST line, `claude '/goal …'`", "until the user types `/goal clear` here", "too long for the command", "`goal_status`", "`met` false", "\"Goal activ (/goal)\"", "`--cut` carries the goal too", "an OpenCode session has no goal"]) assert.ok(body.includes(part), part);
  });
});

describe("the skills to load again", () => {
  it("is explained in SKILL.md: the option that switches it off, the printed line and its size, how a name is found, what is left out and who loads them", () => {
    for (const part of ["`--no-skills`", "`skills to reload:` line", "`sourceToolUseID`", "`<command-name>`", "never compact-handoff itself", "\"Skill-uri de încărcat din nou\"", "without `args`", "an OpenCode session lists none"]) assert.ok(body.includes(part), part);
  });
});

describe("the OpenCode section", () => {
  const section = /\n## În OpenCode\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  it("exists, names the option that skips a broken database and says to report the error to the user first", () => {
    assert.ok(section.length > 400, "an OpenCode section exists");
    for (const part of ["--no-opencode", "first report that error to the user", "Only after that", "Base directory for this skill:", "`${CLAUDE_SKILL_DIR}`", "--marker", "--current", "exactly ONE session",
      'opencode --prompt "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."', "reasoning", "not scanned for secrets"]) assert.ok(section.includes(part), part);
  });

  it("adds no command line and no install path, and leaves the Claude Code steps as they were", () => {
    assert.equal(section.split("\n").some((line) => /^ {4,}\S/.test(line)), false, "no indented command line in the OpenCode section");
    assert.equal(/\.config\/opencode|\.agents|ln -s|symlink/i.test(section), false, "no install path");
    const steps = /\n## Steps\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
    for (const part of ["1. **Get a marker**", "2. **Make the handoff**", "3. **Tell the user**", 'the start command exactly as printed (`claude "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."`)', "`--cut` (one `.md` file without blobs"]) assert.ok(steps.includes(part), part);
  });
});

describe("the named OpenCode session section", () => {
  const headings = [...body.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
  const section = /\n## A named OpenCode session\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  it("sits between În OpenCode and Rules, and the description and the first line name it", () => {
    assert.deepEqual(headings.slice(headings.indexOf("În OpenCode"), headings.indexOf("În OpenCode") + 3), ["În OpenCode", "A named OpenCode session", "Rules"]);
    assert.ok(body.includes("the transcript of the current session, or of a named OpenCode session,"));
  });

  it("lists first, chooses by the user's words, makes the handoff with the written-out default database and says what to tell the user", () => {
    for (const part of ["do not use the marker", "--list-opencode", "--match", "Leave out `--match` for \"the last one\"", "the last line names the database", "last line of the list",
      "Take the line the user's words point to; \"the last one\" or \"where work was done last\" is the first line that fits, because the list is newest first.",
      "A title ending in `(fork #n)` is a fork: skip forks unless the user asks for one.", "Only if the user's words still fit more than one line, show those lines (id, date, title) and ask which one.",
      "--opencode ~/.local/share/opencode/opencode.db --session <ID>", "(or the database named on the last line of the list, if it differs)", "in Romanian", 'opencode --prompt "..."',
      'claude "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."', "may still be running", "snapshot"]) assert.ok(section.includes(part), part);
    assert.ok(section.indexOf("--list-opencode") < section.indexOf("--session <ID>") && section.indexOf("Take the line") < section.indexOf("--session <ID>"), "list, choose, then make");
  });

  it("forbids sqlite3 and hand-written SQL in one plain sentence", () => {
    assert.ok(section.includes("Do NOT use `sqlite3` and do NOT write SQL on the database: use only the commands of this skill."));
  });
});

describe("the package", () => {
  it("has the four programs and no path of one machine inside", () => {
    for (const f of ["make_context.py", "compact_context.py", "prepare_all.py", "opencode_source.py"]) {
      const p = join(SCRIPTS, f);
      assert.ok(existsSync(p), `${f} exists`);
      assert.equal(/\/Users\/[a-z0-9._-]+\//i.test(readFileSync(p, "utf8")), false, `${f} names no /Users/<name>/ path`);
    }
    assert.equal(/\/Users\/[a-z0-9._-]+\//i.test(skillText), false, "SKILL.md names no /Users/<name>/ path");
  });

  it("keeps its tests next to it and uses no module outside the standard library of Python", () => {
    assert.ok(readdirSync(join(SCRIPTS, "test")).length >= 3);
    for (const f of ["make_context.py", "compact_context.py", "prepare_all.py", "opencode_source.py"]) {
      const imports = [...readFileSync(join(SCRIPTS, f), "utf8").matchAll(/^(?:import|from) ([a-z_][a-z0-9_]*)/gm)].map((m) => m[1]);
      for (const m of imports) assert.ok(["datetime", "glob", "json", "os", "re", "shutil", "subprocess", "sys", "tempfile", "time", "io", "contextlib", "hashlib", "itertools", "random", "compact_context", "omissions", "discover", "prepare", "sqlite3", "uuid", "collections", "importlib", "opencode_source"].includes(m), `${f} imports ${m}`);
    }
  });
});
