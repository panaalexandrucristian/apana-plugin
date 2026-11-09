# Real measured consumption (the skill author's transcripts of one Android project, 2026-11-06)

Source: `scripts/usage_stats.py` run on the transcripts of one Android project of the skill author (254 main sessions, 238 subagents), not on the reader's. It reads only the numeric `usage` fields; measure your own project with `python3 -I scripts/usage_stats.py <directory>`. The figures are at **API rate** (not a subscription bill), only for the models with a known price (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`); the models without a price (e.g. the non-Anthropic ones) are excluded from the $ columns. The tokens are deduplicated by message id within each file only; ids repeated across files were not checked in this sample.

**The $ figures are from the script of 2026-11-06**, which priced each file at its most frequent model, without the Haiku 5.5 rate for prompts over 100K, and with $0.20/M for Sonnet 5.5 cache reads. The price is $0.10/M (pricing page, 2026-11-09), so every $ figure that includes Sonnet 5.5 is too high. A file with requests on a more expensive model, or with Haiku requests over 100K, can also be too low. The transcripts were not available to recompute them (2026-11-09).

## Subagents by type (assumptions for recon and checks)

| Type | n | Turns p10 / p50 / p90 | Average context per turn (K tokens) p50 / p90 | Total output p50 / p90 | $ p10 / p50 / p90 |
|---|---|---|---|---|---|
| general-purpose (research, mixed tasks) | 101 | 3 / 11 / 31 | 55 / 134 | 5.3K / 33K | 0.09 / 0.33 / 1.47 |
| Explore (read-only search) | 21 | 7 / 17 / 35 | 53 / 72 | 11.5K / 21K | 0.27 / 0.48 / 1.27 (n with price = 9) |
| android-review-collector | 39 | 9 / 16 / 70 | 70 / 134 | 15K / 58K | 0.29 / 0.40 / 5.15 |
| android-reviewer (model not uniform, see below) | 50 | 14 / 47 / 69 | 129 / 181 | 60K / 81K | 2.02 / 3.83 / 5.42 |
| web-fetch | 16 | 2 / 3 / 4 | 22 / 150 | 6K / 29K | 0.00 / 0.01 / 0.04 |
| zoom-recon-deep | 2 | too few for percentiles | | | not used |

By model: Sonnet 5.5 subagents (n=112): 3 / 11 / 51 turns, $0.13 / 0.37 / 2.83. Opus 5.5 subagents (n=40): 30 / 55 / 72 turns, $2.02 / 4.17 / 5.77. Both cohorts were formed by the old rule (each file at its most frequent model); the script now puts a file with several models in `mixed`, outside both.

The android-reviewer row was earlier labelled "Opus 5.5". With the counts in this file it cannot be all Opus 5.5: that run gave each file exactly one model (its most frequent one), and in the same run there are only 40 Opus 5.5 subagents in the whole project. If both counts are right, at most 40 of the 50 android-reviewer files ran on Opus 5.5, so its $ column mixes models. Which count is off, and which model the rest ran on, was not checked: the transcripts were not available for a recount (2026-11-09). Before using the row for an Opus 5.5 estimate, rerun the script and check the models of the android-reviewer files; the script as it is groups by type and by model separately, never both together.

**Cache:** the share of cache reads in the input has p50 ≈ 0.9 (p10 ≈ 0.55–0.64, p90 ≈ 0.98). The "no cache" scenarios of the earlier estimates were unrealistic upper bounds.

## Main sessions (all)

Turns 1 / 26 / 120 (p10 / p50 / p90); average context per turn 44K / 95K / 186K; $ 0.22 / 1.32 / 9.39, maximum 57.04.

## Real cost per modularization ticket (the main session that received the ticket + its subagents)

The size of the change from `git show --shortstat` on the corresponding commit. The cost is a **lower bound for these historical tickets**, not for a new task: sessions continued through a handoff are not included, and 2 of 7 tickets could not be linked to a session after the first prompt.

| Change (described generically) | Files / lines | Main session | Subagents |
|---|---|---|---|
| Moving some configuration classes and wire DTOs into a new module | 54 / +1607 −919 | 86 turns, $4.05 | 0 |
| Boundary ports and adapters between two modules | 13 / +360 | 66 turns, $3.63 | 0 |
| Moving a serialization helper into a shared module and injecting it into data sources | 29 / +34 −43 | 152 turns, $14.52 | 0 |
| Moving the data source contracts into a domain module | 118 / +7027 −316 | not linked to a session | n/a |
| Moving the wire layer into a network module, plus twin classes | 136 / +1700 −85 | not linked to a session | n/a |
| Plan for a core with concurrency, timers and a base with 3 subclasses (only planning and recon) | n/a | 37 turns, $3.05 | 4 subagents, $6.33 |

## What can be claimed and what cannot

- In these 3 tickets the smallest change (29 files, ~80 lines) cost the most ($14.52, 152 turns); n=3 does not show whether the file count predicts the cost. From what is visible in the transcript, the session had instructions for coordinating with other sessions; **I did not verify the cause** (I did not read the content of the session). The working hypothesis is that ambiguity and coordination matter.
- One single ticket per type of change: they are not statistics, they are examples.
- The percentiles per agent type are computed over the whole project and mix different tasks; use them as an order of magnitude for recon and checks, not as a promise.
