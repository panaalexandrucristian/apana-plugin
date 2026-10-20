import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SKILL = join(ROOT, "skills", "install-claude-scope", "SKILL.md");
const WRAPPER = join(ROOT, "skills", "install-claude-scope", "assets", "claude_scope.py");
const INSTALLER = join(ROOT, "skills", "install-claude-scope", "scripts", "install.py");

describe("install-claude-scope skill", () => {
  it("ships the installer and guarded workflow with explicit activation semantics", () => {
    assert.ok(existsSync(SKILL));
    assert.ok(existsSync(WRAPPER));
    assert.ok(existsSync(INSTALLER));
    const source = readFileSync(SKILL, "utf8");
    assert.match(source, /^---\nname: install-claude-scope\n/m);
    for (const text of ["claude-scope", "automatic", "clean Git", "RED", "tests-only", "plain `claude`", "2.1.295", "bubblewrap"]) {
      assert.ok(source.includes(text), text);
    }
  });

  it("ships in plugin version 0.1.7", () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    assert.equal(plugin.version, "0.1.7");
    assert.equal(market.plugins.find((entry) => entry.name === "apana").version, "0.1.7");
  });
});
