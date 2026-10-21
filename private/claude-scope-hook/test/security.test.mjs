import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { onPrompt, onTool, statePath, proposalPath, validateProposal } from '../core.mjs';

const id = '22222222-2222-4222-8222-222222222222';
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'scope-security-'));
  const env = { APANA_SCOPE_STATE_DIR: join(root, '.state') };
  onPrompt({ session_id: id, cwd: root, prompt: '/apana:scope Fix the function' }, env);
  return { root, env };
}
const proposal = (command = 'node --test test/a.test.js') => ({
  production_changes: [{ path: 'src/a.js' }],
  test_changes: [{ path: 'test/a.test.js', production_paths: ['src/a.js'] }],
  test_commands: [command],
});
function gate(x, name, args) {
  return onTool({ session_id: id, cwd: x.root, tool_name: name, tool_input: args }, x.env);
}
test('corrupt or symlinked scope state never disables the gate', () => {
  const x = setup();
  writeFileSync(statePath(id, x.env), '{invalid');
  assert.equal(gate(x, 'Write', { file_path: join(x.root, 'outside.js') })?.hookSpecificOutput.permissionDecision, 'deny');
  const y = setup();
  const foreign = join(y.root, 'foreign.json');
  writeFileSync(foreign, '{}');
  symlinkSync(foreign, statePath('33333333-3333-4333-8333-333333333333', y.env));
  const output = onTool({ session_id: '33333333-3333-4333-8333-333333333333', cwd: y.root, tool_name: 'Write', tool_input: { file_path: join(y.root, 'a') } }, y.env);
  assert.equal(output?.hookSpecificOutput.permissionDecision, 'deny');
});
test('proposal cannot approve a file under a symlinked parent', () => {
  const x = setup();
  const outside = mkdtempSync(join(tmpdir(), 'scope-outside-'));
  symlinkSync(outside, join(x.root, 'src'));
  assert.throws(() => validateProposal(proposal(), x.root), /symlink|escape|unsafe/i);
});
test('proposal file symlink is rejected during approval', () => {
  const x = setup();
  const foreign = join(x.root, 'foreign-proposal.json');
  writeFileSync(foreign, JSON.stringify(proposal()));
  symlinkSync(foreign, proposalPath(id, x.env));
  const state = JSON.parse((awaitRead => awaitRead)(readState(x)));
  const output = onPrompt({ session_id: id, cwd: x.root, prompt: `/apana:scope approve ${state.nonce}` }, x.env);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Scope approved/);
});
import { readFileSync } from 'node:fs';
function readState(x) { return readFileSync(statePath(id, x.env), 'utf8'); }
test('only test runner forms are accepted, not arbitrary executable code', () => {
  const x = setup();
  for (const command of ['node -e process.exit()', 'python3 -c pass', 'npm exec arbitrary', 'npm install package', 'node script.js', 'pytest --override-ini=x']) {
    assert.throws(() => validateProposal(proposal(command), x.root), undefined, command);
  }
  assert.doesNotThrow(() => validateProposal(proposal(), x.root));
});
