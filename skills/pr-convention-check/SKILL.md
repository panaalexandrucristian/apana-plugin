---
name: pr-convention-check
description: "Read-only check of a diff against the live conventions of a repository: splits the diff into user-visible features and technical decisions, compares each decision element by element with the 3-4 most recent comparable commits on a reference branch the user names, and classifies every deviation as justified, to fix or to decide. Use when the user runs /apana:pr-convention-check, asks whether a PR or diff follows how the rest of the app is written, or says \"verifică dacă ce am făcut e aliniat cu restul aplicației\", \"compară cu commiturile recente\", \"split pe funcționalități și decizii tehnice\"."
argument-hint: [ref]
---

# pr-convention-check

## Purpose
For a given diff, split it into features and technical decisions, find for each decision the 3-4 most recent comparable changes on the reference `<ref>`, compare their structure element by element, and say which deviations are justified, which must be fixed and which need a decision.

## When it applies / when it does not
- Applies: after implementation, before a PR or before splitting it, when you want a check against the live conventions of the repository (not only against its docs).
- Does not apply: reviewing someone else's PR, code that is not written yet, a review that edits the code in place (use `/apana:review-diff`).

## Strict rules
- Read-only towards the analysed repository: no checkout, edit, stage, stash, commit, push, fetch, gradle. `git stash list` is allowed only as a check.
- Read references with `git show <hash>`, `git show <ref>:<path>`, `git log`, `git grep`.
- Report only verified facts, each with `hash` + `file:line`. For your own code the hash is `HEAD`'s (or the commit that made the change) and the line is the real one in that file: read it with `git show HEAD:<file>` or `git grep -n <text> HEAD -- <file>`, because `git diff` has no absolute line numbers and a hunk position such as "old line 134" is not a `file:line`; for local changes that have no commit, name the working tree, index or untracked file and the real line instead of a hash.
- A quote or line of a reference comes from that reference's own revision: read it with `git show <hash>:<file>` (the file as that commit left it) and copy the code and the line number from that output. Never take it from `<base>`, `HEAD` or the tip of `<ref>` and put the commit's hash on it, because the code may have changed since: cite code read at the tip of `<ref>` as `<ref>:<file>:<line>`.
- Label every number with what it counts (files, occurrences, commits) and the command that gave it: `git grep -c` lists files, and the sum of its counts is occurrences. Copy each number from the output of that command: do not add up, count by eye or estimate.
- Concise, functional answer; no unsolicited warnings.
- If the repository docs conflict with one of the user's preferences, apply the docs and propose deleting (or updating) the preference. Change nothing yourself.

## Steps

### 1. Ask for `<ref>` and delimit the diff
- Ask for `<ref>` on every run (a value passed with the command is a candidate for `<ref>`, not the answer). Do not pick `origin/develop` or `origin/HEAD` yourself. Show its last commit date: `git log -1 --format=%cd --date=short <ref>`. Without a fetch, `<ref>` is only as fresh as the last fetch (https://git-scm.com/docs/git-fetch): say so in the report.
- Use the target from the request. If it is missing, ask once, without assuming: the whole PR (`git diff -M <base>...HEAD`, three dots: the diff against the common ancestor; two dots compare the tips, and changes that entered `<base>` meanwhile look like yours, https://git-scm.com/docs/git-diff), or local changes (staged, unstaged or both; with or without untracked files).
- Propose `<base>` from `git merge-base <ref> HEAD` and let the user confirm it.
- `git diff --numstat -M <base>...HEAD` (or the confirmed local command) for lines per file; separate production from tests. Do not touch the index to read untracked files.

### 2. Split by features
Functional = changes what the user sees or does (UI, timing, animation, behaviour). For each feature: one sentence "what the user sees" + the files.

### 3. Split by technical decisions
A decision is a "how" with its own meaning, not a file. Illustrative examples (from a past use; the list is not exhaustive, adapt it to the diff, it is not a mandatory taxonomy):
- adding an experiment (declaration, cohort observation, exposure);
- a flag threaded through UiState / input / mapper / presenter;
- a new event on a listener + hook in a ViewHolder;
- transient state in a view (timer, animators, reduced motion);
- DI and module dependencies; tests.

### 4. Find references
- For each decision: the 3-4 most recent comparable changes, newest first, from `git log <ref> --no-merges -N -- <paths>` and `git grep <symbol> <ref> -- <paths>`. Read the code with `git show`. Record hash, commit date and whether it is in the same module. Say when a reference is old.
- Always continue with what you found; never stop to ask. 2 or more references meet the criterion for that decision. 1 reference: "single precedent", criterion unmet, not a convention. 0: "no precedent", verdict (c), criterion unmet.
- Look for convention docs on `<ref>` (`git ls-tree -r --name-only <ref> | grep -iE 'AGENTS.md|CONTRIBUTING|^docs/'`) and read only the relevant sections. If there are none, say so: the neighbouring code is the standard.

### 5. Compare element by element
One full table per reference: aspect | reference does | I do | same? | `hash` `file:line`. The "reference does" cell and its line come from `git show <hash>:<file>` at that hash. A quote in backticks is one line copied verbatim: check it with `git grep -n -F '<quote>' <hash> -- <file>`; no output means it is not at that hash, so quote the line that `git show <hash>:<file>` shows, or describe it without backticks.
Typical aspects: naming, layer/module, API shape (Flow vs suspend, return type), who owns the scope, who deduplicates, DI, build dependencies, test structure.

### 6. Verdict on each deviation
- (a) justified: the real reason;
- (b) to fix: what exactly changes, and in which file;
- (c) unclear: which decision is missing and who takes it (product / design / you).

### 7. Re-verify what needs action
Every (b) deviation is read again directly in the code (`git show <hash>:<file>` for the reference, the real diff for yours) before the report. Do not rely on a summary alone.

### 8. Report
1. Features table: feature | what the user sees | production files | test files.
2. Decisions table: decision | files | references (hash + date) | aligned? | note; then every step-5 table in full, one per reference.
3. Deviations, grouped: (b) to fix (with the fix and `file:line`), (c) to decide (what is missing, who decides), (a) justified.
4. What was not verified: `<ref>`, the date of its last commit, that no fetch was run, docs found or absent, references that were too few.

Write the four parts in this order, numbered 1 to 4.

## Delegation
Run in the main session. Do not start subagents by default.

## Pitfalls
- An analysis grouped into a few buckets is not "every change": map every file, each by its own name: no wildcards (`Pdp*Fragment`), no "and 4 others".
- "The diff" can mean the whole PR or only today's changes: confirm in step 1.
- Old references (for example an old view class) show the old convention, not necessarily the current one.
- A single precedent is not a convention: say it when you have one example.

## Done criteria
N is the 3-4 most recent references per decision; the minimum that counts is 2.
- Criterion 1, features and decisions (steps 1-3): every file of `git diff --name-only -M <base>...HEAD` (or of the confirmed local diff) appears in the report by its own file name (no wildcards such as `Pdp*Fragment`) under at least one feature or decision. Verification: compare the two lists; it passes if they are equal and fails if a file is missing or extra. Evidence: both lists.
- Criterion 2, references (step 4): every decision has at least 2 references, each with hash and commit date, and `git merge-base --is-ancestor <hash> <ref>` exits 0 for every hash. A decision with 1 reference is "single precedent" and one with none is "no precedent" with verdict (c); both leave the criterion unmet for that decision. Verification: run the command for every hash in the report. Evidence: the exit codes.
- Criterion 3, deviations (steps 5-7): every deviation has `hash` + `file:line` and a verdict (a)/(b)/(c); every (b) has a proposed fix with a file. Verification: for every (b), `git show <hash>:<file>` shows at the given line what the report says; for every backticked quote in a "reference does" cell, `git grep -n -F` finds it at its hash. Evidence: the lines read and the matches.
- Criterion 4, read-only (strict rules): `git status --short`, `git stash list` and `git rev-parse HEAD` give the same output before and after the run. Verification: run them both times and compare. Evidence: the two outputs.
- Criterion 5, report (step 8): the report has the 4 parts of step 8, the full step-5 tables, the grouped deviations, and names `<ref>` with the date of its last commit. Verification: check each part is present. Evidence: the report.
