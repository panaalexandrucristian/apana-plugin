---
name: review-diff
description: "Review a diff before it is committed, using a fresh reviewer subagent without the conversation that produced the code: ask what to review when no argument is given (uncommitted changes, a commit, a pull request, something else), have the reviewer challenge every changed hunk, then every new class (why, strictly necessary, aligned with the project standard, in the right place, optimal); the main agent applies the edits it proposes and repeats the whole pass with a fresh reviewer. Use when the user runs /apana:review-diff or asks to challenge, double-check or find the weak points of the changes in the diff."
argument-hint: [base-ref]
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs *)
---

The main agent coordinates; a fresh reviewer subagent goes through every change in the diff, then every new class, and challenges each one. Only the reviewer makes the verdicts, and only the main agent edits files.

## What to review

If `$ARGUMENTS` is not empty, the target is that ref: everything since the merge base of the ref and `HEAD`, committed or not, and the untracked files. Run the `ref` command below with it.

If `$ARGUMENTS` is empty, review nothing yet. Ask one question in one message, "What should I review?", with these choices, then stop and wait for the next prompt:
- the uncommitted changes
- one commit (its sha)
- a pull request (its number or link)
- something else (a branch, a range)

Take the target from the answer and run the command that fits (a pull request given as a link: use its number; a branch is a ref; if a range is not exact, ask for it). The script only reads, it writes nothing:

    node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs uncommitted
    node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs commit <sha>
    node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs pr <number>
    node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs ref <ref>

It prints a summary line, then these fields, then the files and the hunks:
- `diff`: how the diff was taken.
- `on current branch`: yes, no or unknown (a PR whose head is not in this repository is unknown; treat it as no).
- `worktree`: the sibling worktree path to use when the target is not on the current branch.
- `special`: `merge` or `root`. The commit is not diffed: say so and ask what to compare.
- `repo`: owner/repo for `gh -R` (PR only).
- `requirement`: the commit message, the PR title and description, or the branch name (at most 40 lines).
- `files`: every changed file, `A` new (also the ones git does not track yet, marked `untracked`), `M`, `D`, `R`; a binary file, a pure rename and a mode change have no hunks.
- `hunks`: every changed run of lines as `file:line`, with its old and new line numbers (a delete is at the line before the removed lines, `0` at the top of the file).

Exit 3 means the script refused (not a git repository, no commit yet, not a commit, no common ancestor, origin not on github.com, `gh` missing or failing): its message on stderr says why. Fix that, or, with no Node, take the diff by hand: `git diff HEAD` plus `git ls-files --others --exclude-standard` for uncommitted changes; `git diff X^..X` for a commit (a merge or root commit: say so and ask what to compare); `gh pr view N -R <owner/repo>` and `gh pr diff N -R <owner/repo>`, with `<owner/repo>` from `git remote get-url origin`, for a pull request; `git diff <merge base of the ref and HEAD>` plus the untracked files for a ref. Exit 2 means the arguments were wrong.

Keep what the script printed for the whole review: the target (its summary line, `diff`, the sha or PR number and `repo`), the exact `files` and `hunks` lists, and the absolute path of the review checkout (see "Where fixes go"). The script does not print the patch itself. Before starting any child, the main agent records a baseline of the reviewed state: the resolved target (the commit sha; for a PR, its head commit from `gh pr view N -R <owner/repo> --json headRefOid`; for uncommitted changes and a ref, `HEAD` and the merge base), the exact patch as read with the command the `diff` field names, the index (`git diff --cached`), and the contents of the relevant files, untracked ones included. Keep each as text or as its `git hash-object` id. With no Node, the fallback commands above take the place of the script and of the `diff` command: their file list and patch are the inventory and the patch of the baseline. Tell each child how to read the same patch and files, read-only: the command the `diff` field names, run in the review checkout, and for uncommitted changes and a ref, read untracked files whole. The child must compare what it read with the baseline and report a blocker if it cannot establish the match. For a commit or a PR, the patch is between fixed revisions while the checkout may be at a later commit: tell the child to read the new side with `git show <sha>:<path>` at the recorded revision and to treat the checkout's files as context, not as the reviewed state. For a deleted file or the old side of a rename, read the pre-change revision and the old path (`git show <sha>^:<old path>` for a commit; for a PR, the merge base of its head and its base branch). The PR number and unchanged hunk coordinates do not show that a child saw the same patch: compare with the recorded revision and patch. The script's `files` and `hunks` lists stay authoritative. Do not rebuild the lists, create a separate worktree for a child, or switch the review checkout silently; a child that cannot read the patch or the files reports it as a blocker.

## The requirement

Establish the requirement before you start Briefing or a reviewer. Its sources are the commit message, the PR title and description, or the ticket in the branch name (the script prints them as `requirement`). For uncommitted changes or a ref whose requirement is known only from this conversation, quote only the owner's relevant request and decisions verbatim, marking each decision as an owner decision. Do not paraphrase, add reasoning, include rejected options or routine confirmations. If the requirement is missing, unclear or conflicting, ask which requirement the diff serves instead of inferring it from the implementation. Keep this text for every pass, even if a later run of the script prints `(detached HEAD)` as the branch name. Into later reviewer briefs, carry only the owner's relevant answers and approvals, verbatim.

## Where fixes go

If the target is on the current branch (`on current branch: yes`: uncommitted changes, a ref, or a commit or PR whose head is an ancestor of `HEAD`), fix in place. Otherwise create a sibling worktree `../<repo>-review-<sha8 or prN>` (the script prints it as `worktree`; for a PR: `git fetch origin pull/N/head`, then the worktree on `FETCH_HEAD`), fix there and leave the current branch untouched. That checkout is the review checkout for Briefing, every reviewer, every edit and every check. At the end give the worktree path and ask what to do with the fixes (commit, push, leave them). Do not commit and do not delete the worktree.

## Briefing agent

Once per invocation, after the target, the requirement and the review checkout are fixed and before the first reviewer, the main agent starts one read-only Briefing subagent (`Agent` in Claude Code, `subagent` in OpenCode). It is a sibling of the reviewers, not their child: the workflow needs no nesting. Claude Code documents configurable nesting, three layers by default; OpenCode documents that its built-in general agent cannot start children and that custom agents use their configured permissions. Neither was tested live, and the workflow relies on neither. Give it the diff access details from "What to review" and the requirement, not the conversation or any verdict. It must not edit any file; the skill cannot enforce this, so say it. Do not start it again on later passes.

1. Technical summary: per file or module, what the change does in technical terms (libraries, APIs, patterns, new classes).
2. Best practices: search the web for what the technologies the diff touches recommend. Follow "Web lookup" below: primary sources only, generic terms, neutral questions ("what does the official documentation recommend for X?", not "is Z correct?"). If the diff touches nothing external, say so and do not search.

It returns text in its final message, not a file: the summary, then a list of practice, version or context, URL, short quote (or "unverified"). Pass this report verbatim to each reviewer as leads, not evidence: every verdict still cites a `file:line` the reviewer read itself, and web sources are cited in the report with their URL, following "Web lookup". A practice that contradicts the project standard is reported as an observation; it does not trigger a fix by itself.

## Each pass

A pass reviews one snapshot of the diff: Part A, then Part B, on the same diff. A finding that needs a fix in either part ends the pass: the reviewer names what it did not reach, and the main agent goes to "Apply the proposed edits". A "right place" finding is not a fix: note it and go on.

### Who runs each pass

The main agent owns the loop: it starts the reviewer, applies the proposed edits, runs the checks and counts the passes. The reviewer alone makes the verdicts; the main agent does not invent, override or add verdicts or edits.

### Start a fresh reviewer

For each pass, the main agent uses `Agent` in Claude Code or `subagent` in OpenCode to start a fresh generic child on the platform's configured model. In Claude Code it must be a non-fork subagent: a fork inherits the whole conversation. Do not resume a child, fork the conversation, or ask the child to invoke this skill. Start the brief with `Independent review pass: review the current diff.` Give it the current snapshot (the target and the `files` and `hunks` lists) and how to read the patch and the files, the baseline and the instruction to verify the patch and the files against it, the review checkout and the relevant paths, the requirement, the owner's relevant decisions quoted verbatim and marked as owner decisions, the Briefing report verbatim, and the applicable instructions of this skill (Each pass, Part A, Part B, the scope rule of "Apply the proposed edits", Web lookup, Report and "What the reviewer returns"). If a check failed after the previous fix and a fresh pass remains, give the exact command and its relevant output as evidence, not your interpretation. Do not send the parent conversation, its reasoning, rejected options, the parent's verdicts or earlier reviewer reports.

Tell the reviewer not to write any file, stage, create or remove worktrees, run tests or builds, ask the owner directly or start other agents. These are instructions, not a sandbox. The reviewer reads the patch and the files itself and cites every verdict with a `file:line` it read.

### What the reviewer returns

The reviewer returns Markdown in its final message with these fixed headings, in order:
- `## Review report`: the tables of "Report" for the parts it reached, each verdict with its cited evidence and actions described as proposed, not applied, then what the pass did not reach. If a prerequisite is blocked (no requirement, a patch or file it cannot read), say so explicitly instead of making up verdicts or table rows.
- `## Proposed code edits`: for each edit, the path, the hunk (`file:line`) or class anchor, the exact old text and the exact new text, with enough unchanged context to match once, and the evidence. Use an empty new text for a deletion; anchor an insertion with unchanged text included in both. Write `None` if there are no edits.
- `## Questions for the owner`: each question in the exact wording to ask, with its evidence, marked as a blocker or a place question. Write `None` if there are no questions.

Wait for the reviewer's final result from the Agent tool or the OpenCode `<subagent>` report, which may arrive later.

### Part A: every changed hunk

1. Take every changed hunk, with its `file:line`, from the `hunks` list of the script; do not rebuild the list. For a file without hunks (binary, pure rename, mode change) say in one line what changed.
2. For each hunk, answer five questions with evidence, not with a bare yes or no:
   - **Why** do we make this change? Name the requirement it serves, from the requirement given in the brief (see "The requirement"). If no requirement was given, return a blocker question instead of marking every hunk "no reason". If you cannot name one for a single hunk, the answer is "no reason".
   - **Is it strictly necessary?** Would the goal still be met if the hunk were removed or smaller? Unrelated, cosmetic or speculative edits fail.
   - **Is it aligned with the project standard?** Compare with the neighbouring code in the same module (naming, layer, patterns, tests) and with `CLAUDE.md` or `docs/` if they exist. Cite the `file:line` you compared against.
   - **Is it the most optimal solution?** Name at least one alternative you considered (an existing helper or class, a platform or library API already in the project, a shorter or simpler shape) and say why the hunk is better or worse than it. If the alternative is better, the answer is "not optimal".
   - **Is it in the right place?** Does the code belong here or somewhere else (another file, class, module, layer)? Compare with where the project puts similar code and cite the `file:line`. If it belongs elsewhere, say where and why in two plain sentences. Do not move anything without the user's agreement.

### Part B: every new class

Run this part only when Part A found nothing that needs a fix. Use the same diff as in Part A. A new class is any class, object, interface, enum, sealed type, composable or file the diff adds. The files marked `A` in the script's `files` list (untracked ones too) are the first place to look. List the classes with `file:line`; if there are none, say so and finish the pass.

For each new class, answer with evidence:
- **Is it correct?** Read it whole: behaviour for its callers, edge cases (null, empty, error, cancellation), lifecycle and threading, and whether its tests cover what it does.
- **Is it strictly necessary?** Could an existing class do the job, could it be smaller (unused members, speculative parameters), or could it be merged into its only caller?
- **Is it aligned with the project standard?** Compare package, naming, injection and tests with a sibling class. Cite the `file:line`.
- **Is it in the right place?** Same rule as in Part A: does this class belong in this package or module, or elsewhere?
- **Is there a more optimal variant?** Name the alternative design you considered and why this one is better or worse.

If any answer in either part is "not optimal" (or "no reason", or "not correct"), propose the fix as an edit: revert the unneeded part, or reshape it to match the standard. If the fix needs a decision about the requirement, return it as a blocker question under `## Questions for the owner` instead of guessing.

### Apply the proposed edits

Before applying anything, the main agent checks that the reviewed state still holds: read the reviewed state again from the same read-only source as the baseline (the same script command and the patch command its `diff` field names, or, with no Node, the same fallback commands), compare the exact patch and the file and hunk lists with the baseline, compare the target, the index and the relevant files with the baseline recorded before the pass, and check that each edit's old text is still in its file exactly as reviewed. The same lists alone do not prove the same contents. If the target, the index, the patch or a relevant file changed and the result no longer matches the reviewed state, apply nothing from that result: stop and ask the owner before reviewing the changed state. Do not take a new snapshot or spend another pass on your own.

Apply an edit only when its old text matches once, the edit is permitted and it touches only files and lines already in the diff (the one exception is a move the owner approved, see "Place questions"). Report an ambiguous, out-of-scope or permission-blocked edit as not applied; do not improvise a replacement or apply part of a fix. Only the main agent applies edits, in the review checkout.

### After a fix

After a fix, run the tests that cover the touched files and the build, then check that nothing broke: search for the callers of the changed code and compare the behaviour before and after. Report only what you ran; if something could not be run, say so. Do not repair a failing check yourself: give its command and output to the next fresh reviewer as evidence, if a pass remains.

Then take the new diff:
- uncommitted changes or a ref: run the same command again against the same target, when that shows the new state faithfully.
- an ordinary commit: `ref <sha>^` only when the fix checkout is still at that exact commit and evidence shows the result holds only the original commit plus the review fixes, with no unrelated tracked or untracked edits. `HEAD` at the commit alone does not prove it.
- a PR, a commit below `HEAD`, or any other case where the script cannot give a faithful combined diff: stop and ask the owner what to compare. Say which fixes and checks were done and that the fix has not been independently re-reviewed. Do not rerun the commit or PR command as evidence of a local fix, widen the scope silently or build another way to combine diffs.

Keep the original requirement. With a faithful new snapshot and passes left, start a fresh reviewer from Part A.

### Inline fallback

If delegation is absent or denied, run each remaining pass in the main agent under the same evidence and permission rules. If a reviewer returns an unusable result (no final result, or one without the headings, verdicts or tables), start one fresh reviewer once more with identical inputs; never apply edits from an unusable result. An explicit prerequisite blocker with its owner question is usable. If the retry also fails, run the pass inline. In every fallback, whether delegation is absent or denied or a retry failed, reuse a completed Briefing report and run Briefing inline only if it has not completed. Do not use the fallback to bypass any other permission.

## Place questions

"Right place" findings do not stop the pass. At the end, ask the user about them in one list: for each, what the code is, where it sits, where it should go and why. Relay the reviewer's questions without answering them on its behalf. If the user agrees, only the main agent moves the code (the one exception to "touch only the files and lines already in the diff"), and only if a fresh follow-up pass can still review it within the 5-pass limit; then run the checks of "After a fix" and start a fresh reviewer from Part A. Otherwise leave the move unapplied and report the approval and why; a move approved after pass 5 is never applied. The approval can carry into a new review.

## Web lookup

Search the web only when you are not sure about a fact the answer depends on (API behaviour, deprecation, recommended pattern), and the repo does not settle it. Use primary sources only: official documentation (developer.android.com, kotlinlang.org), release notes and source of the library in question. Do not use blogs, forums or AI summaries as evidence. Cite the URL in the report. If no reliable source is found, say the point is unverified and do not base a fix on it. Search with generic terms only; never put project code, internal names or secrets in a query.

## Stop

Stop when a full pass (Part A and Part B) changes nothing, or after 5 passes (then list what is still open). Count review passes, not launch attempts: a retry of the same pass is not a new pass.

## Report

If any verdict pass ran inline, start the report with `Not independently reviewed: <reason>. This review ran in the main conversation, not in a fresh reviewer subagent.` and name the inline passes. Substitute the concrete failure or restriction for `<reason>`.

For each pass, relay the reviewer's report verbatim, labelled with its pass number, then, apart from it: which edits were applied or not and why, which checks actually ran and their result, the questions, and what is still open. Put any disagreement of the main agent in a separate note. If the requirement came from the conversation, show the exact text given to the reviewer under `## Requirement given to the reviewer`.

The reviewer's report has one table per part, one row per hunk or class, each answer in a few words with its `file:line` (the class table has a `correct` column after `optimal`):

| hunk or class | why | necessary | aligned | right place | optimal | action |
| --- | --- | --- | --- | --- | --- | --- |
| `a.kt:12` | login fix | yes | yes, like `b.kt:40` | yes | yes | none |
| `a.kt:30` | no reason | no | n/a | n/a | n/a | propose reverting |

Then the "Place questions" list. Say which checks you actually ran (build, tests); do not claim a green build you did not run. Give the worktree path and ask what to do with the fixes, as in "Where fixes go". Do not stage or commit.
