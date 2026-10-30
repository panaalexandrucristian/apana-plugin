---
name: review-diff
description: "Review a diff before it is committed: ask what to review when no argument is given (uncommitted changes, a commit, a pull request, something else), challenge every changed hunk, then every new class (why, strictly necessary, aligned with the project standard, in the right place, optimal), fix what is not optimal and repeat the whole pass. Use when the user runs /apana:review-diff or asks to challenge, double-check or find the weak points of the changes in the diff."
argument-hint: [base-ref]
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/diff-target.mjs *)
---

Go through every change in the diff, then every new class, and challenge each one.

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

Use this same diff in Part A and in Part B.

## Where fixes go

If the target is on the current branch (`on current branch: yes`: uncommitted changes, a ref, or a commit or PR whose head is an ancestor of `HEAD`), fix in place. Otherwise create a sibling worktree `../<repo>-review-<sha8 or prN>` (the script prints it as `worktree`; for a PR: `git fetch origin pull/N/head`, then the worktree on `FETCH_HEAD`), fix there and leave the current branch untouched. At the end give the worktree path and ask what to do with the fixes (commit, push, leave them). Do not commit and do not delete the worktree.

## Briefing agent

Once per invocation, after the target and the diff are fixed (in the worktree, if you made one) and before Part A, start one subagent. If the `Agent` tool is missing, do both steps yourself. Give it how to get the diff (the command or the worktree path) and the requirement from "Why". It must not edit any file; the skill cannot enforce this, so say it. Do not start it again on later passes, and start no other subagent.

1. Technical summary: per file or module, what the change does in technical terms (libraries, APIs, patterns, new classes).
2. Best practices: search the web for what the technologies the diff touches recommend. Follow "Web lookup" below: primary sources only, generic terms, neutral questions ("what does the official documentation recommend for X?", not "is Z correct?"). If the diff touches nothing external, say so and do not search.

It returns text in its final message, not a file: the summary, then a list of practice, version or context, URL, short quote (or "unverified"). Use it as context for Part A and B, not as evidence: every verdict still cites a `file:line` you read yourself, and web sources are cited in the report with their URL. A practice that contradicts the project standard is reported as an observation; it does not trigger a fix by itself.

## Each pass

A pass has two parts, in this order. A fix in either part ends the pass: go to "After a fix". A "right place" finding is not a fix: note it and go on.

### Part A: every changed hunk

1. Take every changed hunk, with its `file:line`, from the `hunks` list of the script; do not rebuild the list. For a file without hunks (binary, pure rename, mode change) say in one line what changed.
2. For each hunk, answer five questions with evidence, not with a bare yes or no:
   - **Why** do we make this change? Name the requirement it serves: for a commit its message, for a PR its title and description, for uncommitted changes the request in this session or the ticket in the branch name (the script prints the first two and the branch name as `requirement`). If there is none, ask which requirement the diff serves instead of marking every hunk "no reason". If you cannot name one for a single hunk, the answer is "no reason".
   - **Is it strictly necessary?** Would the goal still be met if the hunk were removed or smaller? Unrelated, cosmetic or speculative edits fail.
   - **Is it aligned with the project standard?** Compare with the neighbouring code in the same module (naming, layer, patterns, tests) and with `CLAUDE.md` or `docs/` if they exist. Cite the `file:line` you compared against.
   - **Is it the most optimal solution?** Name at least one alternative you considered (an existing helper or class, a platform or library API already in the project, a shorter or simpler shape) and say why the hunk is better or worse than it. If the alternative is better, the answer is "not optimal".
   - **Is it in the right place?** Does the code belong here or somewhere else (another file, class, module, layer)? Compare with where the project puts similar code and cite the `file:line`. If it belongs elsewhere, say where and why in two plain sentences. Do not move anything without the user's agreement.

### Part B: every new class

Run this part only when Part A changed nothing. Use the same diff as in Part A. A new class is any class, object, interface, enum, sealed type, composable or file the diff adds. The files marked `A` in the script's `files` list (untracked ones too) are the first place to look. List the classes with `file:line`; if there are none, say so and finish the pass.

For each new class, answer with evidence:
- **Is it correct?** Read it whole: behaviour for its callers, edge cases (null, empty, error, cancellation), lifecycle and threading, and whether its tests cover what it does.
- **Is it strictly necessary?** Could an existing class do the job, could it be smaller (unused members, speculative parameters), or could it be merged into its only caller?
- **Is it aligned with the project standard?** Compare package, naming, injection and tests with a sibling class. Cite the `file:line`.
- **Is it in the right place?** Same rule as in Part A: does this class belong in this package or module, or elsewhere?
- **Is there a more optimal variant?** Name the alternative design you considered and why this one is better or worse.

### After a fix

If any answer in either part is "not optimal" (or "no reason", or "not correct"), fix it: revert the unneeded part, or reshape it to match the standard. Touch only the files and lines already in the diff. If the fix needs a decision about the requirement, stop and ask instead of guessing.

After a fix, run the tests that cover the touched files and the build, then check that nothing broke: search for the callers of the changed code and compare the behaviour before and after. Report only what you ran; if something could not be run, say so.

Then start again from Part A, step 1, on the new diff (run the command again), and run both parts again.

## Place questions

"Right place" findings do not stop the pass. At the end, ask the user about them in one list: for each, what the code is, where it sits, where it should go and why. If the user agrees, move it (the one exception to "touch only the files already in the diff"), then start again from Part A.

## Web lookup

Search the web only when you are not sure about a fact the answer depends on (API behaviour, deprecation, recommended pattern), and the repo does not settle it. Use primary sources only: official documentation (developer.android.com, kotlinlang.org), release notes and source of the library in question. Do not use blogs, forums or AI summaries as evidence. Cite the URL in the report. If no reliable source is found, say the point is unverified and do not base a fix on it. Search with generic terms only; never put project code, internal names or secrets in a query.

## Stop

Stop when a full pass (Part A and Part B) changes nothing, or after 5 passes (then list what is still open).

## Report

One table per part, one row per hunk or class, each answer in a few words with its `file:line` (the class table has a `correct` column after `optimal`):

| hunk or class | why | necessary | aligned | right place | optimal | action |
| --- | --- | --- | --- | --- | --- | --- |
| `a.kt:12` | login fix | yes | yes, like `b.kt:40` | yes | yes | none |
| `a.kt:30` | no reason | no | n/a | n/a | n/a | reverted |

Then the "Place questions" list. Say which checks you actually ran (build, tests); do not claim a green build you did not run. Do not stage or commit.
