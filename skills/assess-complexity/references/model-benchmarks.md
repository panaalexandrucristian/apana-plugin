# Performance per model and effort (data read 2026-11-06; scores rechecked 2026-11-09)

Use this file in the "Cost model in $" section, to choose the model and effort for recon and mechanical steps and not to promise quality that the sources do not show. On 2026-11-09 the scores were rechecked by `web-fetch` agents against Anthropic's own pages (launch pages and platform docs), instead of the third-party blogs that repeated them. The figures remain **the vendor's own**, so they are self-reported; independent evaluators that run the models in their own harness often get lower numbers (see "Discrepancies and limits"). Not everything could be read: both system-card PDFs were over the fetch limit, and part of the long platform docs page came back only as a summary. There is no complete model × effort table: the sources usually measure a single level per model.

## What the official documentation says about effort

Source: [Effort, Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/effort) (read in full, no date on the page). The page **does not contain** percentages, tokens or scores per level.

- Effort is "a behavioral signal, not a strict token budget": at low effort the model still thinks on hard problems, but less.
- `max` = "no constraints on spending"; `xhigh` = "long-running, agentic and coding work (over 30 minutes), with token budgets in the millions"; `high` = "complex reasoning, hard coding problems, agentic tasks"; `medium` = balance; `low` = "the most efficient, large token savings with some loss of capability", for example subagents.
- API defaults: `medium` on Opus 5.5 and Haiku 5.5; `high` on the rest. The default setting gives exactly the same behavior as omitting the parameter. A harness can set its own: Claude Code runs Sonnet 5.5 at `medium` by default ([Sonnet 5.5 launch page](https://www.anthropic.com/claude-sonnet-5-5)).
- Recommendations per model: Haiku 5.5 and Sonnet 5.5 - "use `xhigh` or `max` only where your evaluations show a gain"; Haiku 5.5 - `medium` for most work, `low` for chat and simple high-volume requests; Sonnet 5.5 - `medium` for well-specified tasks; Opus 4.7 - "at `max`, significant cost for small gains".
- At low effort the model makes fewer tool calls, goes straight to action, short confirmations. On Haiku 5.5, in long agent prompts, at `low` it skips a search or a check more often.
- Changing the top-level effort between requests invalidates the prompt cache; per-message effort changes can keep it, so check which one the harness uses.

## Per model (reported scores)

An effort in brackets is the one the source states. A cell without one has no effort stated on its page, except in the Opus 5.5 column: the Opus 5.5 page says "Unless otherwise noted, all Claude Opus 5.5 results use adaptive thinking at max effort".

| Benchmark | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 | Fable 5.1 | Opus 5 |
|---|---|---|---|---|---|
| Terminal-Bench 4.0 | 39.2% | 70.6% | 66.4% (xhigh) | 55.8% | 52.3% |
| FrontierCode 1.1 Main | 46.4% | 46.2% (max) or 52.1% (xhigh) | 54.4% (max); 54.6% (medium) | 50.3% | 48.0% |
| CursorBench 4.0 | n/a | 55.5% | 57.8% (max); 52.5% (medium) | 51.8% (max) | 46.6% (max) |
| GDPval-AA v2.1 (Elo) | 1620; 1277 (medium, secondary source only) | 1844 | 1846 (max) | 1735 | 1708 |
| Humanity's Last Exam (with tools) | 57.4% | 64.5% | 67.7% (max) | 65.6% or 65.0% | 63.6% |
| SWE-bench Pro, Anthropic's subset | n/a | 87.6% (high, default) | 92.8% (medium, default) | 92.3% (high, default, a single run) | 91.9% |

Sources, all Anthropic (primary):
- [Opus 5.5 launch page](https://www.anthropic.com/claude-opus-5-5) (22.09.2026): the Opus 5.5, Fable 5.1 and Opus 5 columns. Terminal-Bench 4.0 is "reported for Claude Opus 5.5 at xhigh effort"; CursorBench "51.8% for Fable 5.1 (max) and 46.6% for Opus 5 (max)".
- [Sonnet 5.5 launch page](https://www.anthropic.com/claude-sonnet-5-5) (28.09.2026): the Sonnet 5.5 column. "Sonnet 5.5 scores lower at Max effort than at Xhigh" on FrontierCode.
- [Haiku 5.5 launch page](https://www.anthropic.com/claude-haiku-5-5) (07.10.2026): the Haiku 5.5 column. It states no effort for Haiku's own values. Its GDPval-AA chart has Low to Max labels, but the values on it were not read.
- [Optimizing for cost and intelligence, Claude Platform Docs](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence) (no date): the SWE-bench Pro row. "Anthropic measured this on the SWE-bench Pro subset, whose scores are not comparable to the public leaderboard". Opus 5 91.9% has no row of its own: it comes from the upgrade table, "Claude Opus 5 to Claude Opus 5.5: About the same: 91.9% to 92.8% of tasks solved", at `high`, per the upgrade table's "Default: high to medium" column. There is no Haiku 5.5 row in the parts read verbatim.
- Fable 5.1 on Humanity's Last Exam: 65.6% on the Opus 5.5 page, 65.0% on the [Fable 5.1 launch page](https://www.anthropic.com/claude-fable-and-mythos-5-1) (September 2026). Neither page explains the difference.
- Haiku 5.5 GDPval-AA: "max" for 1620 and "medium" for 1277 come only from [computingforgeeks](https://computingforgeeks.com/claude-haiku-5-5-released-features-benchmarks/) (secondary, updated 08.10.2026), which cites the system card. The system card PDF could not be read.

How it was read: one agent read every cell once. A second agent re-read the SWE-bench Pro rows and the sentence on comparability, the Terminal-Bench "xhigh" note, the "max unless noted" sentence, Fable 5.1 on Humanity's Last Exam on both pages, Haiku 5.5 FrontierCode 46.4% and the absence of an effort for Haiku 5.5's 1620. The page text came back flattened, so the Haiku 5.5 column was mapped by cell order (Haiku 5.5, Haiku 4.5, GPT-6 Luna, Sonnet 5.5). The figures earlier taken from Vellum, DataCamp and computingforgeeks match these pages, except SWE-Bench Pro (see "Discrepancies and limits").

## Per effort (the only data found)

| Model | Data | Source |
|---|---|---|
| Opus 5.5 | SWE-bench Pro subset: `low` 87.4% ($0.12 per solved task); `medium` (default) 92.8% ($0.22 per solved task); `high` 95.3%; `xhigh` 96.7% (a single run) | Platform docs, cost and intelligence page (primary, read twice). Its "Tune effort" table gives $0.21 per task for `medium`: per task, not per solved task. Do not mix the two |
| Opus 5.5 | FrontierCode 54.6% at `medium` versus 54.4% at `max`; CursorBench 52.5% at `medium` versus 57.8% at `max` | Opus 5.5 launch page (primary): "At default effort (medium), Opus 5.5 scores 52.5%" |
| Opus 5.5 | Terminal-Bench 4.0: "Opus 5.5 at default effort beats Opus 5 at max effort for about a fifth of the cost"; the paragraph gives no score at the default effort | Opus 5.5 launch page, Terminal-Bench 4.0 paragraph (primary, read twice) |
| Haiku 5.5 | GDPval-AA 1620 at `max` versus 1277 at `medium`; `medium` uses "about a tenth of the output tokens" | computingforgeeks (secondary), from the system card, which could not be read. The Anthropic Haiku page gives 1620 with no effort |
| Haiku 5.5 | the author's test, 8 Python tasks, one run each, "do not read it as a benchmark": `low` 8/8, 6,444 tokens, $0.0034; `medium` 8/8, 8,360 tokens, $0.0043; `high` 8/8, 10,830 tokens, $0.0056; `max` 7/8, **132,499 tokens**, $0.0664 (on one task it used all 32,000 tokens thinking and wrote no code) | computingforgeeks (secondary). On 2026-11-09 the pass counts and 132,499 were re-read; the other token and $ figures were not |
| Sonnet 5.5 | "at `low` or `medium` it beats Sonnet 5's best score on several benchmarks for about a tenth of the cost per task", without figures | [DataCamp](https://www.datacamp.com/blog/claude-sonnet-5-5) (not rechecked on 2026-11-09) |
| Sonnet 5.5 | `max`: ~193K output tokens per Index task, ~60% more than Opus 5.5 or Sonnet 5 at `max`; $7.60 per task (effort not specified in the text); Index 56 vs 58 for Opus 5.5 `max` | [Artificial Analysis](https://artificialanalysis.ai/articles/claude-sonnet-5-5) (independent, 28.09.2026; on 2026-11-09 the ~193K and the missing effort for $7.60 were re-read, the other figures were not; the per-effort charts are images, their values could not be read) |

## Discrepancies and limits

- **Terminal-Bench 4.0:** Sonnet 5.5 70.6% (Anthropic) versus 64% at `max` (Artificial Analysis). Haiku 5.5 39.2% (Anthropic) versus 33% (Artificial Analysis, its own harness; not rechecked on 2026-11-09). Opus 5.5 66.4% at `xhigh` (Anthropic) versus about 60% (Artificial Analysis) and 61.62% or 65.15% (Vals.ai; not rechecked on 2026-11-09). Opus 5 52.3% in Anthropic's setup versus 51.8% on the public leaderboard, per Anthropic's own footnote. The differences come from different harnesses and settings.
- **SWE-Bench Pro, values removed from the table:** Haiku 5.5 64.8% is listed by computingforgeeks, attributed to the system card, not checked against it, and excluded; Anthropic's Haiku page has no SWE-bench Pro row. Sonnet 5.5 81.3% and Opus 5.5 89.9% (earlier labelled "self-reported") are on no Anthropic page read. They match the public-set figures of [BenchLM](https://benchlm.ai/benchmarks/swePro) (secondary, updated 07.11.2026, read once), which also gives Fable 5.1 81.2% and Opus 5 79.2%. Scale's official public leaderboard (labs.scale.com) lists none of the five models. Anthropic's subset and the public set are different task sets; do not compare their figures.
- **Fable 5.1:** the table uses the comparison column of the Opus 5.5 page. Its own launch page uses other versions, GDPval-AA v2 (1853; Opus 5 1824) and CursorBench 3.2.0 (73.4%; Opus 5 70.0%), not comparable with v2.1 and 4.0 (read once). Humanity's Last Exam differs too: 65.0% there versus 65.6%. No per-effort figures for Fable 5.1 were found.
- **Sonnet 5.5 GDPval-AA:** 1844 on its own page and at Artificial Analysis, 1840 on the Haiku page ("For reference" column).
- **Opus 5.5 FrontierCode:** 54.6% at `medium` versus 54.4% at `max`, on the same page. The page does not say how many runs each score has.
- **Haiku 5.5 at `low` on GDPval-AA:** a value appears only in a search snippet of a page that was not read (apidog). It is not used here.
- **Vals.ai** ([Opus 5.5 page](https://www.vals.ai/models/anthropic_claude-opus-5-5); not rechecked on 2026-11-09) is internally inconsistent: the header gives 70.18% on the Vals Index (#3 of 34), the "Updates" section 69.69% (#1 of 63); several benchmarks differ between the two. Evaluated at `max` (Terminal-Bench 2.1 at `high`). Do not use it for exact figures.
- **Fallback:** the Opus 5.5 scores on Vals.ai drop sharply when refusals fall back to another model (for example SRE Bench from 33.59% to 5.34%). A score can reflect the safety policy, not the capability.
- Sonnet 5.5 was evaluated by Artificial Analysis on a pre-release variant with a bug reported by Anthropic on structured outputs.
- One blog gave "medium ≈ 2–3× low, high ≈ 5–8×, max ≥ 10×" in tokens. **I found no confirmation in the sources read; do not use the ratio.**

## What you can deduce (and what you cannot)

What the sources support:
- On Opus 5.5, `medium` ≈ `max` on FrontierCode at much lower cost; `max` has significant cost for a small gain.
- On Opus 5.5, Anthropic's SWE-bench Pro subset rises with effort: 87.4% at `low`, 92.8% at `medium`, 95.3% at `high`, 96.7% at `xhigh` (a single run).
- On GDPval-AA, Haiku 5.5 at `medium` scored well below `max` (1277 versus 1620, from a secondary source citing the system card); nothing was read for other levels or for coding. On 8 simple Python tasks `low` reached 8/8. The task decides, not the model alone.
- On those 8 Python tasks, Haiku 5.5 at `max` used 132,499 output tokens across the 8 tasks and passed 7; the failed task used its 32,000-token limit and wrote no code.
- Sonnet 5.5 at `max` consumes the most output measured by Artificial Analysis.

What you cannot deduce:
- How many $ a given task costs at a given effort, without your own measurements. Do not turn the tables above into multiplication factors.
- That a cheaper model holds the quality on your work. Tell the user to measure on a real sample, as the documentation asks.
- How Anthropic's SWE-bench Pro subset compares with the public leaderboard: Anthropic says they are not comparable.
