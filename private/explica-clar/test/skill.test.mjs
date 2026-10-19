import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL = join(ROOT, "skills", "explica-clar", "SKILL.md");
const EVIDENCE = join(ROOT, "skills", "explica-clar", "reference", "evidence.md");
const RULES = [
  "SUMMARY FIRST",
  "FEW CHUNKS",
  "ONE REAL EXAMPLE",
  "ANALOGY WITH A MAP",
  "ONE FLAT DIAGRAM",
  "SIGNAL WHAT MATTERS",
  "MATCH THE READER",
  "CHECK UNDERSTANDING",
];

const lineCount = (text) => text.replace(/\n$/, "").split("\n").length;

describe("explica-clar skill", () => {
  it("exists and has the right frontmatter", () => {
    assert.ok(existsSync(SKILL));
    const match = readFileSync(SKILL, "utf8").match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, "frontmatter");
    assert.match(match[1], /^name: explica-clar$/m);
    const description = match[1].match(/^description: (.+)$/m);
    assert.ok(description && description[1].length > 20);
  });

  it("states explicit-only activation in the description", () => {
    const source = readFileSync(SKILL, "utf8");
    const description = source.match(/^description: (.+)$/m)[1];
    assert.match(description, /ONLY when the user explicitly asks/);
    assert.match(description, /\/apana:explica-clar/);
    assert.match(description, /explică clar/);
  });

  it("has the eight rules under stable headings, in order", () => {
    const source = readFileSync(SKILL, "utf8");
    const found = [...source.matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => `${match[1]}. ${match[2]}`);
    assert.deepEqual(found, RULES.map((rule, i) => `${i + 1}. ${rule}`));
  });

  it("stays within the line limits", () => {
    assert.ok(lineCount(readFileSync(SKILL, "utf8")) <= 120);
    assert.ok(lineCount(readFileSync(EVIDENCE, "utf8")) <= 80);
  });

  it("ships in the plugin version 0.1.4", () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(plugin.version, "0.1.4");
  });
});
