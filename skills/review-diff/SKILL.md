---
name: review-diff
description: "Review a diff before it is committed: challenge every changed hunk, then every new class (why, strictly necessary, aligned with the project standard, optimal), fix what is not optimal and repeat the whole pass. Use when the user runs /apana:review-diff or asks to challenge, double-check or find the weak points of the changes in the diff."
argument-hint: [base-ref]
---

Go through every change in the diff, then every new class, and challenge each one.

Diff to review: if `$ARGUMENTS` is empty, the uncommitted changes (`git diff HEAD` plus the untracked files in `git status --short`); otherwise everything since that ref (`git diff $ARGUMENTS...HEAD` plus uncommitted changes).

## Each pass

A pass has two parts, in this order. A fix in either part ends the pass: go to "After a fix".

### Part A: every changed hunk

1. List every changed hunk with `file:line`.
2. For each hunk, answer four questions with evidence, not with a bare yes or no:
   - **Why** do we make this change? Name the requirement it serves (ticket from the branch name, commit message, or the request in this session). If you cannot name one, the answer is "no reason".
   - **Is it strictly necessary?** Would the goal still be met if the hunk were removed or smaller? Unrelated, cosmetic or speculative edits fail.
   - **Is it aligned with the project standard?** Compare with the neighbouring code in the same module (naming, layer, patterns, tests) and with `CLAUDE.md` or `docs/` if they exist. Cite the `file:line` you compared against.
   - **Is it the most optimal solution?** Name at least one alternative you considered (an existing helper or class, a platform or library API already in the project, a shorter or simpler shape) and say why the hunk is better or worse than it. If the alternative is better, the answer is "not optimal".

### Part B: every new class

Run this part only when Part A changed nothing. A new class is any class, object, interface, enum, sealed type, composable or file the diff adds (`git diff --diff-filter=A` plus untracked files). List them with `file:line`; if there are none, say so and finish the pass.

For each new class, answer with evidence:
- **Is it correct?** Read it whole: behaviour for its callers, edge cases (null, empty, error, cancellation), lifecycle and threading, and whether its tests cover what it does.
- **Is it strictly necessary?** Could an existing class do the job, could it be smaller (unused members, speculative parameters), or could it be merged into its only caller?
- **Is it aligned with the project standard?** Compare package, naming, injection and tests with a sibling class. Cite the `file:line`.
- **Is there a more optimal variant?** Name the alternative design you considered and why this one is better or worse.

### After a fix

If any answer in either part is "not optimal" (or "no reason", or "not correct"), fix it: revert the unneeded part, or reshape it to match the standard. Touch only the files and lines already in the diff. If the fix needs a decision about the requirement, stop and ask instead of guessing.

After any fix, including a fix to a class, start again from Part A, step 1, on the new diff, and run both parts again.

## Web lookup

Search the web only when you are not sure about a fact the answer depends on (API behaviour, deprecation, recommended pattern), and the repo does not settle it. Use primary sources only: official documentation (developer.android.com, kotlinlang.org), release notes and source of the library in question. Do not use blogs, forums or AI summaries as evidence. Cite the URL in the report. If no reliable source is found, say the point is unverified and do not base a fix on it. Search with generic terms only; never put project code, internal names or secrets in a query.

## Stop

Stop when a full pass (Part A and Part B) changes nothing, or after 5 passes (then list what is still open).

## Report

A short table per part: hunk or class, why, necessary, aligned, optimal (and correct for classes), action taken. Say which checks you actually ran (build, tests); do not claim a green build you did not run. Do not stage or commit.
