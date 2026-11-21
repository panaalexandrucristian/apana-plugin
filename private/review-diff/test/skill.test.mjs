import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL = join(ROOT, "skills", "review-diff", "SKILL.md");
const source = () => readFileSync(SKILL, "utf8");
// The text from a heading to the next heading of the same or a higher level.
const section = (heading) => {
  const text = source();
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, heading);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return end < 0 ? rest : rest.slice(0, end);
};

describe("review-diff skill", () => {
  it("exists and has the right frontmatter", () => {
    assert.ok(existsSync(SKILL));
    const match = source().match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, "frontmatter");
    assert.match(match[1], /^name: review-diff$/m);
    assert.match(match[1], /^argument-hint: \[base-ref\]$/m);
    assert.match(match[1], /^allowed-tools: Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/diff-target\.mjs \*\)$/m);
    assert.match(match[1], /description: "Review a diff before it is committed, using a fresh reviewer subagent without the conversation that produced the code:/);
    assert.match(match[1], /the main agent applies the edits it proposes and repeats the whole pass/);
    assert.match(match[1], /Use when the user runs \/apana:review-diff or asks to challenge, double-check or find the weak points of the changes in the diff\."$/m);
    assert.doesNotMatch(match[1], /context: fork|Agent/);
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

  it("takes one diff against the merge base, untracked files included, when the target is a ref", () => {
    const text = source();
    assert.match(text, /everything since the merge base of the ref and `HEAD`, committed or not, and the untracked files\. Run the `ref` command below with it/);
    assert.ok(!text.includes("git diff $ARGUMENTS...HEAD"));
  });

  it("takes the hunks and the new files from diff-target and keeps the git commands as a fallback", () => {
    const text = source();
    assert.match(text, /from the `hunks` list of the script; do not rebuild the list/);
    assert.match(text, /files marked `A` in the script's `files` list \(untracked ones too\)/);
    assert.match(text, /with no Node, take the diff by hand: `git diff HEAD` plus `git ls-files --others --exclude-standard`/);
  });

  it("reports a table per part with the five answers and the action", () => {
    assert.match(source(), /^\| hunk or class \| why \| necessary \| aligned \| right place \| optimal \| action \|$/m);
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

  it("starts one read-only Briefing sibling, once, before the first reviewer, whose text is leads for the reviewers", () => {
    const brief = section("## Briefing agent");
    assert.match(brief, /^\nOnce per invocation, after the target, the requirement and the review checkout are fixed and before the first reviewer, the main agent starts one read-only Briefing subagent/);
    assert.match(brief, /It is a sibling of the reviewers, not their child: the workflow needs no nesting/);
    assert.match(brief, /Neither was tested live, and the workflow relies on neither/);
    assert.match(brief, /the diff access details from "What to review" and the requirement, not the conversation or any verdict/);
    assert.match(brief, /must not edit any file/);
    assert.match(brief, /text in its final message, not a file/);
    assert.match(brief, /If the diff touches nothing external, say so and do not search/);
    assert.match(brief, /Pass this report verbatim to each reviewer as leads, not evidence/);
    assert.match(brief, /Do not start it again on later passes/);
  });

  it("runs Part A then Part B on the same diff and ends the pass at the first finding that needs a fix", () => {
    const pass = section("## Each pass");
    assert.match(pass, /A pass reviews one snapshot of the diff: Part A, then Part B, on the same diff/);
    assert.match(pass, /A finding that needs a fix in either part ends the pass: the reviewer names what it did not reach/);
    assert.match(pass, /A "right place" finding is not a fix: note it and go on/);
    assert.match(section("### Part B: every new class"), /^\nRun this part only when Part A found nothing that needs a fix\. Use the same diff as in Part A\./);
    assert.ok(!source().includes("`git diff --diff-filter=A` plus untracked files"));
    assert.match(section("### Part B: every new class"), /If the fix needs a decision about the requirement, return it as a blocker question under `## Questions for the owner` instead of guessing/);
    assert.doesNotMatch(section("### Part B: every new class"), /ask instead of guessing/);
  });

  it("gives the children the helper's inventory and read-only access to the reviewed patch and files", () => {
    const intake = section("## What to review");
    assert.match(intake, /the exact `files` and `hunks` lists, and the absolute path of the review checkout/);
    assert.match(intake, /The script does not print the patch itself/);
    assert.match(intake, /read untracked files whole/);
    assert.match(intake, /the checkout may be at a later commit/);
    assert.match(intake, /Do not rebuild the lists, create a separate worktree for a child, or switch the review checkout silently/);
    assert.match(intake, /a child that cannot read the patch or the files reports it as a blocker/);
  });

  it("records a baseline of the reviewed state before any child starts and has the child verify it saw the same patch and files", () => {
    const intake = section("## What to review");
    assert.match(intake, /Before starting any child, the main agent records a baseline of the reviewed state/);
    assert.match(intake, /the resolved target/);
    assert.match(intake, /the exact patch/);
    assert.match(intake, /the index/);
    assert.match(intake, /the contents of the relevant files, untracked ones included/);
    assert.match(intake, /compare what it read with the baseline and report a blocker if it cannot establish the match/);
    assert.match(intake, /The PR number and unchanged hunk coordinates do not show that a child saw the same patch/);
    assert.match(intake, /For a deleted file or the old side of a rename, read the pre-change revision and the old path/);
    assert.match(intake, /The script's `files` and `hunks` lists stay authoritative/);
    assert.match(section("### Start a fresh reviewer"), /the baseline and the instruction to verify the patch and the files against it/);
    assert.match(section("### Apply the proposed edits"), /compare the target, the index and the relevant files with the baseline recorded before the pass, and check that each edit's old text is still in its file exactly as reviewed/);
  });

  it("revalidates from the same read-only source as the baseline, the exact patch included, with or without Node", () => {
    const intake = section("## What to review");
    assert.match(intake, /With no Node, the fallback commands above take the place of the script and of the `diff` command: their file list and patch are the inventory and the patch of the baseline/);
    const apply = section("### Apply the proposed edits");
    assert.match(apply, /read the reviewed state again from the same read-only source as the baseline \(the same script command and the patch command its `diff` field names, or, with no Node, the same fallback commands\)/);
    assert.match(apply, /compare the exact patch and the file and hunk lists with the baseline/);
    assert.match(apply, /If the target, the index, the patch or a relevant file changed/);
    assert.doesNotMatch(apply, /run the same script command again and compare/);
  });

  it("establishes the requirement before any child starts and hands over a chat-only requirement verbatim", () => {
    const req = section("## The requirement");
    assert.match(req, /^\nEstablish the requirement before you start Briefing or a reviewer/);
    assert.match(req, /quote only the owner's relevant request and decisions verbatim, marking each decision as an owner decision/);
    assert.match(req, /Do not paraphrase, add reasoning, include rejected options or routine confirmations/);
    assert.match(req, /ask which requirement the diff serves instead of inferring it from the implementation/);
    assert.match(req, /even if a later run of the script prints `\(detached HEAD\)`/);
    assert.match(req, /carry only the owner's relevant answers and approvals, verbatim/);
    assert.ok(source().indexOf("## The requirement") < source().indexOf("## Briefing agent"));
  });

  it("starts a fresh non-fork reviewer for each pass and sends it nothing of the parent conversation", () => {
    const start = section("### Start a fresh reviewer");
    assert.match(start, /uses `Agent` in Claude Code or `subagent` in OpenCode to start a fresh generic child on the platform's configured model/);
    assert.match(start, /In Claude Code it must be a non-fork subagent: a fork inherits the whole conversation/);
    assert.match(start, /Do not resume a child, fork the conversation, or ask the child to invoke this skill/);
    assert.match(start, /Start the brief with `Independent review pass: review the current diff\.`/);
    assert.match(start, /the Briefing report verbatim/);
    assert.match(start, /give the exact command and its relevant output as evidence, not your interpretation/);
    assert.match(start, /Do not send the parent conversation, its reasoning, rejected options, the parent's verdicts or earlier reviewer reports/);
    assert.match(start, /not to write any file, stage, create or remove worktrees, run tests or builds, ask the owner directly or start other agents\. These are instructions, not a sandbox/);
    assert.match(section("### Who runs each pass"), /The reviewer alone makes the verdicts; the main agent does not invent, override or add verdicts or edits/);
  });

  it("has the reviewer return three fixed headings and waits for its final result on either platform", () => {
    const out = section("### What the reviewer returns");
    const heads = ["## Review report", "## Proposed code edits", "## Questions for the owner"].map((h) => out.indexOf(`\`${h}\``));
    assert.ok(heads.every((i) => i >= 0) && heads[0] < heads[1] && heads[1] < heads[2], "the three headings, in order");
    assert.match(out, /the exact old text and the exact new text, with enough unchanged context to match once, and the evidence/);
    assert.match(out, /Use an empty new text for a deletion; anchor an insertion with unchanged text included in both/);
    assert.match(out, /Write `None` if there are no edits/);
    assert.match(out, /marked as a blocker or a place question/);
    assert.match(out, /actions described as proposed, not applied/);
    assert.match(out, /Wait for the reviewer's final result from the Agent tool or the OpenCode `<subagent>` report, which may arrive later/);
  });

  it("lets only the main agent apply exact, in-scope edits and stops and asks when the reviewed state went stale", () => {
    const apply = section("### Apply the proposed edits");
    assert.match(apply, /The same lists alone do not prove the same contents/);
    assert.match(apply, /apply nothing from that result: stop and ask the owner before reviewing the changed state\. Do not take a new snapshot or spend another pass on your own/);
    assert.match(apply, /Apply an edit only when its old text matches once, the edit is permitted and it touches only files and lines already in the diff/);
    assert.match(apply, /Report an ambiguous, out-of-scope or permission-blocked edit as not applied; do not improvise a replacement or apply part of a fix/);
    assert.match(apply, /Only the main agent applies edits, in the review checkout/);
  });

  it("refreshes the diff only when it is faithful, and otherwise stops and asks what to compare", () => {
    const after = section("### After a fix");
    assert.match(after, /run the tests that cover the touched files and the build/);
    assert.match(after, /search for the callers of the changed code/);
    assert.match(after, /Do not repair a failing check yourself: give its command and output to the next fresh reviewer as evidence/);
    assert.match(after, /`ref <sha>\^` only when the fix checkout is still at that exact commit and evidence shows the result holds only the original commit plus the review fixes, with no unrelated tracked or untracked edits\. `HEAD` at the commit alone does not prove it/);
    assert.match(after, /a PR, a commit below `HEAD`, or any other case where the script cannot give a faithful combined diff: stop and ask the owner what to compare/);
    assert.match(after, /the fix has not been independently re-reviewed/);
    assert.match(after, /Do not rerun the commit or PR command as evidence of a local fix, widen the scope silently or build another way to combine diffs/);
    assert.match(after, /Keep the original requirement\. With a faithful new snapshot and passes left, start a fresh reviewer from Part A/);
  });

  it("counts review passes, caps them at five and leaves a move it cannot re-review unapplied", () => {
    assert.match(section("## Stop"), /Count review passes, not launch attempts/);
    const place = section("## Place questions");
    assert.match(place, /Relay the reviewer's questions without answering them on its behalf/);
    assert.match(place, /only the main agent moves the code/);
    assert.match(place, /only if a fresh follow-up pass can still review it within the 5-pass limit/);
    assert.match(place, /Otherwise leave the move unapplied and report the approval and why; a move approved after pass 5 is never applied\. The approval can carry into a new review/);
  });

  it("retries an unusable reviewer once, then runs inline and says so in the report", () => {
    const fallback = section("### Inline fallback");
    assert.match(fallback, /If delegation is absent or denied, run each remaining pass in the main agent under the same evidence and permission rules/);
    assert.match(fallback, /start one fresh reviewer once more with identical inputs; never apply edits from an unusable result/);
    assert.match(fallback, /An explicit prerequisite blocker with its owner question is usable/);
    assert.match(fallback, /In every fallback, whether delegation is absent or denied or a retry failed, reuse a completed Briefing report and run Briefing inline only if it has not completed/);
    assert.doesNotMatch(fallback, /run Briefing and each pass in the main agent/);
    assert.match(section("## Report"), /^\nIf any verdict pass ran inline, start the report with `Not independently reviewed: <reason>\. This review ran in the main conversation, not in a fresh reviewer subagent\.` and name the inline passes/);
  });

  it("relays every usable reviewer report verbatim, by pass, apart from the main agent's own status and notes", () => {
    const report = section("## Report");
    assert.match(report, /relay the reviewer's report verbatim, labelled with its pass number/);
    assert.match(report, /which edits were applied or not and why, which checks actually ran and their result, the questions, and what is still open/);
    assert.match(report, /Put any disagreement of the main agent in a separate note/);
    assert.match(report, /under `## Requirement given to the reviewer`/);
    assert.match(report, /Give the worktree path and ask what to do with the fixes/);
    assert.match(report, /^\| `a\.kt:30` \| no reason \| no \| n\/a \| n\/a \| n\/a \| propose reverting \|$/m);
    assert.doesNotMatch(report, /\| reverted \|/);
  });

  it("asks for the requirement instead of marking every hunk 'no reason'", () => {
    assert.match(source(), /ask which requirement the diff serves/);
  });
});
