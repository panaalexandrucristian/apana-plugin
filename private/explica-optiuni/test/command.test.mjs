import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMAND = join(ROOT, "commands", "explica-optiuni.md");

describe("explica-optiuni command", () => {
  it("ships as a Markdown command, not a skill with the same name", () => {
    assert.ok(existsSync(COMMAND), "commands/explica-optiuni.md must be discoverable");
    assert.equal(existsSync(join(ROOT, "skills", "explica-optiuni", "SKILL.md")), false);
  });

  it("requires explicit invocation and accepts a subject or transcript", () => {
    const source = readFileSync(COMMAND, "utf8");
    assert.ok(source.startsWith("---\n"));
    const [, frontmatter, body] = source.split("---\n");
    assert.ok(frontmatter.includes("description: "));
    assert.ok(frontmatter.includes("argument-hint: "));
    assert.ok(frontmatter.includes("disable-model-invocation: true"));
    assert.ok(body.includes("$ARGUMENTS"));
  });

  it("documents the namespaced command separately from skills", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const commands = readme.split("## Commands\n")[1]?.split("\n## ")[0];
    assert.ok(commands?.includes("/apana:explica-optiuni"));
    assert.ok(commands.includes("transcript"));
  });
});
