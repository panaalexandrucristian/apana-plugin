// Checks of the skill package itself: the frontmatter, the command form SKILL.md teaches, and that the bundled programs need nothing outside the skill folder. Node stdlib only.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = resolve(SCRIPTS, "..");
const skillText = readFileSync(join(SKILL, "SKILL.md"), "utf8");
const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillText) ?? [];
const description = /^description: "(.*)"$/m.exec(frontmatter ?? "")?.[1];

describe("SKILL.md", () => {
  it("has the name and a description of at most 800 characters with the cues that make the model choose it", () => {
    assert.match(frontmatter, /^name: android-ui-step$/m);
    assert.ok(description, "a quoted description line exists");
    assert.ok(description.length <= 800, `description is ${description.length} characters`);
    for (const cue of ["Android emulator", "android", "adb", "ui-step.mjs", "ONE command", "android layout", "android screen capture", "adb shell input tap", "android-cli"]) assert.ok(description.includes(cue), `description mentions ${cue}`);
  });

  it("lets ui-step run without a permission prompt, by its own directory", () => {
    assert.match(frontmatter, /^allowed-tools: Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/ui-step\.mjs \*\)$/m);
  });

  it("teaches plain commands with literal paths: the only variable in a command line is CLAUDE_SKILL_DIR", () => {
    assert.match(body, /Write every command in full as one plain command with literal paths: no `\$VAR`/);
    const commandLines = body.split("\n").filter((line) => /^ {4}\S/.test(line));
    assert.ok(commandLines.length >= 1, "at least one command example");
    for (const line of commandLines) assert.equal(line.replace(/\$\{CLAUDE_SKILL_DIR\}/g, "").includes("$"), false, `no other variable in: ${line}`);
  });

  it("documents every option of the program and its exit codes", () => {
    for (const flag of ["--tap", "--region", "--back", "--swipe", "--shot", "--serial", "--safe"]) assert.ok(body.includes(flag), `${flag} is documented`);
    assert.match(body, /Exit 0 = done; 3 = stopped/);
    assert.match(body, /Dollar General QA app/, "--safe is described as written for one app");
  });

  it("stays short enough to be read in every use", () => {
    assert.ok(skillText.split(/\s+/).length <= 600, "at most 600 words");
  });
});

describe("the bundled programs", () => {
  it("are all there and import only node built-ins or each other", () => {
    for (const file of ["ui-step.mjs", "ui-digest.mjs", "img-shrink.mjs"]) {
      const path = join(SCRIPTS, file);
      assert.ok(existsSync(path), `${file} exists`);
      const imports = [...readFileSync(path, "utf8").matchAll(/(?:^|\n)\s*(?:import\s[^"']*from\s*|await import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of imports) assert.ok(spec.startsWith("node:") || /^\.\/(ui-digest|img-shrink|ui-step)\.mjs$/.test(spec), `${file} imports ${spec}`);
    }
  });
});
