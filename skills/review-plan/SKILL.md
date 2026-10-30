---
name: review-plan
description: "Review a plan before it is implemented: ask where the plan is when no argument is given, have two subagents run first (one finds the project's standards files, one looks up official best practices), challenge every step (why, strictly necessary, aligned with the project standard, assumptions true, in the right place, optimal), every new class or file the plan adds, and what the plan leaves out (requirement coverage, order, verification, steps that are hard to undo), fix the plan text, not the code, and repeat. Use when the user runs /apana:review-plan or asks to challenge, double-check or find the weak points of a plan before it is carried out."
argument-hint: [plan-file]
---

Go through every step of the plan, then every new class or file it adds, then what it leaves out, and challenge each one. The plan is the only thing this skill edits.

## What to review

If `$ARGUMENTS` is not empty, the plan is the file at that path. Read it whole.

If `$ARGUMENTS` is empty, review nothing yet. Ask one question in one message, "What plan should I review?", with these choices, then stop and wait for the next prompt:
- the plan of this session (the plan file that plan mode named, under `~/.claude/plans/`, or, with none, the last plan proposed in the conversation)
- a file (its path)
- something else (text pasted into the conversation)

Then list the steps as a numbered list, one line each, and the requirement the plan serves: its own Context or Goal section, the request in this session, the issue or the branch name. If the plan has no steps you can number, or you cannot name a requirement, ask instead of guessing. Use this same list in every part.

## Where fixes go

If the plan is a file, edit it in place. If it exists only in the conversation, edit nothing: print the revised plan in full at the end. Never edit code, never run a build or tests, never start carrying the plan out, never stage or commit.

## Agents before the review

Once per invocation, after the plan and the step list are fixed and before Part A, start two subagents in one message. If the `Agent` tool is missing, do both jobs yourself. Neither may edit any file; the skill cannot enforce this, so say it. Do not start them again on later passes, and start no other subagent. Each returns text in its final message, not a file.

1. **Standards agent.** Find the files in this repository that define how its code is written, tested and reviewed, and report which of them bear on the plan. Look for:
   - instruction files: `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.cursor/rules`, `.github/copilot-instructions.md`, in the root and in the directories the plan touches;
   - contribution and design documents: `CONTRIBUTING*`, `docs/` (architecture, style, ADRs, earlier plans), the README sections on conventions, the PR template;
   - configuration that enforces a standard: `.editorconfig`, linter and formatter configs, test configuration, CI workflows.
   It reads headings first and only the sections that bear on the plan; it does not read a large file whole. It returns the list of files found, one line each on what the file governs, then the rules that bear on the plan, each as path:line and a short quote. If it finds none, it says so and lists what it looked for.
2. **Practices agent.** Search the web for what the technologies the plan names recommend. Follow "Web lookup" below: primary sources only, generic terms, neutral questions ("what does the official documentation recommend for X?", not "is Z correct?"). If the plan names nothing external, say so and do not search. It returns a list of practice, version or context, URL, short quote (or "unverified").

Their output is context, not evidence: every verdict still cites a `file:line` you read yourself, and web sources are cited in the report with their URL. A rule in the project's own files that a step breaks is a finding ("not aligned"). A web practice that contradicts the project standard is an observation; it does not trigger a fix by itself. If two standards files contradict each other, ask the user which one wins. With no standards files, the neighbouring code is the standard, and the report says that none were found.

## Each pass

A pass runs Parts A, B and C on the same text of the plan, then applies every fix ("After a fix"). The next pass reviews the new text.

### Part A: every step

For each step, answer six questions with evidence, not with a bare yes or no:
- **Why** do we do this step? Name the requirement it serves. If you cannot name one, the answer is "no reason".
- **Is it strictly necessary?** Would the goal still be met if the step were removed or smaller? Extra, cosmetic or speculative steps fail.
- **Is it aligned with the project standard?** Compare with the rules the standards agent reported (read the line yourself) and with the neighbouring code of the module. Cite the `file:line` you compared against.
- **Does it hold?** Every file, function, class, API, version and command the step names: does it exist and behave as the step assumes? Read it and cite `file:line`. For a step that creates something: is the path free, and does the neighbouring code have the shape the step expects?
- **Is it in the right place?** Does the change belong in the file, class, module or layer the step names? Compare with where the project puts similar code and cite the `file:line`. If it belongs elsewhere, say where and why in two plain sentences. Do not move anything without the user's agreement.
- **Is it the most optimal solution?** Name at least one alternative you considered (an existing helper or class, a platform or library API already in the project, a shorter or simpler shape) and say why the step is better or worse than it. If the alternative is better, the answer is "not optimal".

### Part B: every new class or file

A new class is any class, object, interface, enum, sealed type, composable, script or file the plan adds. List them with the step that adds them; if there are none, say so and go on.

For each, answer with evidence:
- **Is it correct as designed?** Behaviour for its callers, edge cases (null, empty, error, cancellation), lifecycle and threading, and the tests the plan gives it.
- **Is it strictly necessary?** Search the code for an existing class that could do the job; cite what you searched and found. Could it be smaller (speculative parameters) or be merged into its only caller?
- **Is it aligned with the project standard?** Compare package, naming, injection and tests with a sibling class. Cite the `file:line`.
- **Is it in the right place?** Same rule as in Part A.
- **Is there a more optimal variant?** Name the alternative design you considered and why this one is better or worse.

### Part C: what the plan leaves out

- **Coverage.** Go the other way round: every item of the requirement, and the step that serves it, or "no step".
- **Order and dependencies.** A step that uses something a later step creates, or that cannot be checked before a later one.
- **Verification.** For each step that changes behaviour, how it will be shown to work, and the test or check the project's own standards ask for. "Run the tests" without saying which is not a check.
- **Hard to undo.** Steps that delete, overwrite, migrate, push, publish or release. Mark each one as needing the user's go-ahead in the plan.
- **Unevidenced assumptions and open questions.** What the plan takes for granted without a `file:line`, or leaves undecided. Ask the user instead of guessing.

### After a fix

If any answer is "not optimal", "no reason", "not correct", "not aligned" or "does not hold", or Part C finds a gap, fix the plan text: remove or shrink the step, reshape it to match the standard, correct the false assumption, add the missing step. Keep the plan's structure and touch only what the finding concerns. Do not add steps for improvements nobody asked for. If the fix needs a decision about the requirement or the scope, stop and ask instead of guessing. After the edit, re-read the plan and check the step numbers and the cross-references.

## Place questions

"Right place" findings do not change the plan by themselves. At the end, ask the user about them in one list: for each, what it is, where the plan puts it, where it should go and why. If the user agrees, change the plan, then run one more pass.

## Web lookup

Search the web only when you are not sure about a fact the answer depends on (API behaviour, deprecation, recommended pattern), and the repo does not settle it. Use primary sources only: official documentation, release notes and source of the library in question. Do not use blogs, forums or AI summaries as evidence. Cite the URL in the report. If no reliable source is found, say the point is unverified and do not base a fix on it. Search with generic terms only; never put project code, internal names or secrets in a query.

## Stop

Stop when a full pass changes nothing, or after 3 passes (then list what is still open).

## Report

Start with the standards files found (path and what each governs), or "none found". Then one table per part, one row per step or class, each answer in a few words with its `file:line`:

| step | why | necessary | aligned | holds | right place | optimal | action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | login fix | yes | yes, like `b.kt:40` | yes, `a.kt:12` | yes | yes | none |
| 2 | no reason | no | n/a | n/a | n/a | n/a | removed |

The class table has a `correct` column after `optimal` and no `holds` column. Part C is a short list: check, finding, action. Then the "Place questions" list and the open questions. Say what you read and what the agents returned; say what you could not check. No build or test was run, and do not claim otherwise. Do not stage or commit.
