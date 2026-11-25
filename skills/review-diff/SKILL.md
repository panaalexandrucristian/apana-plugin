---
name: review-diff
description: "Review a diff before it is committed, using a fresh reviewer subagent without the conversation that produced the code: ask what to review when no argument is given (uncommitted changes, a commit, a pull request, something else), have the reviewer challenge every changed hunk, then every new class (why, strictly necessary, aligned with the project standard, in the right place, optimal); the main agent applies the edits it proposes on the state the reviewer saw and has a fresh reviewer check the result, in a full pass or a targeted confirmation. Use when the user runs /apana:review-diff or asks to challenge, double-check or find the weak points of the changes in the diff."
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

Exit 3 means the script refused (not a git repository, no commit yet, not a commit, no common ancestor, origin not on github.com, `gh` missing or failing, and for a snapshot the reasons below): its message on stderr says why. Fix the cause and run it again, or stop and ask; do not work around a refused snapshot by hand. Exit 2 means the arguments were wrong. Only with no Node at all, take the diff by hand: `git diff HEAD` plus `git ls-files --others --exclude-standard` for uncommitted changes; `git diff X^..X` for a commit (a merge or root commit: say so and ask what to compare); for a pull request, its head and base commits from `gh pr view N -R <owner/repo> --json title,body,headRefOid,baseRefOid`, with `<owner/repo>` from `git remote get-url origin`, then `git diff <merge base of the two> <head>` (not `gh pr diff N -R <owner/repo>`, which is not bound to the commits); `git diff <merge base of the ref and HEAD>` plus the untracked files for a ref.

### The snapshot

Once the review checkout is fixed (see "Where fixes go") and before any child starts, take the snapshot of the reviewed state there, with the same target (`-C` names the review checkout when it is not the current folder):

    node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs -C <review checkout> snapshot <target>

It prints the same inventory, then `snapshot: sha256:<digest>` and the `manifest`: the checkout, `HEAD`, the branch, the target, the fixed revisions of the comparison (`base`; `new` is the commit or the PR head, or `worktree` for uncommitted changes and a ref), the SHA-256 of the exact patch and of the index, and the type and SHA-256 of every file of the diff, every other file changed in the checkout and every untracked file. For a commit or a PR, `local changes` lists the checkout's own changes outside the target. It reads everything twice and refuses when the two reads disagree, a patch cannot be parsed whole, a file cannot be read, a merge or root commit is the target, or a PR's diff cannot be bound to its head and merge base (the message says what to fetch). Keep the digest and the manifest whole for the review, with the target and the absolute path of the review checkout: they are the baseline. The script does not print the patch itself. The script's `files` and `hunks` lists stay authoritative.

    node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs -C <review checkout> verify sha256:<digest> <target>

reads the state again: exit 0 is a match, exit 4 a mismatch (it prints the manifest it found), exit 3 means it could not verify, with the reason. Only exit 0 is a match; a missing, partial or unreadable result is not. A match is not atomic with any later read or write.

Tell each child the digest, the manifest, the review checkout, the `verify` command with the script's absolute path, and how to read the same patch and files, read-only: the command the `diff` field names, run in the review checkout, and for uncommitted changes and a ref, read untracked files whole. The child runs `verify` before its first read and after its last one and bases verdicts only on what it read between two matches; otherwise it reports a blocker. For a commit or a PR, the patch is between fixed revisions while the checkout may be at a later commit: tell the child to read the new side with `git show <new>:<path>`, and for a deleted file or the old side of a rename, the pre-change revision and the old path (`git show <base>:<old path>`), with `base` and `new` from the manifest, and to treat the checkout's files as context, not as the reviewed state. The PR number and unchanged hunk coordinates do not show that a child saw the same patch: the digest does. Do not rebuild the lists, create a separate worktree for a child, or switch the review checkout silently; a child that cannot read the patch or the files reports it as a blocker.

With no Node, record the same facts by hand, read-only, twice, and compare the two records: the commits (`git rev-parse HEAD`, the base, and for a PR the two commits from `gh pr view`, the same before and after the diff), the patch as `git -c diff.autoRefreshIndex=false diff --no-ext-diff --no-textconv <revisions> | git hash-object --stdin`, `git ls-files --stage | git hash-object --stdin`, `git ls-files --others --exclude-standard`, and `git hash-object --no-filters` of every relevant file. If the records differ or a step cannot run, stop and say why. A child compares the same record before and after it reads. With no Node there is no `expect`: check each edit by hand (its old text once, the lines it changes inside the hunks) and run full passes only.

## The requirement

Establish the requirement before you start Briefing or a reviewer. Its sources are the commit message, the PR title and description, or the ticket in the branch name (the script prints them as `requirement`). For uncommitted changes or a ref whose requirement is known only from this conversation, quote only the owner's relevant request and decisions verbatim, marking each decision as an owner decision. Do not paraphrase, add reasoning, include rejected options or routine confirmations. If the requirement is missing, unclear or conflicting, ask which requirement the diff serves instead of inferring it from the implementation. Keep this text for every pass, even if a later run of the script prints `(detached HEAD)` as the branch name. Into later reviewer briefs, carry only the owner's relevant answers and approvals, verbatim.

## Where fixes go

If the target is on the current branch (`on current branch: yes`: uncommitted changes, a ref, or a commit or PR whose head is an ancestor of `HEAD`), fix in place. Otherwise create a sibling worktree `../<repo>-review-<sha8 or prN>` (the script prints it as `worktree`; for a PR: `git fetch origin pull/N/head`, then the worktree on `FETCH_HEAD`), fix there and leave the current branch untouched. That checkout is the review checkout for the snapshot, every reviewer, every edit and every check. At the end give the worktree path and ask what to do with the fixes (commit, push, leave them). Do not commit and do not delete the worktree.

## Briefing agent

By default there is no Briefing agent. Start one only when a verdict may depend on how an API, a library or a version behaves and the repo does not settle it; that the diff imports a library is not enough. Then the main agent starts one read-only Briefing subagent (`Agent` in Claude Code, `subagent` in OpenCode) for that precise question, not for a summary. It is a sibling of the reviewers, not their child: the workflow needs no nesting. Give it the question, the library and the version the repo uses, and "Web lookup", not the conversation or any verdict. It must not edit any file; the skill cannot enforce this, so say it. It answers in its final message, not a file: the version context and the primary source (URL and short quote), or "unverified". Pass the answer verbatim to the reviewer as a lead, not evidence: every verdict still cites a `file:line` or a source the reviewer read itself. Without such a question, do not start Briefing and do not make a brief wait for a Briefing report, in the fallback too.

If a reviewer raises such a question, it records it as a blocker for the verdict it affects, even when it proposes no edit. The main agent then has it researched (Briefing, or inline under the same rule when delegation is absent) and reuses the answers that still apply. After a useful answer, ask a fresh reviewer for a new verdict on that point, within the pass limit and only on a snapshot that still verifies; do not apply the edits that depend on it before that verdict. If the question stays unverified or no pass remains, report it as unresolved and do not close the review as finding nothing. Do not present an inline answer or verdict as independent.

## Each pass

A pass reviews one snapshot: Part A for every hunk, then Part B for every new class, on the same snapshot. A finding that needs a fix does not end the pass: record it with its proposed edit and go on, so that one report covers both parts. A "right place" finding is not a fix: note it and go on. Two exceptions: if something the review needs is missing (the requirement, access to the snapshot), the reviewer stops and says why, without verdicts; if a fix depends on a decision of the owner, it returns that as a question, without assuming the answer or moving code. A pass is a full pass or a targeted confirmation (see "The next pass").

### Who runs each pass

The main agent owns the loop: it starts the reviewer, applies the proposed edits, runs the checks and counts the passes. The reviewer alone makes the verdicts; the main agent does not invent, override or add verdicts or edits.

### Start a fresh reviewer

For each pass, the main agent uses `Agent` in Claude Code or `subagent` in OpenCode to start a fresh generic child on the platform's configured model. In Claude Code it must be a non-fork subagent: a fork inherits the whole conversation. Do not resume a child, fork the conversation, or ask the child to invoke this skill. Start the brief with `Independent review pass: review the current diff.` Give it the current snapshot (the target, the `files` and `hunks` lists, the digest and the manifest), how to read and verify it (see "The snapshot"), the review checkout and the relevant paths, the requirement, the owner's relevant decisions quoted verbatim and marked as owner decisions, a Briefing answer verbatim if there is one, and the applicable instructions of this skill (Each pass, Part A, Part B, the scope rule of "Apply the proposed edits", Web lookup, Report and "What the reviewer returns"). Include this line as it is: `Do not call the skill tool for review-diff and do not read its SKILL.md; the instructions you need are in this brief.` If a check failed after the previous fix and a fresh pass remains, give the exact command and its relevant output as evidence, not your interpretation. Do not send the parent conversation, its reasoning, rejected options, the parent's verdicts or earlier reviewer reports.

Tell the reviewer not to write any file, stage, create or remove worktrees, run tests or builds, ask the owner directly or start other agents; it may run the `verify` command. These are instructions, not a sandbox. The reviewer reads the patch and the files itself and cites every verdict with a `file:line` it read.

### What the reviewer returns

The reviewer returns Markdown in its final message with these fixed headings, in order:
- `## Review report`: the `verify` results, then the tables of "Report" for the parts it reached, each verdict with its cited evidence and actions described as proposed, not applied, then its proposals that conflict, then what the pass did not reach. If a prerequisite is blocked (no requirement, a patch or file it cannot read, a `verify` that does not match), say so explicitly instead of making up verdicts or table rows.
- `## Proposed code edits`: one line per edit with its id, the hunk (`file:line`) or class anchor and the evidence, then one fenced `json` block with every edit: `{"edits": [{"id": "e1", "path": "<as in files>", "old": "...", "new": "...", "depends": []}]}`. `old` and `new` are the exact old text and the exact new text, with enough unchanged context to match once. Use an empty new text for a deletion; anchor an insertion with unchanged text included in both. `depends` lists the ids that must be applied with this edit; the parts of one fix list each other. Write `None` if there are no edits.
- `## Questions for the owner`: each question in the exact wording to ask, with its evidence, marked as a blocker or a place question. Write `None` if there are no questions.

Wait for the reviewer's final result from the Agent tool or the OpenCode `<subagent>` report, which may arrive later.

### Part A: every changed hunk

1. Take every changed hunk, with its `file:line`, from the `hunks` list of the script; do not rebuild the list. In a targeted confirmation, take the hunks and changes the brief names as affected. For a file without hunks (binary, pure rename, mode change) say in one line what changed.
2. For each hunk, answer five questions with evidence, not with a bare yes or no:
   - **Why** do we make this change? Name the requirement it serves, from the requirement given in the brief (see "The requirement"). If no requirement was given, return a blocker question instead of marking every hunk "no reason". If you cannot name one for a single hunk, the answer is "no reason".
   - **Is it strictly necessary?** Would the goal still be met if the hunk were removed or smaller? Unrelated, cosmetic or speculative edits fail.
   - **Is it aligned with the project standard?** Compare with the neighbouring code in the same module (naming, layer, patterns, tests) and with `CLAUDE.md` or `docs/` if they exist. Cite the `file:line` you compared against.
   - **Is it the most optimal solution?** Name at least one alternative you considered (an existing helper or class, a platform or library API already in the project, a shorter or simpler shape) and say why the hunk is better or worse than it. If the alternative is better, the answer is "not optimal".
   - **Is it in the right place?** Does the code belong here or somewhere else (another file, class, module, layer)? Compare with where the project puts similar code and cite the `file:line`. If it belongs elsewhere, say where and why in two plain sentences. Do not move anything without the user's agreement.

### Part B: every new class

Run this part after Part A, on the same snapshot, also when Part A found something to fix. A new class is any class, object, interface, enum, sealed type, composable or file the diff adds. The files marked `A` in the script's `files` list (untracked ones too) are the first place to look. List the classes with `file:line`; if there are none, say so and finish the pass.

For each new class, answer with evidence:
- **Is it correct?** Read it whole: behaviour for its callers, edge cases (null, empty, error, cancellation), lifecycle and threading, and whether its tests cover what it does.
- **Is it strictly necessary?** Could an existing class do the job, could it be smaller (unused members, speculative parameters), or could it be merged into its only caller?
- **Is it aligned with the project standard?** Compare package, naming, injection and tests with a sibling class. Cite the `file:line`.
- **Is it in the right place?** Same rule as in Part A: does this class belong in this package or module, or elsewhere?
- **Is there a more optimal variant?** Name the alternative design you considered and why this one is better or worse.

If any answer in either part is "not optimal" (or "no reason", or "not correct"), propose the fix as an edit: revert the unneeded part, or reshape it to match the standard. If the fix needs a decision about the requirement, return it as a blocker question under `## Questions for the owner` instead of guessing.

### Apply the proposed edits

Apply nothing from a report that stopped on a missing prerequisite, even if it has partial proposals. Otherwise save the reviewer's `json` block unchanged to a file outside the review checkout (in the temporary folder: inside the checkout it would change the reviewed state), and immediately before the first write run:

    node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs -C <review checkout> expect sha256:<digest> <edits file> <target>

It first reads the state again. Exit 4 means it no longer matches the snapshot the reviewer saw, exit 3 that it cannot be verified: then apply nothing from that result, say what blocked the check and stop and ask the owner before reviewing the changed state. Do not take a new snapshot or spend another pass on your own. Otherwise it checks every edit on the reviewed bytes: its old text matches exactly once, the lines it really changes lie inside the hunks of the diff, for a commit or a PR the checkout's copy is the reviewed revision, it overlaps no other edit, every edit it depends on is accepted, and it still matches once after the edits before it. It prints `ok` or `refused` with the reason for each edit, `apply in this order:` and the `expected:` digest of the state the accepted edits must give (exit 0 when all are accepted, 5 when some are refused).

Apply an edit only when `expect` accepted it: its old text matches once, the edit is permitted and it touches only files and lines already in the diff (the one exception is a move the owner approved, see "Place questions"). Apply the accepted edits in that order, each as an exact replacement of its old text by its new text, and nothing else. Report an ambiguous, out-of-scope, conflicting or permission-blocked edit as not applied, with the reason; do not arbitrate conflicts, improvise a replacement or apply part of a fix. Only the main agent applies edits, in the review checkout.

### After a fix

Right after the edits, run `verify expected:<digest>` with the `expected:` digest that `expect` printed, the same `-C` and the same target. A match shows that the checkout is the reviewed state plus exactly the applied edits: the same `HEAD`, index and other files, nothing else. Then run the tests that cover the touched files and the build, if the repository documents one, and check that nothing broke: search for the callers of the changed code and compare the behaviour before and after. Report only what you ran; if something could not be run, say so. Do not repair a failing check yourself: give its command and output to the next fresh reviewer as evidence, if a pass remains. Then run `verify expected:` again. A mismatch after a test or build means it changed something else (a tracked file, the index, an untracked file): it blocks the targeted confirmation and does not set a new baseline. A mismatch your own edits do not explain is an outside change. In both cases stop and ask the owner what to compare; do not change the target on your own.

Then take the new diff:
- uncommitted changes or a ref: a new snapshot of the same target, when that shows the new state faithfully.
- an ordinary commit: `ref <sha>^` only when the fix checkout is still at that exact commit and evidence shows the result holds only the original commit plus the review fixes, with no unrelated tracked or untracked edits: the first snapshot's `head` is that commit, its `local changes` is `none`, and `verify expected:` matched. `HEAD` at the commit alone does not prove it.
- a PR, a commit below `HEAD`, or any other case where the script cannot give a faithful combined diff: stop and ask the owner what to compare. Say which fixes and checks were done and that the fix has not been independently re-reviewed. Do not rerun the commit or PR command as evidence of a local fix, use the applied edits in place of the diff, widen the scope silently or build another way to combine diffs.

### The next pass

Keep the original requirement. With a faithful new snapshot and passes left, start a fresh reviewer for a full pass (Part A and Part B on the whole new diff), unless a targeted confirmation is allowed: a full pass already covered the whole diff, `verify expected:` matched after the edits and after the checks, and the impact of the edits can be delimited (no contract used in several places changed). After an approved move, always run a full pass.

The brief of a targeted confirmation gives, instead of the whole diff: the new snapshot and the earlier digest; the applied edits (the saved `json` entries of the accepted edits and the `expect` lines that accepted them) and the `verify expected:` command that shows the checkout is the earlier snapshot plus exactly these edits; the hunks and the changes without hunks that the edits touched or added; the callers and dependencies they affect, with `file:line`; the requirement and the owner's relevant decisions; the commands and outputs of the checks. It gives no conversation and no earlier verdict. The reviewer verifies the delta itself, applies Part A to the affected hunks and changes without hunks and Part B to the affected new classes, also when the impact comes through a caller or a dependency, and does not run the checks.

The main agent keeps the earlier findings and the checks still open apart from the briefs. Before closing an earlier finding, it checks that the new report covers the change that would resolve it and that the evidence supports closing it. A finding outside the confirmed area stays open; a missing check is not a success. A targeted confirmation counts as one of the 5 passes. It closes the review when it finds no new problem and no finding, check or question stays open or blocked; if it proposes edits, apply them as above and go on.

### Inline fallback

If delegation is absent or denied, run each remaining pass in the main agent under the same evidence and permission rules. If a reviewer returns an unusable result (no final result, or one without the headings, verdicts or tables), start one fresh reviewer once more with identical inputs; never apply edits from an unusable result. An explicit prerequisite blocker with its owner question is usable. If the retry also fails, run the pass inline. In every fallback, whether delegation is absent or denied or a retry failed, reuse a Briefing answer that still applies and research an open Briefing question inline only if it has no answer yet. Do not use the fallback to bypass any other permission.

## Place questions

"Right place" findings do not stop the pass. At the end, ask the user about them in one list: for each, what the code is, where it sits, where it should go and why. Relay the reviewer's questions without answering them on its behalf. If the user agrees, only the main agent moves the code (the one exception to "touch only the files and lines already in the diff"), and only if a fresh follow-up pass can still review it within the 5-pass limit and `verify` still matches the snapshot right before the move; read the source and the destination first. Then run the checks of "After a fix" and start a fresh reviewer for a full pass on a faithful new snapshot. Otherwise leave the move unapplied and report the approval and why; a move approved after pass 5 is never applied. The approval can carry into a new review.

## Web lookup

Search the web only when you are not sure about a fact the answer depends on (API behaviour, deprecation, recommended pattern), and the repo does not settle it. Use primary sources only: official documentation (developer.android.com, kotlinlang.org), release notes and source of the library in question. Do not use blogs, forums or AI summaries as evidence. Cite the URL in the report. If no reliable source is found, say the point is unverified and do not base a fix on it. Search with generic terms only; never put project code, internal names or secrets in a query.

## Stop

Stop when a full pass (Part A and Part B) changes nothing, when a targeted confirmation closes the review (see "The next pass"), or after 5 passes (then list what is still open). Count review passes, not launch attempts: a retry of the same pass is not a new pass.

## Report

If any verdict pass ran inline, start the report with `Not independently reviewed: <reason>. This review ran in the main conversation, not in a fresh reviewer subagent.` and name the inline passes. Substitute the concrete failure or restriction for `<reason>`.

For each pass, relay the reviewer's report verbatim, labelled with its pass number and whether it was a full pass or a targeted confirmation, then, apart from it: which edits were applied or not and why, which checks actually ran and their result, the questions, and what is still open. Put any disagreement of the main agent in a separate note. If the requirement came from the conversation, show the exact text given to the reviewer under `## Requirement given to the reviewer`.

The reviewer's report has one table per part, one row per hunk or class, each answer in a few words with its `file:line` (the class table has a `correct` column after `optimal`):

| hunk or class | why | necessary | aligned | right place | optimal | action |
| --- | --- | --- | --- | --- | --- | --- |
| `a.kt:12` | login fix | yes | yes, like `b.kt:40` | yes | yes | none |
| `a.kt:30` | no reason | no | n/a | n/a | n/a | propose reverting |

Then the "Place questions" list. Say which checks you actually ran (build, tests); do not claim a green build you did not run. Give the worktree path and ask what to do with the fixes, as in "Where fixes go". Do not stage or commit.
