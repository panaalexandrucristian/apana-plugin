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
    assert.match(match[1], /the main agent applies the edits it proposes on the state the reviewer saw and has a fresh reviewer check the result, in a full pass or a targeted confirmation/);
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
    assert.match(text, /Only with no Node at all, take the diff by hand: `git diff HEAD` plus `git ls-files --others --exclude-standard` for uncommitted changes/);
    assert.match(text, /for a pull request, its head and base commits from `gh pr view N -R <owner\/repo> --json title,body,headRefOid,baseRefOid`/);
    assert.match(text, /\(not `gh pr diff N -R <owner\/repo>`, which is not bound to the commits\)/);
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

  it("starts a read-only Briefing sibling only for a technical question the repo does not settle", () => {
    const brief = section("## Briefing agent");
    assert.match(brief, /^\nBy default there is no Briefing agent\. Start one only when a verdict may depend on how an API, a library or a version behaves and the repo does not settle it; that the diff imports a library is not enough/);
    assert.match(brief, /for that precise question, not for a summary/);
    assert.match(brief, /It is a sibling of the reviewers, not their child: the workflow needs no nesting/);
    assert.match(brief, /must not edit any file/);
    assert.match(brief, /It answers in its final message, not a file: the version context and the primary source \(URL and short quote\), or "unverified"/);
    assert.match(brief, /Pass the answer verbatim to the reviewer as a lead, not evidence/);
    assert.match(brief, /Without such a question, do not start Briefing and do not make a brief wait for a Briefing report, in the fallback too/);
    assert.doesNotMatch(brief, /Once per invocation/);
  });

  it("treats a late Briefing question as a blocker and does not close the review on an unverified answer", () => {
    const brief = section("## Briefing agent");
    assert.match(brief, /If a reviewer raises such a question, it records it as a blocker for the verdict it affects, even when it proposes no edit/);
    assert.match(brief, /reuses the answers that still apply/);
    assert.match(brief, /ask a fresh reviewer for a new verdict on that point, within the pass limit and only on a snapshot that still verifies; do not apply the edits that depend on it before that verdict/);
    assert.match(brief, /If the question stays unverified or no pass remains, report it as unresolved and do not close the review as finding nothing\. Do not present an inline answer or verdict as independent/);
  });

  it("runs Part A and Part B on the same snapshot and reports both before anything is applied", () => {
    const pass = section("## Each pass");
    assert.match(pass, /A pass reviews one snapshot: Part A for every hunk, then Part B for every new class, on the same snapshot/);
    assert.match(pass, /A finding that needs a fix does not end the pass: record it with its proposed edit and go on, so that one report covers both parts/);
    assert.match(pass, /A "right place" finding is not a fix: note it and go on/);
    assert.match(pass, /if something the review needs is missing \(the requirement, access to the snapshot\), the reviewer stops and says why, without verdicts/);
    assert.match(pass, /if a fix depends on a decision of the owner, it returns that as a question, without assuming the answer or moving code/);
    assert.doesNotMatch(pass, /ends the pass/);
    assert.match(section("### Part B: every new class"), /^\nRun this part after Part A, on the same snapshot, also when Part A found something to fix\./);
    assert.ok(!source().includes("`git diff --diff-filter=A` plus untracked files"));
    assert.match(section("### Part B: every new class"), /If the fix needs a decision about the requirement, return it as a blocker question under `## Questions for the owner` instead of guessing/);
    assert.doesNotMatch(section("### Part B: every new class"), /ask instead of guessing/);
    assert.match(section("### Apply the proposed edits"), /^\nApply nothing from a report that stopped on a missing prerequisite, even if it has partial proposals/);
  });

  it("gives the children the snapshot and read-only access to the reviewed patch and files", () => {
    const intake = section("## What to review");
    assert.match(intake, /Tell each child the digest, the manifest, the review checkout, the `verify` command with the script's absolute path, and how to read the same patch and files, read-only/);
    assert.match(intake, /The script does not print the patch itself/);
    assert.match(intake, /read untracked files whole/);
    assert.match(intake, /the checkout may be at a later commit: tell the child to read the new side with `git show <new>:<path>`/);
    assert.match(intake, /treat the checkout's files as context, not as the reviewed state/);
    assert.match(intake, /Do not rebuild the lists, create a separate worktree for a child, or switch the review checkout silently/);
    assert.match(intake, /a child that cannot read the patch or the files reports it as a blocker/);
  });

  it("takes a snapshot of the reviewed state before any child starts and has the child verify it read the same state", () => {
    const intake = section("## What to review");
    assert.match(intake, /Once the review checkout is fixed \(see "Where fixes go"\) and before any child starts, take the snapshot of the reviewed state there/);
    assert.match(intake, /^ {4}node \$\{CLAUDE_SKILL_DIR\}\/scripts\/diff-target\.mjs -C <review checkout> snapshot <target>$/m);
    assert.match(intake, /the fixed revisions of the comparison/);
    assert.match(intake, /the SHA-256 of the exact patch and of the index/);
    assert.match(intake, /every other file changed in the checkout and every untracked file/);
    assert.match(intake, /For a commit or a PR, `local changes` lists the checkout's own changes outside the target/);
    assert.match(intake, /It reads everything twice and refuses when the two reads disagree/);
    assert.match(intake, /The child runs `verify` before its first read and after its last one and bases verdicts only on what it read between two matches; otherwise it reports a blocker/);
    assert.match(intake, /The PR number and unchanged hunk coordinates do not show that a child saw the same patch: the digest does/);
    assert.match(intake, /for a deleted file or the old side of a rename, the pre-change revision and the old path/);
    assert.match(intake, /The script's `files` and `hunks` lists stay authoritative/);
    assert.match(section("### Start a fresh reviewer"), /Give it the current snapshot \(the target, the `files` and `hunks` lists, the digest and the manifest\), how to read and verify it/);
  });

  it("counts only exit 0 of verify as a match, never works around a refusal, and keeps a read-only fallback without Node", () => {
    const intake = section("## What to review");
    assert.match(intake, /^ {4}node \$\{CLAUDE_SKILL_DIR\}\/scripts\/diff-target\.mjs -C <review checkout> verify sha256:<digest> <target>$/m);
    assert.match(intake, /exit 0 is a match, exit 4 a mismatch \(it prints the manifest it found\), exit 3 means it could not verify, with the reason\. Only exit 0 is a match; a missing, partial or unreadable result is not\. A match is not atomic with any later read or write/);
    assert.match(intake, /do not work around a refused snapshot by hand/);
    assert.match(intake, /With no Node, record the same facts by hand, read-only, twice, and compare the two records/);
    assert.match(intake, /`git -c diff\.autoRefreshIndex=false diff --no-ext-diff --no-textconv <revisions> \| git hash-object --stdin`/);
    assert.match(intake, /If the records differ or a step cannot run, stop and say why/);
    assert.match(intake, /With no Node there is no `expect`: check each edit by hand \(its old text once, the lines it changes inside the hunks\) and run full passes only/);
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
    assert.match(start, /a Briefing answer verbatim if there is one/);
    assert.match(start, /give the exact command and its relevant output as evidence, not your interpretation/);
    assert.match(start, /Do not send the parent conversation, its reasoning, rejected options, the parent's verdicts or earlier reviewer reports/);
    assert.match(start, /not to write any file, stage, create or remove worktrees, run tests or builds, ask the owner directly or start other agents; it may run the `verify` command\. These are instructions, not a sandbox/);
    assert.match(section("### Who runs each pass"), /The reviewer alone makes the verdicts; the main agent does not invent, override or add verdicts or edits/);
  });

  it("tells the reviewer, in a line copied as it is, not to load the skill again", () => {
    assert.match(section("### Start a fresh reviewer"), /Include this line as it is: `Do not call the skill tool for review-diff and do not read its SKILL\.md; the instructions you need are in this brief\.`/);
  });

  it("has the reviewer return three fixed headings, with its edits as one json block, and waits for its final result on either platform", () => {
    const out = section("### What the reviewer returns");
    const heads = ["## Review report", "## Proposed code edits", "## Questions for the owner"].map((h) => out.indexOf(`\`${h}\``));
    assert.ok(heads.every((i) => i >= 0) && heads[0] < heads[1] && heads[1] < heads[2], "the three headings, in order");
    assert.match(out, /the `verify` results, then the tables of "Report" for the parts it reached/);
    assert.match(out, /then its proposals that conflict, then what the pass did not reach/);
    assert.match(out, /If a prerequisite is blocked \(no requirement, a patch or file it cannot read, a `verify` that does not match\), say so explicitly instead of making up verdicts or table rows/);
    assert.match(out, /one fenced `json` block with every edit: `\{"edits": \[\{"id": "e1", "path": "<as in files>", "old": "\.\.\.", "new": "\.\.\.", "depends": \[\]\}\]\}`/);
    assert.match(out, /`old` and `new` are the exact old text and the exact new text, with enough unchanged context to match once/);
    assert.match(out, /`depends` lists the ids that must be applied with this edit; the parts of one fix list each other/);
    assert.match(out, /Use an empty new text for a deletion; anchor an insertion with unchanged text included in both/);
    assert.match(out, /Write `None` if there are no edits/);
    assert.match(out, /marked as a blocker or a place question/);
    assert.match(out, /actions described as proposed, not applied/);
    assert.match(out, /Wait for the reviewer's final result from the Agent tool or the OpenCode `<subagent>` report, which may arrive later/);
  });

  it("lets only the main agent apply the edits expect accepted, and stops and asks when the reviewed state went stale", () => {
    const apply = section("### Apply the proposed edits");
    assert.match(apply, /save the reviewer's `json` block unchanged to a file outside the review checkout/);
    assert.match(apply, /^ {4}node \$\{CLAUDE_SKILL_DIR\}\/scripts\/diff-target\.mjs -C <review checkout> expect sha256:<digest> <edits file> <target>$/m);
    assert.match(apply, /Exit 4 means it no longer matches the snapshot the reviewer saw, exit 3 that it cannot be verified: then apply nothing from that result, say what blocked the check and stop and ask the owner before reviewing the changed state\. Do not take a new snapshot or spend another pass on your own/);
    assert.match(apply, /its old text matches exactly once, the lines it really changes lie inside the hunks of the diff, for a commit or a PR the checkout's copy is the reviewed revision, it overlaps no other edit, every edit it depends on is accepted, and it still matches once after the edits before it/);
    assert.match(apply, /Apply an edit only when `expect` accepted it: its old text matches once, the edit is permitted and it touches only files and lines already in the diff/);
    assert.match(apply, /Report an ambiguous, out-of-scope, conflicting or permission-blocked edit as not applied, with the reason; do not arbitrate conflicts, improvise a replacement or apply part of a fix/);
    assert.match(apply, /Only the main agent applies edits, in the review checkout/);
  });

  it("checks the result of the edits against the expected state and refreshes the diff only when it is faithful", () => {
    const after = section("### After a fix");
    assert.match(after, /^\nRight after the edits, run `verify expected:<digest>` with the `expected:` digest that `expect` printed, the same `-C` and the same target/);
    assert.match(after, /run the tests that cover the touched files and the build/);
    assert.match(after, /search for the callers of the changed code/);
    assert.match(after, /Do not repair a failing check yourself: give its command and output to the next fresh reviewer as evidence/);
    assert.match(after, /Then run `verify expected:` again\. A mismatch after a test or build means it changed something else \(a tracked file, the index, an untracked file\): it blocks the targeted confirmation and does not set a new baseline/);
    assert.match(after, /A mismatch your own edits do not explain is an outside change\. In both cases stop and ask the owner what to compare; do not change the target on your own/);
    assert.match(after, /`ref <sha>\^` only when the fix checkout is still at that exact commit and evidence shows the result holds only the original commit plus the review fixes, with no unrelated tracked or untracked edits: the first snapshot's `head` is that commit, its `local changes` is `none`, and `verify expected:` matched\. `HEAD` at the commit alone does not prove it/);
    assert.match(after, /a PR, a commit below `HEAD`, or any other case where the script cannot give a faithful combined diff: stop and ask the owner what to compare/);
    assert.match(after, /the fix has not been independently re-reviewed/);
    assert.match(after, /Do not rerun the commit or PR command as evidence of a local fix, use the applied edits in place of the diff, widen the scope silently or build another way to combine diffs/);
  });

  it("allows a targeted confirmation only after a full pass, with a proven delta and a delimited impact", () => {
    const next = section("### The next pass");
    assert.match(next, /^\nKeep the original requirement\. With a faithful new snapshot and passes left, start a fresh reviewer for a full pass \(Part A and Part B on the whole new diff\), unless a targeted confirmation is allowed: a full pass already covered the whole diff, `verify expected:` matched after the edits and after the checks, and the impact of the edits can be delimited \(no contract used in several places changed\)\. After an approved move, always run a full pass/);
    assert.match(next, /the applied edits \(the saved `json` entries of the accepted edits and the `expect` lines that accepted them\) and the `verify expected:` command that shows the checkout is the earlier snapshot plus exactly these edits/);
    assert.match(next, /It gives no conversation and no earlier verdict\. The reviewer verifies the delta itself, applies Part A to the affected hunks and changes without hunks and Part B to the affected new classes, also when the impact comes through a caller or a dependency, and does not run the checks/);
  });

  it("keeps earlier findings open until a report covers them, and counts a targeted confirmation as a pass", () => {
    const next = section("### The next pass");
    assert.match(next, /Before closing an earlier finding, it checks that the new report covers the change that would resolve it and that the evidence supports closing it\. A finding outside the confirmed area stays open; a missing check is not a success/);
    assert.match(next, /A targeted confirmation counts as one of the 5 passes\. It closes the review when it finds no new problem and no finding, check or question stays open or blocked/);
    assert.match(section("## Stop"), /when a targeted confirmation closes the review \(see "The next pass"\)/);
  });

  it("counts review passes, caps them at five and leaves a move it cannot re-review unapplied", () => {
    assert.match(section("## Stop"), /Count review passes, not launch attempts/);
    const place = section("## Place questions");
    assert.match(place, /Relay the reviewer's questions without answering them on its behalf/);
    assert.match(place, /only the main agent moves the code/);
    assert.match(place, /only if a fresh follow-up pass can still review it within the 5-pass limit and `verify` still matches the snapshot right before the move; read the source and the destination first/);
    assert.match(place, /start a fresh reviewer for a full pass on a faithful new snapshot/);
    assert.match(place, /Otherwise leave the move unapplied and report the approval and why; a move approved after pass 5 is never applied\. The approval can carry into a new review/);
  });

  it("retries an unusable reviewer once, then runs inline and says so in the report", () => {
    const fallback = section("### Inline fallback");
    assert.match(fallback, /If delegation is absent or denied, run each remaining pass in the main agent under the same evidence and permission rules/);
    assert.match(fallback, /start one fresh reviewer once more with identical inputs; never apply edits from an unusable result/);
    assert.match(fallback, /An explicit prerequisite blocker with its owner question is usable/);
    assert.match(fallback, /In every fallback, whether delegation is absent or denied or a retry failed, reuse a Briefing answer that still applies and research an open Briefing question inline only if it has no answer yet/);
    assert.doesNotMatch(fallback, /run Briefing and each pass in the main agent/);
    assert.match(section("## Report"), /^\nIf any verdict pass ran inline, start the report with `Not independently reviewed: <reason>\. This review ran in the main conversation, not in a fresh reviewer subagent\.` and name the inline passes/);
  });

  it("relays every usable reviewer report verbatim, by pass, apart from the main agent's own status and notes", () => {
    const report = section("## Report");
    assert.match(report, /relay the reviewer's report verbatim, labelled with its pass number and whether it was a full pass or a targeted confirmation/);
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
