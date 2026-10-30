#!/bin/sh
set -eu
mkdir -p src test
cat > AGENTS.md <<'EOT'
# Working here

- Tests live in `test/`, one file per source file, named `<source>.test.js`. Run them with `node --test`.
- A behaviour change gets the test that would have failed without it.
EOT
cat > src/export.js <<'EOT'
// Builds the text of the report export, one line per row.
export function exportReport(rows) {
  let text = "";
  for (const row of rows) {
    text = text + row.id + "," + row.total + "\n";
  }
  return text;
}
EOT
cat > test/export.test.js <<'EOT'
import assert from "node:assert/strict";
import { test } from "node:test";
import { exportReport } from "../src/export.js";

test("the export has one line per row", () => {
  assert.equal(exportReport([{ id: 1, total: 5 }, { id: 2, total: 7 }]), "1,5\n2,7\n");
});
EOT
cat > PLAN.md <<'EOT'
# Plan: make the report export faster

## Context
The requirement: the report export is too slow for customers; make it faster.

## Steps
1. In `src/export.js`, build the output with an array and one `join` instead of repeated string concatenation.
2. Keep `test/export.test.js` passing.
3. Check that the export is faster.
EOT
