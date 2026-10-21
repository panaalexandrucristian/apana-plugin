import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const root = resolve(import.meta.dirname, '../../..');
const id = '44444444-4444-4444-8444-444444444444';
function call(adapter, event, payload, state) {
  const p = spawnSync(process.execPath, [adapter, event], {
    input: JSON.stringify({ session_id: id, cwd: root, ...payload }), encoding: 'utf8',
    env: { ...process.env, APANA_SCOPE_STATE_DIR: state, APANA_LOGIC_TEST_DEBUG: 'off', APANA_CLASS_GRAPH_NUDGE: 'off' },
  });
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim() ? JSON.parse(p.stdout) : null;
}
test('failed scope activation blocks the prompt instead of silently running unguarded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-io-failure-'));
  try {
    const state = join(dir, 'not-a-directory'); writeFileSync(state, 'occupied');
    const out = call(join(root, 'scripts/apana-hook.mjs'), 'UserPromptSubmit', { prompt: '/apana:scope Change the function' }, state);
    assert.equal(out?.decision, 'block');
    assert.match(out.reason, /scope.*unavailable/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('unexpected core exceptions deny tools and block submitted prompts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-core-failure-'));
  try {
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'private/claude-scope-hook'), { recursive: true });
    copyFileSync(join(root, 'scripts/apana-hook.mjs'), join(dir, 'scripts/apana-hook.mjs'));
    writeFileSync(join(dir, 'private/claude-scope-hook/core.mjs'), 'export function onTool(){throw Error("SECRET")}\nexport function onPrompt(){throw Error("SECRET")}');
    const adapter = join(dir, 'scripts/apana-hook.mjs');
    const out = call(adapter, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/unapproved' } }, dir);
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(!JSON.stringify(out).includes('SECRET'));
    assert.equal(call(adapter, 'UserPromptSubmit', { prompt: 'Continue' }, dir)?.decision, 'block');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
