import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const SKILL = new URL("../../", import.meta.url);
const ROOT = new URL("../../../../", import.meta.url);
const read = (base, path) => readFileSync(new URL(path, base), "utf8");

test("ships the subscription bridge skill with its installer, tests and lazy references", () => {
  const text = read(SKILL, "SKILL.md");
  assert.match(text, /^name: claude-openai$/m);
  assert.match(text, /^version: 0\.2\.2$/m);
  assert.match(text, /\$\{CLAUDE_SKILL_DIR\}/);
  assert.doesNotMatch(text, /\/Users\/[^/]+\//);
  for (const path of ["scripts/claude_openai.py", "scripts/test_claude_openai.py",
    "references/operations.md", "references/verification.md"]) {
    assert.ok(existsSync(new URL(path, SKILL)), path);
  }
  for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
    assert.ok(existsSync(new URL(link, SKILL)), link);
  }
});

test("runs the bundled offline bridge tests through the package and CI", () => {
  const pkg = JSON.parse(read(ROOT, "package.json"));
  assert.equal(pkg.scripts["test:claude-openai"],
    "python3 -B -m unittest discover -s skills/claude-openai/scripts -p 'test_*.py'");
  assert.match(read(ROOT, ".github/workflows/ci.yml"), /run: npm run test:claude-openai\b/);
});
