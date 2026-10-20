---
name: logic-test-debug
description: Use when writing or changing code, reading Boolean conditions, designing tests for combined conditions, or fixing bugs ("implement", "debug", "fix a bug", "scrie cod", "repară un bug", "depanează"). Do not use for non-code requests.
---
# logic-test-debug

Help read conditions clearly, test condition combinations and debug in a fixed sequence, with each rule marked by how strong its evidence is.
Rule IDs below (N, C, D, W) map to sources, pages and exceptions in [`reference/evidence.md`](reference/evidence.md).

## Activation and scope

Applies to code work: writing or changing code, reading Boolean conditions, designing tests for combined conditions, fixing bugs. Not for non-code requests.
It starts automatically through a prompt-start directive on code prompts. Claude Code users can switch it off in the Apana plugin configuration; `APANA_LOGIC_TEST_DEBUG=off` remains the backwards-compatible override. The description alone is not a guarantee.
Apply only the rules that fit the task. Never say "studies prove": no rule below is a validated result for this skill as a whole.

## Evidence labels

CLEAR = a measured effect in the source, consistent in its own data; it supports the cited finding, not that this skill works.
DESCRIPTIVE = the source observes or proposes something without testing that it improves outcomes. INFERENCE = ours, not in any source.

## Read conditions

N1 [CLEAR, both] Prefer equivalent conditions without unnecessary explicit negations when writing or changing relevant code. Not when: the code is outside the change or equivalence cannot be preserved.
N2 [CLEAR, both] Consider removing an explicit negation by exchanging equivalent branches; avoid unnecessary double negations when behaviour is preserved. Not when: it is style-only on working code or removes a needed language conversion.
N3 [CLEAR, both] Consider uniform negation structure in equivalent forms; never add negations merely to manufacture regularity. Not when: it changes behaviour or is an unrelated style rewrite.
N4 [DESCRIPTIVE, both] Distinguish variable, literal and whole-condition truth; treat TRUE-literal and logical-regularity explanations as provisional rather than rewrite instructions. Not when: no Boolean expression is read.
N5 [DESCRIPTIVE, both] Do not rank De Morgan forms or AND versus OR by a universal readability rule; consider the entire expression and context. Not when: no equivalent-form choice is involved.
The measured gains are reading time on short Python snippets (205 professionals), not bug rates; never infer a constant penalty per negation.

## Test combinations

C1 [CLEAR, both] Test interacting parameter values, not only isolated conditions; retain relevant single-value, pair and triple cases. Not when: no relevant interaction exists; do not invent factors.
C2 [DESCRIPTIVE, both] Identify relevant one-, two- and three-way combinations explicitly using actual parameter values satisfying their predicates. Not when: the order exceeds the available relevant parameters.
C3 [DESCRIPTIVE, both] Use covering arrays for selected t-way combinations when exhaustive testing is impractical; consider strengths through six rather than assuming pairwise sufficiency. Not when: exhaustive testing is already practical.
C4 [DESCRIPTIVE, both] Model parameters, values and constraints; measure combination coverage and supplement gaps, including in existing test suites. Not when: no suite or model is in scope; report what could not be measured.
C5 [DESCRIPTIVE, both] Qualify interaction-based assurance by value propagation, equivalence partitioning, timing and more complex interactions; distinguish combination coverage from structural coverage. Not when: no coverage claim is made.
Predicate examples: 1-way `pressure < 10`; 2-way `pressure < 10 && volume > 300`; 3-way adds `velocity = 5`. Ten on/off conditions: 1,024 exhaustive tests, 13 cover all triples. ACTS and CCM are optional tools.

## Debug: seven steps

D1 [DESCRIPTIVE, bug fixing] Identify the program objective: scan the program, visualise intended behaviour and keep or write down the objective throughout debugging. Not when: no debugging task; reuse an established objective.
D2 [DESCRIPTIVE, bug fixing] Familiarise yourself line by line, checking language fundamentals, directives, global/local declarations and entry-point statements before identifying errors. Not when: the code is unavailable or already understood.
D3 [DESCRIPTIVE, bug fixing] Localise errors using applicable build, compile, run, diagnostic, breakpoint and line-by-line inspection facilities. Not when: a facility is unavailable; use permitted inspection and report the limit.
D4 [DESCRIPTIVE, bug fixing] Classify errors as syntax, semantic or logical; address syntax blockers before runtime failures and incorrect results. Not when: no error is identified or evidence is too thin.
D5 [DESCRIPTIVE, bug fixing] Determine the actual cause from diagnostics and manual value tracing; consult manuals, tutorials, similar cases or help when understanding remains incomplete. Not when: the cause is already understood.
D6 [DESCRIPTIVE, bug fixing] Repair one error at a time, prioritising what blocks the objective; send syntax, semantic and logical repairs immediately to retesting. Not when: the repair is unknown or edits are not authorised.
D7 [DESCRIPTIVE, bug fixing] Retest immediately after each repair; rebuild and rerun, then repeat from localisation while the program misses its intended objective. Not when: execution is unavailable; report it as unverified, not as success.
D8 [DESCRIPTIVE, bug fixing] Use forward reasoning to understand the program's objective and current status, backward reasoning from output clues, and relevant previous debugging experience. Not when: inputs, outputs or experience are unavailable; do not force one direction.
D9 [DESCRIPTIVE, bug fixing] When debugging stalls, keep learning, reconsider the error from another perspective and seek appropriate help rather than repeating unsuccessful approaches unchanged. Not when: there is no setback or permissions block continuing.
Order D1 to D7; D6 sends each repair to D7; D7 repeats from D3 while the objective is unmet. C++-specific checks of the source are adapted to the language at hand (INFERENCE).

## Operational adaptations

W1 [INFERENCE, both] List conditions, parameters, values and constraints before combination testing; state chosen t and its reason as INFERENCE, then proceed without waiting. Not when: combination testing is irrelevant; obey a strength the user states.
W2 [INFERENCE, both] Check equivalence and language-specific evaluation behaviour before condition rewrites; never change working conditions solely for style. Not when: no rewrite is proposed; if preservation is uncertain, keep the existing form.
W3 [INFERENCE, both] Record applicable rules and actual checks; distinguish planned from executed work and pause blocked loops without claiming success. Not when: no rule applies; never fabricate a run, cause, coverage or repair.
W4 [INFERENCE, both] Rank at most three approaches that fix the cause or meet the objective, most correct first: keeps behaviour, smallest checkable change; apply the first. Not when: only one reasonable approach exists; then say so in one line.
W5 [INFERENCE, both] Workarounds avoid the symptom without fixing the cause; list them apart from the ranking, never in it, with what each leaves broken; apply none unasked. Not when: no workaround exists; write "none found".

## Guardrails

1. No style-only rewriting of working conditions; no universal ranking by negation count, regularity, AND/OR or De Morgan layout.
2. No extension of the reading findings to negated names, computed comparisons, mixed AND/OR or short-circuit code; no invented effect sizes, speed-ups or defect reductions.
3. No claim that pairs or triples give complete assurance, that six is a universal ceiling, or that combination coverage is structural coverage; the 2004 NIST paper was not read.
4. No "studies prove" for the debugging model: six lecturers, three C++ exercises, a pre-review manuscript, no outcome test. No mindset diagnosis, no mandatory tools or websites, no steps added to the seven.
5. No fixed default t, no waiting for approval of t, no fabricated runs, results or coverage. Full list: reference/evidence.md.

## Work record

On applicable tasks end the answer with this block; Approaches and Workarounds are always given (W4, W5), omit other fields that do not apply; list conditions before combination testing and complete Result after the checks:
Approaches: [up to three approaches that each fix the cause or meet the objective, most correct first, each with its main risk; the first is the one used; or "one reasonable approach: ..."].
Workarounds: [anything that passes the test or avoids the symptom but leaves the fault in place, with what each leaves broken; or "none found"].
Scope: [objective; relevant conditions/parameters and values].
Method: [chosen t and reason, marked INFERENCE; or debugging step/branch; or condition-reading rule].
Result: [checks actually performed, coverage or outcome, and any blocker].
Skip it on non-code tasks and do not repeat it after every action.
