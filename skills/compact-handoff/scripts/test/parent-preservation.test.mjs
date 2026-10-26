import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const suite of ["test_parent_preservation.py", "test_parent_copy_edges.py"]) {
  test(`parent handoffs preserve the complete graph, bodies and blobs: ${suite}`, () => {
    const script = fileURLToPath(new URL(`../${suite}`, import.meta.url));
    const result = spawnSync("python3", ["-B", script, "--quiet"], {
      encoding: "utf8", timeout: 120000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /SUMMARY .*"PASS"/);
    assert.doesNotMatch(result.stdout, /"FAIL"/);
  });
}
