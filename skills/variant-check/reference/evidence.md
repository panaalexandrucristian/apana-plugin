# Evidence for variant-check

This file holds what `SKILL.md` leaves out: the measurement behind the rule and what is not known. Labels: MEASURED = run by us, n given; DOCS = stated by the Claude Code documentation as summarised by a documentation sub-agent, not re-read by us; INFERENCE = ours.

## The task

One real task taken from a cut session of this plugin (a change to the marker matcher of `compact-handoff`, task `t2`). The oracle is 30 tests plus a check that the program's output on the real transcript is identical to the output of the reference commit. The tests do not cover the label `[tool_result ERROR]`; only the output comparison catches a solution that handles `[tool_result]` and forgets it.

Setup of every run: `claude -p`, model sonnet-5-5, effort medium, a fresh session started from a handoff, a copy of the repository, cost taken from `total_cost_usd`.

## Results (output equal to the reference / runs)

| How the rule reached the model | Equal | Cost per run (USD) |
|---|---|---|
| No rule | 1 of 2 (n = 2) | 0.33, 0.43 |
| Appended to the system prompt (`--append-system-prompt`), generic wording | 2 of 2 (n = 2) | 0.35, 0.41 |
| Same, wording that contained the example `[tool_result ERROR]` | 2 of 2 (n = 2), contaminated: the answer was in the prompt, so it is not counted | 0.38, 0.42 |
| `UserPromptSubmit` hook, `additionalContext` | 1 of 3 (n = 3) | 0.33, 0.33, 0.43 |
| This skill available (`--add-dir` with the skill) | 2 of 3 (n = 3); whether the skill was invoked is unknown: the runs keep no tool-call log, and none of the three final answers mentions variants | 0.34, 0.38, 0.33 |

For comparison, the same task at effort xhigh cost 0.68 USD (n = 1) and at high 0.61 and 0.65 USD (n = 2).

In the two hook runs whose output differed, the cause of the difference was not looked at.

## What the documentation says (DOCS)

- No settings key or environment variable appends text to the system prompt; `--append-system-prompt` is a command-line flag only. A plugin cannot set it.
- `CLAUDE.md` is delivered as a user message after the system prompt, with no guarantee of strict compliance.
- `additionalContext` is injected as a system reminder; the documentation advises factual statements over imperative ones, because imperative text can trigger prompt-injection defences. The rule is imperative. Whether that explains the hook result above was not tested (INFERENCE).
- A skill's description is in the context of every turn; its body enters once, when the skill is invoked.

## Not known

- Other tasks, other models, other efforts.
- Whether an output style shipped by a plugin (`force-for-plugin`) carries the rule as well as the flag does. Not tested.
- The sample sizes (2 and 3) are too small to rank the channels; they show that the rule can work through the system prompt and that the hook channel was not better than no rule.
