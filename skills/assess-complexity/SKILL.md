---
name: assess-complexity
description: "Determines the complexity of a plan or code change (refactor, migration, modularization, feature) BEFORE implementation, on two separate axes - size/blast radius (files, fan-in, modules, delicate code) and Cynefin domain (how well known the cause-effect relationship is) - and recommends the process (recon, steps, gates). Use it whenever the user asks how complex/risky/big a plan, ticket or change is, asks for a complexity estimate, wants to know whether recon is needed before code, or says \"determine the complexity\" (Romanian: \"determină complexitatea\"), \"how complicated is it\" (\"cât de complicat e\"), \"complexity assessment\", even if they do not mention Cynefin or metrics. Not for algorithmic complexity (Big-O)."
---

# Complexity assessment

You receive a plan or a change and produce a classification backed by evidence. The result is **a reasoned judgment from the code, not a score**: no source consulted gives a numeric threshold for "high complexity" of a change. Do not invent formulas, percentages or points.

## Why two axes

Size and Cynefin answer different questions, and mixing them misleads:

- **Size / blast radius**: how much is touched and how far it propagates. It is measured in the code.
- **Cynefin domain**: how well known the cause-effect relationship is. A huge but mechanical change is big and *complicated*; a small one whose effect shows only at runtime (timing, concurrency, interaction with legacy code) can be *complex*.

The overall verdict combines them, but you report them separately.

## Steps

1. **Delimit the target.** Read the plan/ticket/diff. Split it into parts (core, extensions, tests, build/config). The classification is done per part, not for the whole.
2. **Measure axis 1** (see the table). Use tools: grep/rg, `git diff --stat`, `git log`, symbol search. Every number is either measured or marked `estimate, not measured`. For every measured number write the exact command and what it counted (names searched, directories, source sets, whether test files are included or not), so that someone can reproduce it; two different counts of the same thing (e.g. 22 versus ~60 test files) are explained only by the definition of the count. If you could not verify something, write `not verified`. If the user says you have no access to the code (or there is none), skip the tools and mark each criterion `from the plan` or `not measured`.
3. **Classify axis 2** for each part (see below), with the reason in cause-effect terms.
4. **Give the overall verdict** (low / medium / high) and 1-3 sentences of reasoning. If decisive evidence is missing, mark it `provisional` and say what would settle it.
5. **Recommend the process** and list what could not be verified.

## Axis 1: size and blast radius

| Criterion | What to look for, and with what |
|---|---|
| Files touched | `git diff --stat` or the list from the plan; separate production / tests / config |
| Fan-in | how many dependents each touched component has: subclasses, callers, implementations, tests that use it |
| Modules and variants | modules, flavours, build types, platforms affected |
| Delicate code | concurrency (dispatchers, timers, synchronization), reflection, DI, serialization, minification rules (R8/ProGuard), persistence, public contracts |
| Known | what is mechanical or already has precedent in the repo |
| Unknown | what has no design fixed by the code or by the plan |

Metrics from the literature, as vocabulary, not as thresholds for a change. How to use them: only if data exists; do not compute them "by eye".
- Cyclomatic complexity (indicatively <10 per function, from a blog without sources) and cognitive complexity.
- Afferent coupling Ca (how many depend on a component) and efferent coupling Ce (how many it depends on); instability = Ce/(Ce+Ca).
- Hotspot = complexity × change frequency (`git log` per file).
- CRAP, threshold 30, described as chosen empirically.

## Axis 2: Cynefin domain, per part

The criterion is the cause-effect relationship, not size:

| Domain | Cause-effect relationship | Approach |
|---|---|---|
| Simple | obvious to everyone | apply the known practice |
| Complicated | not obvious, but analyzable beforehand | sense - analyse - respond, ask for an expert/analysis |
| Complex | determinable only in retrospect | probe - sense - respond: small experiments, safe to fail |
| Chaotic | no visible relationship | stabilize first, only then analyze |

Rules:
- Cynefin is a decision framework, not a method and not a 2x2 matrix; it has no thresholds. The transitions matter.
- Missing knowledge or an unfinished design alone does not make a part *complex*. If reading the code or an expert can settle the cause-effect, the part is *complicated*; if the evidence is not there yet, write `not determined until recon`. A part is *complex* only when the outcome shows up only by trying (runtime behaviour, concurrency, interaction with legacy code).
- Read-only recon is analysis, not a probe; a **probe** (spike, prototype on a branch, runtime check) tests an intervention. After the recon or the probes, reclassify and say what moved.
- The trap from the literature (ICSSP'15): teams implicitly treat everything as *complicated*, make a plan, then are surprised. Ask yourself explicitly: "do I know this relationship or am I assuming it?"
- The classifications are judgments. Say why, in cause-effect terms.

## What you recommend

- Parts with open questions: read-only recon before code when analysis can settle them; a bounded probe (spike, runtime check) when only trying shows the outcome. If they exist, use subagents (`zoom-recon-deep` for changes that cut across modules, `zoom-recon-fast` for an isolated fact). Recommend it, do not start it unasked if the user only asked for the assessment.
- Small steps, each independently verifiable, with a decision gate before the parts that are still *complex*.
- For the points that stay *complex* even after analysis (e.g. nullability versus legacy code, the identity of some snapshots, a minified build), ask for **runtime verification**, not only review.
- Irreversible or external parts (push, deletion of code with consumers, migrations): a gate with the user's approval.

## Cost model in $

Report what the model costs, in dollars, for what you recommend. The cost does not change the complexity verdict; it is a third piece of information next to size and Cynefin. The assumptions come from **actually measured** consumption, not invented: `references/real-usage.md` (turns, context, output and cache share per agent type, from the skill author's historical sample of one Android project, not from the current user, plus the real cost of some tickets).

1. **When it appears.** In the full format. In the short format (an obviously simple change) it does not appear, unless you are asked for it.
2. **Model and price.** The session's model from the current context (if you do not know it, ask). The prices are in `references/pricing.md` (dated; do not write them from memory). On a subscription, the $ is the equivalent at API rate, not a bill.
3. **Recon and checks: take the interval from real data.** Pick from `real-usage.md` the agent type closest to the work (read-only research ≈ general-purpose or Explore; review ≈ android-reviewer) and report its p10–p90, with the n and with the note "the author's historical sample (one project)"; write "measured in your transcripts" only after running `scripts/usage_stats.py` on the user's own. If you change the model, do not reprice the p10–p90 from the token percentiles of the table: they come from different runs and do not combine into a cost percentile. Either rerun the script on transcripts of that model, or give one illustrative p50 calculation as in `pricing.md`, labelled as such. The cache share of the sample (~0.9) is an assumption for the new work, not "no cache". If the recon needs several agents, do not write an order of magnitude in $ ("a few dollars", "tens of $") without a shown calculation (agents × p10–p90 from `real-usage.md`, a budgeting scenario, not a measured interval); without a calculation, give only the interval for one agent and say that the number of agents cannot be fixed before the recon.
4. **Implementation: give an order of magnitude from real tickets, not from the size of the diff.** In the 3 tickets of `real-usage.md` the smallest change was the most expensive; n=3 does not show whether the file count predicts the cost, so do not size the cost from the diff. Give an interval from comparable tickets, say that their recorded cost is a lower bound for those tickets, not for the new one, and that ambiguity and coordination may matter; if you have no comparable change, write "cannot be estimated before recon".
5. **The current assessment.** Do not give a $ figure for it unless you have the input/output breakdown (the same 40K tokens come out at $0.08 or $0.40 depending on the split).
6. **A single data point is not extrapolated.** One ticket is not a statistic; state the n. You can redo the measurement with `scripts/usage_stats.py`.
7. **Model and effort.** In the full format you always list the recommended model and effort, per phase (the "Model and effort recommended" section of the format). Read `references/model-benchmarks.md` beforehand, in this run, because the recommendation must rest on what the sources show, not on impression. For each phase write the basis: `documentation` (the official effort recommendations), `benchmark` (the figure and the name of the source in the same table row, with its discrepancies; a figure without a named source does not go in the answer) or `judgment` (when the sources say nothing; say so). Selection principle: the phase with open design or delicate code gets the most capable model and stronger verification, with the effort starting at the documented recommendation for that model and task and raised only when an evaluation shows a gain; read-only recon and mechanical steps verified by the compiler can go on lower effort. For Haiku 5.5 the only comparison read is GDPval-AA, where `medium` scored well below `max`; it says nothing about other levels or about coding. Do not turn any token ratio into a figure. Say that the user must measure on a real sample and that changing the top-level effort invalidates the prompt cache (per-message effort changes can keep it; check the harness). The final choice stays with the user.

   **Ranking with cost.** For the implementation phases, also read `references/model-implementation-example.md` (the same ticket, 5 model + effort combinations, with measured cost in $ and a ranking). Give each phase a rank for the recommended combination, with the cost in $ (the example's cost is measured per combination, with no token breakdown, so quote it; do not recalculate it or split it by phase) and with what you lose compared with the more expensive variant; do not order only by quality or only by price. Say that the example is a single ticket, n=1, not compiled.

## Honesty about evidence

- Separate what you **read/measured** from what comes from summaries, memory or handoffs. Do not attribute to a source what it does not contain.
- If the numbers come from other agents or from a document, say so.
- Do not extend beyond what you verified: when needed, `estimate, not measured`.

## Output format

**An obviously simple change** (one file, no logic, no delicate code, no relevant dependents): do not use the table and do not open empty sections. Answer in at most 4 sentences, without a cost row: verdict (low), the domain (simple) with the reason in cause-effect terms, what remains to be verified (e.g. light/dark, `not verified` for what you did not read) and that no recon or gates are needed. Why: a six-row table for a one-line change costs attention and hides the verdict.

For anything else, short, in the user's language, no filler:

```
**Complexity: <low|medium|high>** - <reason in 1-3 sentences>

**Where it comes from and how it was measured**
<2-4 sentences: the 1-3 main sources of the complexity (size, delicate code or open design) and the method: which commands/tools were run, or "from the plan, not measured" if it was not possible>

| Criterion | Finding | Source (measured / estimate) |
|---|---|---|
| Files touched | ... | ... |
| Fan-in | ... | ... |
| Modules and variants | ... | ... |
| Delicate code | ... | ... |
| Known | ... | ... |
| Unknown | ... | ... |

**Size and Cynefin per part**
- <part>: size <small/medium/large> · <domain> - <why, cause-effect>

**Recommended process**
- recon / steps / gates / runtime checks

**Cost model ($)**
- <model> · recon / check: <p10–p90 $ from the author's sample with n, for the same model; otherwise an illustrative p50 calculation or "cannot be estimated before recon"> · implementation: <order of magnitude from comparable tickets, a lower bound for those tickets> or "cannot be estimated before recon"

**Model and effort recommended**

| Phase | Rank | Model | Effort | Estimated cost $ | Basis (documentation / benchmark / measured example / judgment) |
|---|---|---|---|---|---|
| <recon / implementation / check> | <1 = recommended, 2 = alternative> | <model> | <low|medium|high|xhigh|max> | <interval from the author's sample with n, an illustrative calculation labelled as such, or "cannot be estimated before recon"> | <the basis, with the source> |

**Unverified**
- ...
```

The short format stays without the cost and the model/effort sections, so that it does not bloat.

## Real examples (anonymized, from the work measured in `references/real-usage.md`)

Use them to calibrate size against cost and Cynefin, not as a template. Where Sonnet 5.5 ran, the $ figures are too high (priced with $0.20/M cache reads instead of $0.10; see `references/real-usage.md`).

- **Moving some configuration classes and wire DTOs into a new module:** 54 files, ~+1600/−900 lines. Mechanical, the compiler shows the consumers: *complicated*. Medium complexity by size. Real cost: 86 turns, ~$4.
- **Boundary ports and adapters between two modules:** 13 files, +360 lines, only new code. *Complicated*. Low-to-medium complexity. Real cost: 66 turns, ~$3.6.
- **Moving a serialization helper into a shared module and injecting it into data sources:** 29 files, ~80 lines changed. Mechanical (*complicated*), small by size, but the most expensive of the series: 152 turns, ~$14.5. In these 3 tickets the size of the diff did not follow the cost (n=3); the working hypothesis is ambiguity and coordination.
- **Core with concurrency on a single-thread dispatcher, timer and grace period, base class inherited by 3 subclasses:** the core *complicated*; the timer and grace-period behaviour of the extension *complex* (it shows only at runtime); the extension's design not determined until recon; overall high. Only the planning and the recon cost ~$3 (session) plus ~$6.3 (4 subagents).

## Sources and how much of them was read

Model prices: `references/pricing.md`. Real consumption and costs: `references/real-usage.md` (redo with `scripts/usage_stats.py`). Performance per model and effort: `references/model-benchmarks.md`. Measured implementation example on 5 combinations, with cost: `references/model-implementation-example.md`. Details and limits of the sources in `references/sources.md`. In short: Cynefin.io, ICSSP'15, TechTarget and TeaRAGs were read in full; Fixify from a PDF; Deakin (404) was not read.
