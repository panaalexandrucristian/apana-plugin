// Checks of the skill package itself: the frontmatter, the files SKILL.md points to, no client data, and the measuring script's required argument. Node stdlib and python3.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillText = readFileSync(join(SKILL, "SKILL.md"), "utf8");
const [, frontmatter] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillText) ?? [];
const description = /^description: "(.*)"$/m.exec(frontmatter ?? "")?.[1];
const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
const usageStats = (...args) => spawnSync("python3", ["-I", join(SKILL, "scripts", "usage_stats.py"), ...args], { encoding: "utf8" });

describe("frontmatter", () => {
  it("has the folder's name and a quoted description under 1024 characters that says when to use it", () => {
    assert.match(frontmatter, new RegExp(`^name: ${basename(SKILL)}$`, "m"));
    assert.ok(description, "a quoted description line exists, so a colon inside it stays valid YAML");
    assert.ok(description.length < 1024, `description is ${description.length} characters`);
    for (const cue of ["Use it whenever", "determine the complexity", "determină complexitatea", "Cynefin"]) assert.ok(description.includes(cue), `description mentions ${cue}`);
  });
});

describe("package", () => {
  it("has every references/ and scripts/ file that SKILL.md names", () => {
    const named = [...new Set(skillText.match(/(?:references|scripts)\/[\w.-]+\.(?:md|py)/g))];
    assert.ok(named.length >= 5, `SKILL.md names ${named.length} files`);
    for (const path of named) assert.ok(existsSync(join(SKILL, path)), `${path} exists`);
  });

  it("carries no local user path and no transcript folder of a named project", () => {
    for (const file of files(SKILL)) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /\/Users\//, file);
      assert.doesNotMatch(text, /projects\/-[A-Za-z]/, file);
    }
  });
});

describe("usage_stats.py", () => {
  it("needs the project directory: without it, or with a missing one, prints the usage and exits 1", () => {
    for (const args of [[], [join(SKILL, "no-such-directory")]]) {
      const run = usageStats(...args);
      assert.equal(run.status, 1, `args ${JSON.stringify(args)}: ${run.stderr}`);
      assert.match(run.stderr, /^usage: python3 -I usage_stats\.py <project directory/);
      assert.equal(run.stdout, "");
    }
  });
});
