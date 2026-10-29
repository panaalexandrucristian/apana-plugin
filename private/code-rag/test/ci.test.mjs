import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const command = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts["test:code-rag"];
const cases = [
  { name: "passing suite", methods: "    def test_pass(self): pass\n", status: 0 },
  { name: "failing suite", methods: "    def test_fail(self): self.fail('expected failure')\n", status: 1 },
  { name: "skipped suite", methods: "    @unittest.skip('missing dependency')\n    def test_skip(self): pass\n", status: 1 },
  { name: "empty suite", methods: "    pass\n", status: 1 },
  { name: "passing and skipped suite", methods: "    def test_pass(self): pass\n    @unittest.skip('missing dependency')\n    def test_skip(self): pass\n", status: 1 },
  { name: "failing and skipped suite", methods: "    def test_fail(self): self.fail('expected failure')\n    @unittest.skip('missing dependency')\n    def test_skip(self): pass\n", status: 1 },
];

describe("code-rag CI rejects incomplete test runs", () => {
  for (const { name, methods, status } of cases) {
    it(name, () => {
      const root = mkdtempSync(join(tmpdir(), "apana-code-rag-ci-"));
      try {
        const scripts = join(root, "skills", "code-rag", "scripts");
        mkdirSync(scripts, { recursive: true });
        writeFileSync(join(scripts, "test_fixture.py"), `import unittest\n\nclass Fixture(unittest.TestCase):\n${methods}`);
        const result = spawnSync("/bin/sh", ["-c", command], {
          cwd: root,
          encoding: "utf8",
          timeout: 30000,
          env: { ...process.env, PYTHONPATH: "", PYTHONNOUSERSITE: "1" },
        });
        assert.ifError(result.error);
        assert.equal(result.status, status, result.stdout + result.stderr);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
