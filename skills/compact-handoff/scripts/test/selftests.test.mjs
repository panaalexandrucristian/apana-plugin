// Runs the self tests that the two Python programs carry (exhaustive tables for the length limits and the read-only rule, the cut mode, the reading plan, the introduction, parent handoffs and the marker lookup).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (file, args) => spawnSync("python3", ["-B", join(SCRIPTS, file), ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });

describe("self tests of the Python programs", () => {
  it("compact_context.py selftest passes", () => {
    const r = run("compact_context.py", ["selftest"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^selftest OK: \d+ cases/);
  });

  it("make_context.py --selftest passes", () => {
    const r = run("make_context.py", ["--selftest"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^make_context selftest OK: \d+ cases/);
  });

  it("OpenCode selftest comparison survives clock boundaries without masking changes", () => {
    const r = run("test/test_make_context_clock.py", []);
    assert.equal(r.status, 0, r.stderr);
  });
});
