import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL = join(ROOT, "skills", "review-diff", "SKILL.md");
const source = () => readFileSync(SKILL, "utf8");

describe("review-diff skill", () => {
  it("exists and has the right frontmatter", () => {
    assert.ok(existsSync(SKILL));
    const match = source().match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, "frontmatter");
    assert.match(match[1], /^name: review-diff$/m);
    assert.match(match[1], /^argument-hint: \[base-ref\]$/m);
  });

  it("asks what to review when it gets no argument, and reviews nothing before the answer", () => {
    const text = source();
    assert.match(text, /If `\$ARGUMENTS` is empty, review nothing yet/);
    assert.match(text, /"What should I review\?"/);
    for (const choice of ["uncommitted changes", "one commit", "a pull request", "something else"]) {
      assert.ok(text.includes(choice), choice);
    }
    assert.match(text, /gh pr diff N -R <owner\/repo>/);
  });

  it("includes untracked files when the target is a ref", () => {
    assert.match(source(), /`git diff \$ARGUMENTS\.\.\.HEAD`, the uncommitted changes and the untracked files/);
  });

  it("asks whether each hunk and each new class is in the right place, without moving anything alone", () => {
    const text = source();
    assert.match(text, /\*\*Is it in the right place\?\*\*/);
    assert.match(text, /Do not move anything without the user's agreement/);
    assert.match(text, /Place questions/);
  });

  it("fixes a commit or PR on another branch in a sibling worktree", () => {
    const text = source();
    assert.match(text, /sibling worktree `\.\.\/<repo>-review-<sha8 or prN>`/);
    assert.match(text, /git fetch origin pull\/N\/head/);
    assert.match(text, /Do not commit and do not delete the worktree/);
  });

  it("uses one briefing subagent, once, that reports as text and does not edit", () => {
    const text = source();
    assert.match(text, /start one subagent/);
    assert.match(text, /once per invocation/i);
    assert.match(text, /text in its final message, not a file/);
    assert.match(text, /must not edit any file/);
    assert.match(text, /If the `Agent` tool is missing, do both steps yourself/);
  });

  it("runs Part B on the same diff as Part A", () => {
    const text = source();
    assert.match(text, /Run this part only when Part A changed nothing\. Use the same diff as in Part A/);
    assert.ok(!text.includes("`git diff --diff-filter=A` plus untracked files"));
  });

  it("asks for the requirement instead of marking every hunk 'no reason'", () => {
    assert.match(source(), /ask which requirement the diff serves/);
  });

  it("runs the tests, the build and a behaviour check after a fix", () => {
    const text = source();
    assert.match(text, /run the tests that cover the touched files and the build/);
    assert.match(text, /search for the callers of the changed code/);
  });
});
