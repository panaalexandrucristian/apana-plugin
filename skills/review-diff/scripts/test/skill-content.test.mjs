// Checks of the skill package itself: the permission line, the command form SKILL.md teaches, and that the bundled program needs nothing outside node. Node stdlib only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillText = readFileSync(join(SCRIPTS, "..", "SKILL.md"), "utf8");
const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillText) ?? [];

describe("SKILL.md", () => {
  it("lets diff-target run without a permission prompt, by its own directory", () => {
    assert.match(frontmatter, /^allowed-tools: Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/diff-target\.mjs \*\)$/m);
  });

  it("teaches the four targets as plain commands whose only variable is CLAUDE_SKILL_DIR", () => {
    const commandLines = body.split("\n").filter((line) => /^ {4}\S/.test(line));
    for (const mode of ["uncommitted", "commit <sha>", "pr <number>", "ref <ref>"]) {
      assert.ok(commandLines.includes(`    node \${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs ${mode}`), mode);
    }
    for (const line of commandLines) assert.equal(line.replace(/\$\{CLAUDE_SKILL_DIR\}/g, "").includes("$"), false, `no other variable in: ${line}`);
  });

  it("says what the exit codes and the printed fields mean", () => {
    assert.match(body, /Exit 3 means/);
    for (const field of ["on current branch", "worktree", "special", "requirement"]) assert.ok(body.includes(`\`${field}`), field);
  });
});

describe("the bundled program", () => {
  it("imports only node built-ins", () => {
    const source = readFileSync(join(SCRIPTS, "diff-target.mjs"), "utf8");
    const imports = [...source.matchAll(/(?:^|\n)\s*(?:import\s[^"']*from\s*|await import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(imports.length > 0, "it has imports");
    for (const spec of imports) assert.ok(spec.startsWith("node:"), `imports ${spec}`);
  });
});
