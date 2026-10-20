import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SKILL = join(ROOT, "skills", "android-emulator-low-ram", "SKILL.md");
const MEASURE = join(ROOT, "skills", "android-emulator-low-ram", "scripts", "measure-memory.sh");
const START = join(ROOT, "skills", "android-emulator-low-ram", "scripts", "start-low-ram.sh");

function syntax(path) {
  return spawnSync("bash", ["-n", path], { encoding: "utf8" });
}

describe("android-emulator-low-ram skill", () => {
  it("has matching frontmatter and declares its safety boundary", () => {
    assert.ok(existsSync(SKILL));
    const source = readFileSync(SKILL, "utf8");
    assert.match(source, /^---\nname: android-emulator-low-ram\n/m);
    assert.match(source, /^description: /m);
    for (const text of ["Google Play", "Never type credentials", "Measure before and after", "-memory", "-lowram", "pm disable-user", "rollback"]) {
      assert.ok(source.includes(text), text);
    }
  });

  it("ships only parseable Bash helpers", () => {
    for (const path of [MEASURE, START]) {
      assert.ok(existsSync(path), path);
      const result = syntax(path);
      assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    }
  });

  it("keeps the launcher explicit about tested memory and snapshot modes", () => {
    const source = readFileSync(START, "utf8");
    for (const text of ["-memory", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-no-snapshot", "-lowram"]) {
      assert.ok(source.includes(text), text);
    }
  });
});
