#!/bin/sh
set -eu
mkdir -p src test
cat > AGENTS.md <<'EOT'
# Working here

- Tests live in `test/`, one file per source file, named `<source>.test.js`. Run them with `node --test`.
- A behaviour change gets the test that would have failed without it.
EOT
cat > src/signup.js <<'EOT'
// `send` sends one request to the server.
export function submitSignup(fields, send) {
  send({ type: "save-signup", fields });
  return { ok: true };
}
EOT
cat > test/signup.test.js <<'EOT'
import assert from "node:assert/strict";
import { test } from "node:test";
import { submitSignup } from "../src/signup.js";

test("a complete signup is saved", () => {
  const sent = [];
  const result = submitSignup({ name: "Ana", email: "ana@example.test" }, (request) => sent.push(request));
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
});
EOT
cat > PLAN.md <<'EOT'
# Plan: do not save an incomplete sign-up

## Context
The requirement: a sign-up with a required field left empty (`name` or `email`) must not send a save request to the server, and the person stays on the form. A complete sign-up is still saved as before.

## Steps
1. In `src/signup.js`, check that `name` and `email` are not empty before calling `send`.
2. When one of them is empty, return `{ ok: false }` and do not call `send`.
3. Add a test for the empty case in `test/signup.test.js`.
4. Check that it works.
EOT
