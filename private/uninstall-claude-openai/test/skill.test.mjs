import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL = join(ROOT, "skills", "uninstall-claude-openai", "SKILL.md");
const read = () => readFileSync(SKILL, "utf8");
const command = 'python3 "${CLAUDE_SKILL_DIR}/../claude-openai/scripts/claude_openai.py" uninstall';

describe("uninstall-claude-openai skill", () => {
  it("ships a discoverable uninstall skill", () => {
    assert.ok(existsSync(SKILL), "uninstall skill exists");
    assert.ok(read().includes("name: uninstall-claude-openai\n"));
    assert.ok(read().includes("Use when the user asks to uninstall or remove claude-openai"));
  });

  it("previews before removal using the existing bundled uninstaller", () => {
    const source = read();
    const preview = source.indexOf(`${command} --dry-run\n`);
    const removal = source.indexOf(`${command}\n`);
    assert.ok(preview >= 0, "dry-run command");
    assert.ok(removal > preview, "preview precedes removal");
    assert.ok(existsSync(join(ROOT, "skills", "claude-openai", "scripts", "claude_openai.py")));
    assert.equal(existsSync(join(ROOT, "skills", "uninstall-claude-openai", "scripts")), false,
      "reuse the uninstaller rather than maintaining a copy");
  });

  it("requires removal intent and preserves credentials and shared dependencies", () => {
    const source = read();
    for (const instruction of [
      "If the user only asked for a preview, stop after the dry run.",
      "If removal was not explicitly requested, ask for confirmation before continuing.",
      "Do not print shell configuration or credential contents.",
      "Do not stop running sessions or proxy processes.",
      "Do not run install, login or verify as part of removal.",
      "credentials", "backup", "CLIProxyAPI", "claude-auto", "settings.json",
    ]) assert.ok(source.includes(instruction), instruction);
  });
});
