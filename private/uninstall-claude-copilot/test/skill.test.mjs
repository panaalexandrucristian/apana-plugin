import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
const skill = new URL('../../../skills/uninstall-claude-copilot/', import.meta.url);
const command = 'python3 -I "${CLAUDE_SKILL_DIR}/../claude-copilot/scripts/claude_copilot.py" uninstall';

test('uninstaller previews before explicit removal with the same-version sibling', () => {
  const text = readFileSync(new URL('SKILL.md', skill), 'utf8');
  assert.match(text, /^name: uninstall-claude-copilot$/m);
  assert.match(text, /Use when the user asks to uninstall or remove claude-copilot/);
  const preview = text.indexOf(command + ' --dry-run');
  assert.ok(preview >= 0);
  assert.ok(text.indexOf(command + ' --yes') > preview);
  assert.equal(existsSync(new URL('scripts/', skill)), false);
  for (const phrase of ['If removal was not explicitly requested, ask for confirmation',
    'If the user only asked for a preview, stop', 'sibling is missing, stop',
    'Do not stop running sessions', 'Do not run install, login or verify',
    'credentials', 'backup', 'CLIProxyAPI', 'settings.json']) assert.ok(text.includes(phrase), phrase);
});
