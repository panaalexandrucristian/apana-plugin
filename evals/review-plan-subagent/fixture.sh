#!/bin/sh
set -eu
mkdir -p src test
cat > AGENTS.md <<'EOT'
# Working here

- In `sendInvite`, call `send` only if the normalised address is non-empty.
- `parseAddress` only trims its input; keep it free of validation because draft callers also use it.
- Use `node --test` for tests under `test/`.
EOT
cat > src/invite.mjs <<'EOT'
export function parseAddress(raw) {
  return raw.trim();
}

export async function sendInvite(raw, send) {
  if (raw === '') return false;
  await send(raw);
  return true;
}
EOT
cat > test/invite.test.mjs <<'EOT'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendInvite } from '../src/invite.mjs';

test('does not send an empty address', async () => {
  const sent = [];
  assert.equal(await sendInvite('', async address => sent.push(address)), false);
  assert.deepEqual(sent, []);
});
EOT
cat > PLAN.md <<'EOT'
# Plan: trim invitation addresses before sending

## Requirement
Trim invitation addresses before forwarding them. For an empty result, including an input containing only spaces, return false and do not call `send`. For a non-empty result, call `send` with the trimmed address and return true. Keep `parseAddress` trim-only.

## Steps
1. In `src/invite.mjs`, replace the existing empty-input guard in `sendInvite` with a call to `parseAddress`. Send the returned address directly and return true. Do not add another guard.
2. Extend `test/invite.test.mjs` to cover whitespace-only and padded non-empty addresses.

## Acceptance criteria
- Criterion — normalised invitation / steps 1–2: with input `   `, `sendInvite` returns false and the send recorder stays empty; with `  ana@example.test  `, it returns true and the recorder contains exactly `ana@example.test`. Passes if both results and both send records match. Check: `node --test test/invite.test.mjs`. Evidence: test output. Status: planned, not run.
EOT
git init -q
git add -- AGENTS.md PLAN.md src test
git -c user.name='Review Plan Fixture' -c user.email=fixture@example.test -c commit.gpgSign=false -c core.hooksPath=/dev/null commit -qm 'Seed invitation review fixture'
