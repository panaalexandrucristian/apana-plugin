# Measured example: the same ticket, 5 model + effort combinations (2026-11-06)

Use the file when you recommend a model and effort for **implementation** and want a real reference, not only documentation. The result is a single run per configuration (n=1) and was not compiled: it shows a direction, not a law.

## What was done

- **Ticket:** moving some socket contracts from a monolith module into separate modules, in an Android repo. The diff approved by review: 29 files, +448/−109, three commits. Mechanical, but with delicate code (a shared hook in serialization, R8 minification, DI between modules).
- **The specification** was identical for all: the text of the ticket section from the modularization proposal, plus the repo's rules.
- **Setup:** a separate worktree each, at the same base commit, one agent per combination: Opus 5.5 `xhigh`, Opus 5.5 `medium`, Sonnet 5.5 `xhigh`, Sonnet 5.5 `medium`, Haiku 5.5 `xhigh`.
- **Rules:** no Gradle (multiple builds do not run at once), no commit, no access to the git history and to the approved solution. I checked in the transcripts: no agent broke the rules.
- **Evaluation:** I compared each diff with the approved one, on 20 concrete decisions extracted from the approved diff (for example: which ports the hub uses, whether it keeps the old configuration source, whether it removes the old qualifier, whether it keeps the type of a legacy constructor, whether it puts the technical-debt markers the repo requires, whether it respects the order within the class). The matches were counted with grep on the patches and with targeted reading, not on all the lines.

## Results

Cost in $ = equivalent API rate, from the tokens measured in each agent's transcript (uncached input, cache read, cache write, output), the prices from `pricing.md` as of 2026-11-06. Cache write = 1.25× input and Haiku cache read = 10% of input were assumptions then; the pricing page confirms both (2026-11-09). For Haiku, 84 of 97 requests had over 100K prompt tokens, so the higher rate applies to them. The Sonnet 5.5 costs used $0.20/M for cache reads instead of $0.10, so they are too high; the token breakdown per combination is not kept in this file, so they are quoted, not recomputed.

| Combination | Decisions as in the approved one (of 20) | Cost $ | Time | New tests | Matching decisions per $ |
|---|---|---|---|---|---|
| Opus 5.5 `xhigh` | 16 | 8.7 | 27 min | 2 | 1.8 |
| Opus 5.5 `medium` | 13 | 5.2 | 18 min | 1 | 2.5 |
| Sonnet 5.5 `medium` | 13 | 1.6 | 4.6 min | 1 | 8.1 |
| Haiku 5.5 `xhigh` | 10 | ~1.6 | 18 min | 0 | ~6.3, but see below |
| Sonnet 5.5 `xhigh` | 9 | 8.0 | 23 min | 2 | 1.1 |

## Ranking

**With the cost taken into account (matching decisions per $, with a quality threshold):**
1. **Sonnet `medium`**: the best ratio. 13 of 20 at $1.6 and 4.6 minutes. Weakness: it missed two of the repo's convention rules (the order within the class, the technical-debt markers), which fail at the architecture gate. It costs a round of corrections.
2. **Opus `xhigh`**: the best quality (16 of 20, the only one that came close to all the design decisions), but at 5.4× the cost of Sonnet `medium`. Reasonable when the mistake costs more than the difference (delicate code, no access to the build).
3. **Opus `medium`**: the same number of decisions as Sonnet `medium` at 3.3× the cost. It respected the repo's conventions, but missed other design decisions. Dominated on cost, not on the quality of the conventions.
4. **Haiku `xhigh`**: not recommended. The ratio looks good only because the rate is low; it left a test unmoved, added no new tests, did not put the technical-debt markers the repo requires, narrowed the type of a legacy constructor. It consumed 21M cache read and 153K output tokens; no lower-effort Haiku run was made, so the effect of effort on Haiku is not measured.
5. **Sonnet `xhigh`**: dominated. Less faithful than Sonnet `medium` (9 versus 13), at 5× the cost, and it made a risky decision (it moved the hub's base URL to another port, bypassing the configuration from androidTest).

**If only quality matters:** Opus `xhigh`, then Opus `medium` and Sonnet `medium` tied, then Haiku `xhigh`, then Sonnet `xhigh`.

## What you can say from this, and what you cannot

It supports (weakly, n=1):
- On mechanical work with a clear specification, a higher effort did not bring fidelity on Sonnet; the documentation says the same thing (`medium` for well-specified tasks).
- The more capable model (Opus) came closer to the design decisions, not only to the mechanical ones.

It does not support:
- That Sonnet `medium` is "just as good" as Opus: the difference in conventions and in design decisions is real, and the correction cost was not measured.
- A general multiplier on effort or on model. One ticket, one run per configuration.
- Correctness at runtime: no diff was compiled. "Matching decisions" means similarity to an approved diff, not correctness.

## How you use it in the skill

- For mechanical implementation phases with strict conventions: propose Sonnet `medium`, with a pass that checks the repo's conventions (the order within the class, technical-debt markers) before review.
- For a phase with delicate code or open design: Opus, with `medium` as the starting point and `xhigh` only if a more expensive review costs more than the difference (here: ~$3.6 between `medium` and `xhigh`, for 3 more decisions).
- Do not propose `xhigh` on Sonnet or on Haiku for implementation without your own evaluation: in this example it did not help on Sonnet, and Haiku ran only at `xhigh`.
- Always say that the figures come from a single ticket and that the user must measure on their own work.

## The same ticket, with a split into subagents (second test, 2026-11-06)

The same 5 combinations, the same specification and the same base commit, in new worktrees. The difference: the main agent (orchestrator) split its work by itself into 3–6 subagents on disjoint sets of files, on the same model as itself, fixed the shared contracts beforehand and then checked the results. The cost includes the orchestrator and all its subagents (tokens measured in the transcripts, the same prices and assumptions as above). No tool call broke the rules (no Gradle, no access to the solution).

| Combination | Decisions as in the approved one (alone → split) | Cost $ (alone → split) | Time min (alone → split) | Subagents |
|---|---|---|---|---|
| Opus 5.5 `xhigh` | 16 → 11 | 8.7 → 14.5 | 27 → 38 | 3 |
| Opus 5.5 `medium` | 13 → 13 | 5.2 → 8.5 | 18 → 20 | 3 |
| Sonnet 5.5 `xhigh` | 9 → 10 | 8.0 → 8.0 | 23 → 24 | 3 |
| Sonnet 5.5 `medium` | 13 → 12 | 1.6 → 2.1 | 4.6 → 4.5 | 4 |
| Haiku 5.5 `xhigh` | 10 → 12 | ~1.6 → 2.3 | 18 → 23 | 6 |

Haiku from the first test is recomputed with the rate for prompts over 100K, as in the second. Sonnet `xhigh` from the second test was marked interim by the harness, but the worktree did not change for 17 minutes after the final report.

What it shows (n=1 per configuration, not compiled; run-to-run variation not measured):
- The match counts fell for 2 combinations, stayed for 1 and rose for 2 (Sonnet `xhigh` 9 to 10, Haiku 10 to 12). The split cost more for four of five: +66% for Opus `xhigh`, +65% for Opus `medium`, +37% for Sonnet `medium`, +45% for Haiku. Sonnet `xhigh` was equally expensive.
- The biggest drop, Opus `xhigh` (16 → 11), came from design choices made by the orchestrator before delegating: it moved the hub's URL to another port, kept an old alias for the qualifier and did not make the shared base class. According to the orchestrators' reports, the subagents implemented the contracts they were given, so the design stayed in the orchestrator (not verified on the subagents' transcripts).
- Two orchestrators (Sonnet `xhigh`, Haiku) reported that the subagents ran asynchronously, although foreground had been requested; they waited for the notifications.
- Sonnet `medium` remains the cheapest variant with 12–13 decisions of 20, alone or split. For a ticket of ~30 mechanical files the split brings no measurable gain; it might matter for much larger tickets or when the subtasks are truly independent. I did not measure that.
