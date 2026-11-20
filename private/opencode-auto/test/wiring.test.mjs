import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLAUDE_ONLY_SKILLS, OPENCODE_SKILLS, ROOT } from "../../opencode/catalog.mjs";

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");
const scripts = JSON.parse(read("package.json")).scripts;

describe("opencode-auto is wired into package.json and CI", () => {
  it("has a script for its offline suites: the plugin tests and the installer, uninstaller and launcher tests", () => {
    assert.equal(
      scripts["test:opencode-auto"],
      "node --test private/opencode-auto/test/*.mjs && python3 -B -W ignore skills/install-opencode-auto/scripts/test_setup.py",
    );
  });
  it("runs that script in CI", () => {
    assert.match(read(".github", "workflows", "ci.yml"), /run: npm run test:opencode-auto\b/);
  });
  it("has its runtime test in the runtime script, next to the one of the apana plugin", () => {
    assert.match(scripts["test:opencode-runtime"], /private\/opencode\/test\/runtime\.test\.mjs/);
    assert.match(scripts["test:opencode-runtime"], /private\/opencode-auto\/test\/runtime\.test\.mjs/);
    assert.ok(existsSync(join(ROOT, "private", "opencode-auto", "test", "runtime.test.mjs")));
  });
  it("keeps the runtime test out of `npm test`: the script that runs everything else does not set the variable that turns it on", () => {
    assert.doesNotMatch(scripts.test, /APANA_OPENCODE_RUNTIME/);
  });
});

describe("the two skills", () => {
  it("run in OpenCode, not only in Claude Code", () => {
    for (const id of ["install-opencode-auto", "uninstall-opencode-auto"]) {
      assert.ok(OPENCODE_SKILLS.includes(id), id);
      assert.ok(!CLAUDE_ONLY_SKILLS.includes(id), id);
    }
  });
  it("can be started by the model: they do not switch off model invocation", () => {
    for (const id of ["install-opencode-auto", "uninstall-opencode-auto"]) assert.doesNotMatch(read("skills", id, "SKILL.md"), /^disable-model-invocation:/m, id);
  });
  it("ship what the installer needs: the launcher (executable) and both scripts", () => {
    accessSync(join(ROOT, "skills", "install-opencode-auto", "assets", "opencode-auto"), constants.X_OK);
    assert.ok(existsSync(join(ROOT, "skills", "install-opencode-auto", "scripts", "install.py")));
    assert.ok(existsSync(join(ROOT, "skills", "uninstall-opencode-auto", "scripts", "uninstall.py")));
  });
});

describe("the plugin folder", () => {
  it("has the two entries OpenCode looks for and no package.json: a folder without one uses server.js and tui.js", () => {
    assert.ok(existsSync(join(ROOT, "opencode-auto", "server.js")));
    assert.ok(existsSync(join(ROOT, "opencode-auto", "tui.js")));
    assert.ok(!existsSync(join(ROOT, "opencode-auto", "package.json")));
  });
});
