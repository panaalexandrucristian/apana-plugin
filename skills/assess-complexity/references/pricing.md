# Model prices (USD / 1M tokens, first-party API)

Source: the [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing), checked **2026-11-09** for Fable 5.1, Opus 5.5, Sonnet 5.5, Sonnet 5 and Haiku 5.5. The other rows come from the "Current Models" table of the `claude-api` skill (cache 2026-10-06) and were not rechecked. Before a figure on which a decision is taken, check the pricing page again.

| Model | Input | Output |
|---|---|---|
| Claude Fable 5.1 / Fable 5 | $10.00 | $50.00 |
| Claude Opus 5.5 | $4.00 | $20.00 |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 | $5.00 | $25.00 |
| Claude Sonnet 5.5 / Sonnet 5 | $2.00 | $10.00 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Haiku 5.5 | $0.10 | $0.50 (over 100K prompt tokens: $0.50 / $2.50) |
| Claude Haiku 4.5 | $1.00 | $5.00 |

Cache read: $0.20 for Opus 5.5, $0.10 for Sonnet 5.5, $0.20 for Sonnet 5, $0.25 for Fable 5.1, $0.01 for Haiku 5.5 ($0.05 over 100K prompt tokens). Cache writes: 1.25× input for 5 minutes, 2× input for 1 hour, for the five models checked. Fast mode Opus 5.5: $8 / $40 (2×).

Haiku 5.5 over 100K: a request whose prompt (uncached input + cache reads + cache writes) is over 100,000 tokens pays every rate ×5, and each request is priced on its own. The other four models checked have no long-context tier.

Advisor tool: the advisor's iterations are billed at the advisor model's rates and are not in the top-level `usage` of the response; `scripts/usage_stats.py` prices them from `usage.iterations` ([advisor tool page](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool), read 2026-11-09).

## Formula

`$ = Σ over requests (uncached input × input price + cache read × read price + 5m cache write × 5m write price + 1h cache write × 1h write price + output × output price) / 1,000,000`, with the model and the Haiku tier chosen per request.

The input of each request includes all the context resent on that turn, so a task with many turns costs more than the sum of the messages.

## Example calculation (to show the calculation in the answer)

Illustrative, built from marginal medians, not a run: values from `real-usage.md` for a general-purpose agent on Sonnet 5.5 ($2 / $10, cache read $0.10; p50: 11 turns, ~55K average context, ~5.3K output, cache-read share ~0.88):
- Total input ≈ 11 × 55,000 = 605,000 tokens: the 12% that is not a cache read ≈ 72,600 × $2/M = $0.145 (priced as uncached input, so any cache writes in it are under-priced); cache read 88% ≈ 532,400 × $0.10/M = $0.053
- Output 5,300 × $10/M = $0.053
- Total ≈ $0.25. The medians come from different runs, so this is not the cost of any run and is not compared with the cost p50 of the same file.
Always show the turns, the context, the output and the cache rate. A cost interval comes from the cost percentiles that `scripts/usage_stats.py` prints, not from repricing token percentiles.

## Measured calibration (the only data point)

Three runs of this skill, each a single answer with no code read, consumed 38,789, 40,563 and 40,634 total tokens (input + output not broken down, from the subagents' notifications). Without the skill: 31,295–36,528. Do not extrapolate from here to implementations: they are short evaluations, not work on code. Without the input/output breakdown do not put a $ figure on these runs: the same total comes out at $0.08 (all input) or $0.40 (all output).

## Subscription

On a Claude Code subscription there is no per-token billing. The $ figure is then the equivalent at API rate, not a bill.
