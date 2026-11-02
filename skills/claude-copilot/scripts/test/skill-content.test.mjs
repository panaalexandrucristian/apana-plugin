import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
const skill = new URL('../../', import.meta.url);
const root = new URL('../../../../', import.meta.url);
const read = (base, file) => readFileSync(new URL(file, base), 'utf8');

test('ships the standalone Copilot bridge and real references without private artifacts', () => {
  const text = read(skill, 'SKILL.md');
  assert.match(text, /^name: claude-copilot$/m);
  assert.match(text, /\$\{CLAUDE_SKILL_DIR\}/);
  assert.doesNotMatch(text, /\/Users\/[^/]+\//);
  for (const path of ['scripts/claude_copilot.py', 'scripts/test_claude_copilot.py', 'scripts/test_uninstall_cli.py', 'references/operations.md']) {
    assert.ok(existsSync(new URL(path, skill)), path);
  }
  for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) assert.ok(existsSync(new URL(link, skill)), link);
  for (const entry of readdirSync(skill, { recursive: true })) assert.doesNotMatch(entry, /\.(dylib|zip|jsonl)$|credential|verification\.json/);
  assert.doesNotMatch(read(skill, 'scripts/claude_copilot.py'), /import claude_openai|from claude_openai/);
});

test('Copilot offline suite is wired into package and CI', () => {
  const pkg = JSON.parse(read(root, 'package.json'));
  assert.equal(pkg.scripts['test:claude-copilot'], "python3 -B -m unittest discover -s skills/claude-copilot/scripts -p 'test_*.py'");
  assert.match(read(root, '.github/workflows/ci.yml'), /run: npm run test:claude-copilot\b/);
});
