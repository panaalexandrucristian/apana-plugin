import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLAUDE_ONLY_SKILLS, OPENCODE_SKILLS, ROOT, contentFor, loadCatalog, markdown } from "../catalog.mjs";
import { tempDir } from "./support/fake-ctx.mjs";

const skillDirs = () => readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory() && readdirSync(join(ROOT, "skills", e.name)).includes("SKILL.md")).map((e) => e.name).sort();

describe("which skills run in OpenCode", () => {
  it("classifies every skill directory exactly once, so that a new skill forces a decision", () => {
    const listed = [...OPENCODE_SKILLS, ...CLAUDE_ONLY_SKILLS];
    assert.equal(new Set(listed).size, listed.length, "no skill is in both lists");
    assert.deepEqual([...listed].sort(), skillDirs());
  });
  it("registers exactly the OpenCode skills and none of the Claude Code tools", async () => {
    const { skills } = await loadCatalog();
    assert.deepEqual(skills.map((s) => s.id).sort(), [...OPENCODE_SKILLS].sort());
    for (const id of CLAUDE_ONLY_SKILLS) assert.ok(!skills.some((s) => s.id === id), id);
  });
  it("exposes emulator tuning to the model and resolves its bundled source guide and boot check", async () => {
    const { skills } = await loadCatalog();
    const skill = skills.find((s) => s.id === "android-emulator-tuning");
    assert.ok(skill?.autoinvoke);
    const dir = join(ROOT, "skills", skill.id);
    for (const path of [join(dir, "reference", "architecture.md"), join(dir, "scripts", "boot-check.py")]) {
      assert.ok(skill.content.includes(path), path);
      assert.ok(readFileSync(path, "utf8").trim(), path);
    }
  });
  it("refuses a skill directory that is in neither list", async () => {
    const root = tempDir();
    cpSync(join(ROOT, "skills"), join(root, "skills"), { recursive: true });
    cpSync(join(ROOT, "commands"), join(root, "commands"), { recursive: true });
    mkdirSync(join(root, "skills", "brand-new"));
    writeFileSync(join(root, "skills", "brand-new", "SKILL.md"), "---\nname: brand-new\ndescription: x\n---\nbody\n");
    await assert.rejects(loadCatalog(root), /brand-new is not classified/);
  });
});

describe("the text of a skill in OpenCode", () => {
  it("has no Claude Code variable left, and the folder variable is the skill's real folder", async () => {
    const { skills } = await loadCatalog();
    for (const skill of skills) assert.ok(!skill.content.includes("${CLAUDE_"), skill.id);
    const variant = skills.find((s) => s.id === "variant-check");
    assert.ok(variant.content.includes(`node ${join(ROOT, "skills", "variant-check")}/scripts/variants.mjs`));
    const sync = skills.find((s) => s.id === "opencode-plugin-skills-sync");
    assert.ok(sync.content.includes(`python3 -I "${join(ROOT, "skills", "opencode-plugin-skills-sync", "scripts", "install.py")}" --check`));
    const guard = skills.find((s) => s.id === "opencode-shell-guard");
    assert.ok(guard.content.includes(`node "${join(ROOT, "skills", "opencode-shell-guard", "scripts", "shell-guard.mjs")}" --check`));
  });
  it("says what the Claude tool names, $ARGUMENTS and the frontmatter mean here", async () => {
    const { skills } = await loadCatalog();
    for (const skill of skills.filter((s) => s.id !== "compact-session")) {
      assert.match(skill.content, /OpenCode adapter\. The tool names/, skill.id);
      assert.match(skill.content, /`\$ARGUMENTS` is what the user typed after the command/, skill.id);
      assert.match(skill.content, /not applied in OpenCode/, skill.id);
    }
  });
  it("tells the review skills what their subagent tool is, and Jev how it is enforced", async () => {
    const byId = Object.fromEntries((await loadCatalog()).skills.map((s) => [s.id, s]));
    for (const id of ["review-diff", "review-plan"]) assert.match(byId[id].content, /use the `subagent` tool/);
    assert.match(byId["jev-decision-loop"].content, /Code Mode \(`execute`\) is refused/);
  });
  it("replaces compact-session by the explicit-only description of what the adapter does", async () => {
    const { skills } = await loadCatalog();
    const compact = skills.find((s) => s.id === "compact-session");
    assert.match(compact.content, /explicit-only/);
    assert.match(compact.content, /records such a run as a failed compaction/);
    assert.ok(!compact.content.includes("Stop hook"));
  });
  it("hides from the model's list only the skills that say disable-model-invocation", async () => {
    const { skills } = await loadCatalog();
    assert.deepEqual(skills.filter((s) => !s.autoinvoke).map((s) => s.id), ["compact-session"]);
  });
  it("reads a changed SKILL.md when the catalog is loaded again (an edit needs a new setup, not a watcher)", async () => {
    const root = tempDir();
    cpSync(join(ROOT, "skills"), join(root, "skills"), { recursive: true });
    cpSync(join(ROOT, "commands"), join(root, "commands"), { recursive: true });
    const file = join(root, "skills", "variant-check", "SKILL.md");
    const before = (await loadCatalog(root)).skills.find((s) => s.id === "variant-check");
    writeFileSync(file, readFileSync(file, "utf8").replace("# variant-check", "# variant-check EDITED"));
    const after = (await loadCatalog(root)).skills.find((s) => s.id === "variant-check");
    assert.ok(!before.content.includes("EDITED") && after.content.includes("EDITED"));
  });
});

describe("the commands", () => {
  it("reads explica-optiuni, whose text keeps $ARGUMENTS for the command to fill in", async () => {
    const { commands } = await loadCatalog();
    assert.deepEqual(commands.map((c) => c.name), ["apana:explica-optiuni"]);
    assert.ok(commands[0].content.includes("$ARGUMENTS"));
    assert.ok(commands[0].description.startsWith("Reface contextul"));
  });
});

describe("the frontmatter reader", () => {
  const read = (fm, body = "b") => markdown(`---\n${fm}\n---\n${body}`);
  it("reads plain, double-quoted and single-quoted values and ignores nested and unknown fields", () => {
    const a = read('name: x\ndescription: "say \\"hi\\": now"\nallowed-tools: Bash(node *)\nhooks:\n  Stop:\n    - hooks:\n        - type: command');
    assert.equal(a.fields.description, 'say "hi": now');
    assert.equal(read("name: x\ndescription: 'it''s'").fields.description, "it's");
    assert.equal(read("name: x\ndescription: plain text: with colon").fields.description, "plain text: with colon");
    assert.deepEqual(Object.keys(a.fields).sort(), ["description", "name"]);
  });
  it("refuses a missing frontmatter, a missing description, an unclosed quote and a repeated field", () => {
    assert.throws(() => markdown("no frontmatter"), /missing frontmatter/);
    assert.throws(() => read("name: x"), /missing description/);
    assert.throws(() => read("name: x\ndescription: 'open"), /unclosed scalar/);
    assert.throws(() => read("name: x\nname: y\ndescription: d"), /duplicate field/);
  });
  it("keeps the whole body, line breaks included", () => {
    assert.equal(read("name: x\ndescription: d", "line 1\n\nline 2\n").body, "line 1\n\nline 2\n");
  });
});

describe("contentFor", () => {
  it("replaces the plugin root and skill dir literally, with no trailing slash or $-pattern expansion", () => {
    assert.ok(!ROOT.endsWith("/"), ROOT);
    const def = contentFor({ id: "x", path: join(ROOT, "skills/x/SKILL.md"), content: "${CLAUDE_PLUGIN_ROOT}/scripts/a.mjs" });
    assert.ok(def.endsWith(`${ROOT}/scripts/a.mjs`) && !def.includes("//scripts/"));
    const dollar = contentFor({ id: "x", path: "/p/$&/skills/x/SKILL.md", content: "a ${CLAUDE_PLUGIN_ROOT} b ${CLAUDE_SKILL_DIR}" }, "/root/$&/$$");
    assert.ok(dollar.endsWith("a /root/$&/$$ b /p/$&/skills/x"));
  });
});
