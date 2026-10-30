import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL = join(ROOT, "skills", "review-plan", "SKILL.md");
const source = () => readFileSync(SKILL, "utf8");

describe("review-plan skill", () => {
  it("exists and has the right frontmatter", () => {
    assert.ok(existsSync(SKILL));
    const match = source().match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, "frontmatter");
    assert.match(match[1], /^name: review-plan$/m);
    assert.match(match[1], /^argument-hint: \[plan-file\]$/m);
  });

  it("asks what plan to review when it gets no argument, and reviews nothing before the answer", () => {
    const text = source();
    assert.match(text, /If `\$ARGUMENTS` is empty, review nothing yet/);
    assert.match(text, /"What plan should I review\?"/);
    for (const choice of ["the plan of this session", "a file (its path)", "something else"]) {
      assert.ok(text.includes(choice), choice);
    }
    assert.match(text, /then stop and wait for the next prompt/);
  });

  it("starts a standards agent before Part A that looks for the project's standards files and reports as text", () => {
    const text = source();
    assert.match(text, /\*\*Standards agent\.\*\*/);
    assert.match(text, /before Part A, start two subagents in one message/);
    assert.ok(text.indexOf("## Agents before the review") < text.indexOf("### Part A"));
    for (const file of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING*", ".editorconfig"]) assert.ok(text.includes(`\`${file}\``), file);
    assert.match(text, /text in its final message, not a file/);
    assert.match(text, /Neither may edit any file/);
    assert.match(text, /If it finds none, it says so and lists what it looked for/);
  });

  it("asks six questions about every step and five checks about what the plan leaves out", () => {
    const text = source();
    for (const label of [
      "**Why** do we do this step?",
      "**Is it strictly necessary?**",
      "**Is it aligned with the project standard?**",
      "**Does it hold?**",
      "**Is it in the right place?**",
      "**Is it the most optimal solution?**",
      "**Coverage.**",
      "**Order and dependencies.**",
      "**Verification.**",
      "**Hard to undo.**",
      "**Unevidenced assumptions and open questions.**",
    ]) {
      assert.ok(text.includes(label), label);
    }
  });

  it("fixes only the plan: no code, no build, no commit, and a plan outside a file is printed", () => {
    const text = source();
    assert.match(text, /Never edit code, never run a build or tests, never start carrying the plan out, never stage or commit/);
    assert.match(text, /edit nothing: print the revised plan in full at the end/);
  });

  it("treats a rule of the project's own files as a finding and a contradicting web practice as an observation", () => {
    const text = source();
    assert.match(text, /A rule in the project's own files that a step breaks is a finding/);
    assert.match(text, /A web practice that contradicts the project standard is an observation; it does not trigger a fix by itself/);
  });

  it("stops after 3 passes and starts the report with the standards files found", () => {
    const text = source();
    assert.match(text, /after 3 passes/);
    assert.match(text, /Start with the standards files found \(path and what each governs\), or "none found"/);
  });
});
