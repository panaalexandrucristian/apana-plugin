// Checks of the skill package itself: the frontmatter, the command form SKILL.md teaches, the exit codes it explains, and that the bundled programs need nothing outside the skill folder. Node stdlib only.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = resolve(SCRIPTS, "..");
const skillText = readFileSync(join(SKILL, "SKILL.md"), "utf8");
const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillText) ?? [];
const description = /^description: "(.*)"$/m.exec(frontmatter ?? "")?.[1];

describe("SKILL.md", () => {
  it("has the name, explicit invocation only, and a description under 1024 characters that says what it does and when to use it", () => {
    assert.match(frontmatter, /^name: update-sessions$/m);
    assert.match(frontmatter, /^disable-model-invocation: true$/m);
    assert.ok(description, "a quoted description line exists");
    assert.ok(description.length < 1024, `description is ${description.length} characters`);
    for (const cue of ["claude plugin marketplace update", "claude plugin update", "/reload-plugins", "/apana:update-sessions", "Use when"]) assert.ok(description.includes(cue), `description mentions ${cue}`);
  });

  it("lets the command run without a permission prompt, by its own directory", () => {
    assert.match(frontmatter, /^allowed-tools: Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/update-sessions\.mjs \*\)$/m);
  });

  it("teaches one plain command with literal paths: the only variables are CLAUDE_SKILL_DIR and CLAUDE_SESSION_ID", () => {
    const commandLines = body.split("\n").filter((line) => /^ {4}\S/.test(line));
    assert.ok(commandLines.length >= 1, "at least one command example");
    for (const line of commandLines) assert.equal(line.replace(/\$\{CLAUDE_SKILL_DIR\}|\$\{CLAUDE_SESSION_ID\}/g, "").includes("$"), false, `no other variable in: ${line}`);
    assert.ok(commandLines.some((l) => l.includes("--self ${CLAUDE_SESSION_ID}")), "the command passes the invoking session");
    assert.match(body, /--dry-run/);
  });

  it("explains every exit code, including that exit 3 also covers typed, not confirmed and held, so the model does not report such a session as skipped", () => {
    for (const code of ["Exit 0", "Exit 3", "Exit 4", "Exit 5"]) assert.ok(body.includes(code), `${code} is explained`);
    assert.match(body, /typed, not confirmed/);
    assert.match(body, /received the command|got the command/i, "a typed, not confirmed session did receive the command");
    assert.match(body, /held/);
    assert.match(body, /\/reload-plugins --force/);
  });

  it("stays short: under 500 lines and 400 words", () => {
    assert.ok(skillText.split("\n").length < 500);
    assert.ok(skillText.split(/\s+/).length <= 400, `${skillText.split(/\s+/).length} words`);
  });
});

describe("the bundled programs", () => {
  it("are all there and import only node built-ins or each other", () => {
    for (const file of ["update-sessions.mjs", "sessions.mjs", "iterm.mjs"]) {
      const path = join(SCRIPTS, file);
      assert.ok(existsSync(path), `${file} exists`);
      const imports = [...readFileSync(path, "utf8").matchAll(/(?:^|\n)\s*(?:import\s[^"']*from\s*|await import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of imports) assert.ok(spec.startsWith("node:") || /^\.\/(update-sessions|sessions|iterm)\.mjs$/.test(spec), `${file} imports ${spec}`);
    }
  });
});
