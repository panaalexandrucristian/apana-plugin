# Evidence for logic-test-debug

This file holds what `SKILL.md` leaves out: sources, pages, labels, exceptions and the full original wording that the rules compress. `SKILL.md` stays short; every rule ID (N, C, D, W) there is explained here. The sources were read as text extractions of the files named below; nothing was measured in a live session for this skill (see "Observable behaviours" and PRIVATE.md for the test status).

## Source inventory and status

| Key | Source | What was read | Status |
|---|---|---|---|
| B | Baron, Granot, Yosef, Feitelson. "Understanding Logical Expressions with Negations: Its Complicated". EASE 2024, DOI 10.1145/3661167.3661180 | The full paper (licence CC BY 4.0), 10 pages. | Experiment with 205 professional developers who gave the output of short Python snippets; the measures are response time and wrong answers. Reading time of Boolean expressions, not bug rates. |
| K | Rick Kuhn (NIST), "Combinatorial Coverage Measurement", 32 slides (file `1-4b-ivv2012kuhn.pdf`; the file name suggests a NASA IV&V workshop in 2012, the slide text does not say so) | All slides. | Slide deck by the NIST researcher whose group produced the underlying studies. Page numbers "K pN" are slide numbers. |
| N | NIST ITL Bulletin, May 2016, "Combinatorial Testing for Cybersecurity and Reliability" (Kuhn, Kacker, Feldman, Witte) | All 5 pages. | Written by NIST authors (Kuhn, Kacker) with two guest researchers from G2, Inc.: a summary of NIST work plus case reports, not an independent replication. Page numbers "N pN" are page numbers of the bulletin. |
| R | NIST record of Kuhn et al., "Software fault interactions and implications for software testing", IEEE Transactions on Software Engineering, 2004, DOI 10.1109/TSE.2004.24 | The NIST record page (abstract) only. | The 2004 paper itself was NOT read (only this record page with its abstract was available). Do not claim to have read it. |
| M | Maleti and Nel. "Overcoming Debugging Challenges: Expert Strategies for Novice Programmers". SACLA 2025, Springer CCIS vol. 2770 (2026), DOI 10.1007/978-3-032-12457-9_9; pages 137-152 and online date 2 January 2026 per the Springer record page, not stated in the manuscript | The pre-review manuscript, 18 pages. | Pre-review, not the final text. A small-sample experiment with qualitative data (interviews, think-aloud), described by the authors as mixed-methods (FraIM); no outcome test of the model. Page numbers "M pN" are manuscript pages; "M p11 Fig. 2" is the flowchart image, which text extraction could not show. |

Missing or unavailable: the full 2004 Kuhn paper; any independent replication of the NIST interaction pattern; the final published text of M; the image of M Fig. 2.

## Evidence labels and rule index

Labels: **CLEAR** = a measured effect in the source, consistent in its own data. CLEAR supports the cited finding, not the effectiveness of this skill. **DESCRIPTIVE** = the source observes or proposes something without testing that it improves outcomes. **INFERENCE** = ours, not a result of any source. Operational exceptions, behavioural safeguards and cross-language transfer are INFERENCE, separate from the original findings.

| ID | Label | Applies | Source | Not when |
|---|---|---|---|---|
| N1 | CLEAR | both | B p5 §4.2.1; p8 §5.2 | The code is outside the requested change, or equivalence and evaluation behaviour cannot be preserved. |
| N2 | CLEAR (tested reading times) | both | B p8 §§5.1-5.2; p9 §5.2 | The change is style-only on working code, changes behaviour, or removes a necessary language-specific conversion. |
| N3 | CLEAR (measured syntactic regularity) | both | B pp6-7 §4.3.1; pp7-9 §§4.3.2 and 6 | Regularity needs a behaviour change, gratuitous negations or unrelated style rewrites. |
| N4 | DESCRIPTIVE | both | B p2 literal definition; pp6-8 §§4.2.2-4.3.2; p9 §6 | No Boolean expression is being interpreted or compared. |
| N5 | DESCRIPTIVE | both | B pp5-9 §§4.2.2-6 | No equivalent-form choice or operator comparison is involved. |
| C1 | CLEAR (reported low-order pattern) | both | K pp2-4, 11; N p1; R abstract | No relevant interaction exists; never invent factors to satisfy the rule. |
| C2 | DESCRIPTIVE | both | K pp2-4 | The interaction order exceeds the available relevant parameters. |
| C3 | DESCRIPTIVE | both | K pp11, 13-16; N p1 | Exhaustive testing is already practical, or the parameter model does not represent the failure mechanism. |
| C4 | DESCRIPTIVE | both | K pp18-22, 32; N pp3-4 | No test suite or model is in scope; report unavailable execution or measurement instead of assuming coverage. |
| C5 | DESCRIPTIVE | both | K pp11, 16-17, 32; R abstract | No interaction-coverage or assurance claim is made. |
| D1-D7 | DESCRIPTIVE | bug fixing | M pp7-10 §4.1 Steps 1-7; p12 Fig. 3 | See each step below. |
| D8 | DESCRIPTIVE | bug fixing | M pp11-13 §4.2 | Inputs, outputs or relevant experience are unavailable. |
| D9 | DESCRIPTIVE | bug fixing | M pp13-16 §§4.3-5 | There is no setback, or continuation is blocked by permissions, evidence or task limits. |
| W1-W3 | INFERENCE | both | Operationalisation of K, N, B, M | See "Operational adaptations". |

## Baron: condition reading

What B measured: 205 professional developers; short Python snippets with Boolean conditions of three literals joined by one operator type; response time and wrong answers; no short-circuiting because every literal had to be read. A literal is a variable or its negation. The authors list as open (future work, p10 §7): combinations of AND and OR, computed conditions such as `x <= 3` versus `not(x > 3)`, short-circuiting, negations that appear in names (for example `not_done`), and the effect of programming experience.

Authors' stated practical implications (p10 §7, "possible"): multiple negations are detrimental, so avoid them if possible; cancel a double negation; if an `if` can be flipped by removing a negation and switching "then" and "else", do so; regularity also helps, so emphasise it in expressions with repeated elements.

Numbers (t-tests on response time, as reported):
- Number of negations (pooled over AND/OR and truth values): 0 versus 1 negation p = 3.173e-13; 1 versus 2 p = 0.0001126; 2 versus 3 p = 0.07602 (not significant) (p5 §4.2.1).
- AND versus OR: AND slightly faster, p = 0.001048, but the actual difference is slim (p5-6 §4.2.2).
- Whole-condition TRUE versus FALSE: practically the same, p = 0.7401 (p6 §4.2.2).
- Syntactic regularity (all literals negated or none) read faster: p = 6.205e-07 (p7 §4.3.1).
- "Implicit negation" (`p ∧ q` that evaluates to FALSE) was faster than the equivalent `¬(p ∧ q)`: p = 7.803e-07 (p8 §5.2).
- De Morgan pairs: `¬(p ∧ q)` versus `¬p ∨ ¬q` p = 0.5916; `¬(p ∨ q)` versus `¬p ∧ ¬q` p = 0.0715; neither significant (p8 §5.2); the abstract and §5.2 report a slightly higher difficulty for `¬(p ∨ q)` that did not reach significance.
- Both double-negation forms were the hardest and the only snippets with a non-negligible number of mistakes; `¬¬p ∨ ¬¬q` (4 negations) was faster than the equivalent `¬(¬p ∧ ¬q)` (3 negations), p = 0.002088 (p9 §5.2).

Rule details:
- N1: measured increases occurred from zero to one and from one to two negations, not significantly from two to three. Never infer a constant penalty per operator.
- N2: the tested implicit-negation form was faster, but that comparison also differs in truth value (the implicit-negation snippet evaluates to FALSE, `¬(p ∧ q)` to TRUE; Fig. 10 caption, p8), so the negation effect is confounded with it. Both tested double-negation forms were hardest, but the regular four-negation form was faster than its three-negation equivalent. Branch exchange and cancellation are conditional applications, not universally superior layouts; language-specific preservation is INFERENCE.
- N3: syntactic regularity means all literals negated or none. The observed aggregate advantage is separate from the authors' speculative explanation and from the interacting-factor interpretation, which are DESCRIPTIVE.
- N4: logical regularity means all literals TRUE or all FALSE. The proposed TRUE-literal advantage and the logical-regularity explanation interact; they were not independently established causal effects. Whole-condition TRUE or FALSE alone showed no important difference. Never alter truth values to ease reading.
- N5: neither tested De Morgan pair differed significantly. The small aggregate AND advantage depended on interacting factors. Negation count alone does not determine difficulty (p8-9: "more negations is not always worse - it also depends on what exactly is negated").

## Kuhn: interaction testing

What the sources report:
- K p2: failures were studied in a variety of fields including 15 years of FDA medical-device recall data. A 2-way example failure: "altitude adjustment set on 0 meters and total flow volume set at delivery rate of less than 2.2 liters per minute". K p3 shows how such a fault sits in nested code: `if (altitude_adj == 0) { ... if (volume < 2.2) { faulty code } }`; a test with `altitude_adj == 0` and `volume = 1` triggers it.
- K p4: 1-way `pressure < 10`; 2-way `pressure < 10 & volume > 300`; 3-way adds `velocity = 5`. "The most complex failure reported required 4-way interaction to trigger." These are illustrative predicate notation, not portable code.
- N p1: "NIST research showed that most software bugs and failures are caused by one or two parameters, with progressively fewer by three or more"; "no failures discovered by NIST or other researchers have involved more than six parameters"; covering arrays of 3-way to 6-way combinations "can provide strong testing".
- K pp13-16: all combinations of 10 binary parameters = 2^10 = 1,024 tests; there are 120 3-way interactions; a covering array of 13 tests covers all 960 3-way value combinations.
- N pp3-4 name two NIST research tools, ACTS (generates tests, supports constraints between parameters) and CCM (measures the combinatorial coverage of any test suite); K pp18-22, 32 describe measuring coverage and supplementing tests (K p23 shows an unnamed "Coverage Measurement Tool"). The tools are optional examples here.
- N pp2-3 case reports (different cases, do not combine): an eight-project Lockheed Martin study with testing cost reduction of approximately 20 % and 20 % to 50 % improvement in test coverage; an avionics proof of concept with 47,040 generated test cases; an HEVC conformance case with an 84X efficiency improvement. The Lockheed figures come from a joint NIST-Lockheed agreement (N p2; reference [2], whose authors include D. R. Kuhn and R. N. Kacker); the avionics and HEVC figures are reported by other organizations (N pp2-3, references [3] and [4]). None is an effect size of this skill.

Rule details:
- C1: most reported failures involved one or two parameters, progressively fewer more. Bounded observational evidence, not a guarantee for the program at hand. The underlying data (the curves of K pp4-9 and the 2004 paper) were not available as text here, so the label rests on the authors' summary statements, which K p11 itself hedges ("More empirical work needed").
- C2: required examples are the three above; the nested-condition manifestation (K p3) is part of the source. Choosing actual values that satisfy the predicates is an INFERENCE operationalisation.
- C3: each row of a covering array is a test, each column a parameter; the array covers all valid value combinations at its strength. Six is the observed maximum in the reported evidence, not a universal ceiling. Do not impose a fixed t or forbid feasible exhaustive testing.
- C4: distinguish selected strength, planned combinations and achieved coverage. Existing suites can be extended, not necessarily replaced. Constraints restrict valid combinations; they do not disqualify combination testing.
- C5: the qualifiers listed in K p16 are value propagation issues, equivalence partitioning, timing issues and more complex interactions (the list is open-ended in the source). The claim that t-way testing is equivalent to exhaustive testing requires that all faults are triggered by at most t parameters and a small discrete value set (R abstract); do not assume those premises. Timing and continuous domains need qualified modelling, not automatic dismissal or universal assurance.

Limits: the 2004 paper was not read; the bulletin and slides come from the same group; no independent replication was found.

## Maleti and Nel: seven debugging steps

What M did: 17 programming lecturers from three Zimbabwean higher-education institutions had completed a mindset questionnaire; six were selected at random (three with fixed and three with growth mindsets). Data: decoding interviews, structured interviews and think-aloud debugging of three C++ programs (syntax, semantic and logical errors; P6 withdrew from the exercises). Analysis: an adapted Narrative Data Analysis Framework and NVivo. Result: seven steps, presented as a model for teaching novices. There is no limitations section, no outcome test and no quantitative result beyond counts scattered in the text; "future research" is to assess instructional interventions based on the model (p16). The manuscript is pre-review.

Rule details (each is DESCRIPTIVE, applies to bug fixing):
- D1 (Step 1, p7 and p12): identify the program objective by scanning, visualising what the program should achieve and keeping or writing down the objective. Not when there is no debugging task; reuse an established objective.
- D2 (Step 2, p8 and p12): read line by line and check language fundamentals (variables, data types, operators, expressions, control structures, arrays, functions, structures, input/output), directives, global and local declarations and entry-point statements. The C++ constructs are adapted to the language at hand only as INFERENCE.
- D3 (Step 3, p8 and p12): build, compile and run with a debugger, use breakpoints to reach the lines with errors, check line by line, take the location reported by the compiler. Tool-neutral execution is INFERENCE. A debugger does not necessarily find every error or guarantee the actual cause.
- D4 (Step 4, pp8-9 and p12): classify as syntax (prevents compilation), semantic (compiles but terminates abnormally at runtime) or logical (runs but gives incorrect results); handle syntax errors first so the program can run. These are the manuscript's categories, not a universal taxonomy.
- D5 (Step 5, p9 and p12): read error logs, descriptions and suggested solutions; if the error is not understood, read manuals and tutorials, research online or ask someone with a similar problem; dry-run by tracing variable values. The condition "if you cannot understand" is from Fig. 3 step 5b; the prose of p9 says all participants went online. Websites and named tools are optional.
- D6 (Step 6, pp9-10 and p12): repair one error at a time (participant P2: "I change one thing [code] at a time; I don't change all the code"); the syntax, semantic and logical branches each go to Step 7. Individual participants' ordering anecdotes are observations, not rules.
- D7 (Step 7, p10 and p12): re-test after each repair by rebuilding and rerunning until the program performs as intended; repeat Step 3 while it does not. A blocked-loop pause is INFERENCE (W3).
- D8 (§4.2, pp11-13): forward reasoning is used to understand a program's objective and its current status, backward reasoning to work from clues in the program output (p11); previous experience is used as well. Participants used forward reasoning for syntax tasks and switched to backward reasoning for semantic and logical tasks; this mapping is not shown to be optimal.
- D9 (§§4.3-5, pp13-16): participants who persisted, learned from setbacks and sought help; do not diagnose mindset, disparage breaks or require unlimited continuation.

### Original C++ sub-activities (verbatim)

Transcription of M p12 Fig. 3 ("Sub-activities for Expert Debuggers' Mental Processes Model"); PDF line wrapping normalised, wording preserved. Evidence: DESCRIPTIVE.

1. Identify the program objective(s):
   a. Scan through the program
   b. Visualize what the program is trying to achieve
   c. Keep in mind or write down the objective(s)
2. Familiarize yourself with the program before problem identification:
   a. Read through the program line by line
   b. Check fundamental C++ concepts
   c. Check pre-processor directives
   d. Check global and local declarations
   e. Check statements within the main()
3. Localize (spot) the program error:
   a. Build, compile, and run the program using C++ Debugger
   b. Use break points to reach lines with errors
   c. Check each line by line-locating error
   d. Locate (spot) the program error located by the C++ compiler
4. Classify the program error:
   a. Is the syntax correct?
   b. Are the semantics correct?
   c. Is the logic correct?
5. Determine the actual cause of the program error (understand the program error):
   a. Read through error logs, descriptions, and suggested solutions from the IDE Debugger
   b. If you cannot understand the program error:
      - Read through language manuals, textbooks, and tutorials
      - Research on the Internet (e.g., visit Stack Overflow and YouTube to obtain more information about the bug)
      - Ask someone who had similar problem(s)
   c. Dry-run the code (manually tracing values of variables)
6. Repair/fix the program error:
   a. If the error is syntax, then: Fix the syntax error and go to Step 7
   b. If the error is semantic, then: Fix the semantic error and go to Step 7
   c. If the error is logical, then: Fix the logical error and go to Step 7
7. Re-test the program until it achieves the intended objective(s)
   a. Rebuild and re-run the program
   b. Repeat Step 3

### Branches and retest loop

D1 → D2 → D3 → D4 → D5 → D6 → D7. The resource and help activities in D5 depend on incomplete understanding. Each D6 error-type branch goes to D7. D7 repeats D3 while the objectives remain unmet. Only four of the six participants started with Step 1 (p7); the order here is the numbering of Fig. 3. Keep these branches instead of flattening the model into seven one-off actions. Source: M p12 Fig. 3 (text); the flowchart image (M p11 Fig. 2) was not readable in the text extraction, so the loop is taken from the Fig. 3 text and the prose.

### Reasoning, experience and setbacks

M §4.2 (pp11-13) reports forward (top-down) reasoning and backward (bottom-up) reasoning and the role of previous experience; §§4.3-5 (pp13-16) report how growth-mindset participants P1-P3 described persistence and changing focus or perspective after setbacks, how fixed-mindset P4 and P5 described taking breaks and not seeking help, and how P6 (fixed) described reading more and sharing with colleagues; the link between help-seeking and a malleable mindset comes from cited literature (p3, p15). Pedagogical and future-research recommendations of the manuscript are context, not unrelated developer actions. One paper in M's reference list is titled "Fixed versus growth mindset does not seem to matter much"; titles of cited papers are bibliographic information, not findings that were verified here.

## Operational adaptations (INFERENCE)

These make the source recommendations actionable for an agent. They are decided design, not study findings.

- W1: list conditions, parameters, values and constraints before combination testing; state the chosen t and the reason, then proceed without waiting. The user may override in the next prompt. The reason is grounded in the interactions found and the feasible scope; there is no universal default t and no claim of full coverage without checking. Obey a strength the user states.
- W2: check relevant result types, short-circuiting, evaluation order, side effects and operator semantics before rewriting a condition. Necessary coercions (for example a conversion that looks like a double negation) are not removable merely because of how they look. If preservation is uncertain, keep the existing form and say why.
- W3: report missing inputs, facilities or permission; if another pass supplies no new evidence or actionable repair, report the blocker instead of retrying unchanged work. Never fabricate a run, a cause, a coverage measurement or a successful repair. No unrelated debugging technique is added.
- Cross-language use of the C++ sub-activities, the Scope/Method/Result record, and the choice of single, pair and triple examples with actual values are INFERENCE.

## Guardrails and applicability exceptions

1. No style-only rewriting of working conditions, even if regression tests exist. Behaviour-preservation safeguards are INFERENCE, not B outcomes.
2. No universal ranking by negation count, regularity, AND/OR or De Morgan layout. Keep the measured exceptions and the provisional explanations (B pp5-9 §§4.2-6).
3. No claim that whole-condition FALSE alone is harder than TRUE, or that literal-regularity or logical-regularity explanations are independently established causes (B pp6-9 §§4.2.2-6).
4. No extension of B to negated identifier names, computed comparisons, mixed AND/OR or short-circuit readability; short Python snippets without short-circuiting bound the experiment (B pp3-4 §§3-4.1; pp9-10 §§6-7).
5. No invented effect sizes or promises of speed-up or defect reduction for the skill. The Lockheed cost and coverage figures and the HEVC efficiency figure describe different cases (N pp2-3).
6. No claim that pairs or triples find all faults, no universal six-way ceiling, no unconditional equivalence to exhaustive testing, no conflation of combination coverage with structural coverage (K pp11, 16-17, 32; R abstract).
7. No claim to have read the 2004 Kuhn paper, and no claim of independent replication from the same group's bulletin (R).
8. No "studies prove" for the debugging model, a mindset interpretation or the combined skill. Six selected lecturers, three C++ exercises and future outcome assessment limit the evidence (M pp5-6 §§3.1-3.2; p16 §5).
9. Cite M as a pre-review manuscript, not final, keeping its SACLA 2025 context and 2026 bibliographic citation (M p1).
10. Cited-paper titles in M are bibliographic information; do not claim unread studies confirm or contradict the model. No mindset diagnosis, no anti-break rule, no unlimited persistence (M pp13-17 §§4.3-5 and references).
11. No mandatory ACTS, CCM, IDE, website or external search; adapt permitted facilities to the task and mark adaptations INFERENCE.
12. Do not add reproduction, hypothesis testing or another workflow as steps of the seven-step model; keep its actual sub-activities and branches (M pp7-12 §4.1, Figs. 2-3).
13. No waiting for approval of t, no fixed default t, no blanket ban on feasible exhaustive testing, no invented successful execution.
14. No guarantee that description-only activation works and no claim that the combined skill has been validated live; activation mechanism and test status are in PRIVATE.md.

## Observable behaviours

Operational checks for tests; they are INFERENCE, not validated study outcomes.

1. Applicable tasks show `Scope:`, `Method:`, `Result:` with concrete task content, not only a skill-load acknowledgement; non-code tasks do not.
2. Conditions, parameters, values and constraints appear before combination testing.
3. `Method:` states the chosen t and its reason marked INFERENCE; the agent proceeds without waiting and accepts a later override.
4. Tests exercise the promised valid combinations; single, pair and triple examples are available and strengths up to six are considered where relevant.
5. `Result:` distinguishes selected strength, planned combinations, achieved coverage and gaps; existing suites can be supplemented.
6. The agent does not claim pairwise completeness, a universal six-way ceiling or structural coverage from a parameter matrix.
7. Condition work distinguishes variable, literal and whole-condition values; provisional interpretations are not relabelled CLEAR.
8. A requested rewrite preserves relevant evaluation, type and side-effect behaviour; no unrelated working condition is changed only for style.
9. A necessary double-negation conversion is preserved; no automatic operator-count or De Morgan readability ranking appears.
10. Debugging shows objective, familiarisation, localisation, classification, understood cause, one-error repair and immediate retest in order; established facts may be reused explicitly.
11. Incomplete understanding triggers diagnostics, tracing or conditional resource and help consultation, without mandatory named tools or websites.
12. Syntax, semantic and logical repair branches each reach retesting; a remaining failure returns to localisation instead of an unsupported success claim.
13. Forward and backward reasoning and previous experience are visible where relevant; setbacks invite a changed perspective, learning or help without mindset diagnosis or endless repetition.
14. Prohibited or unavailable execution yields an explicit blocker or "unverified" result, never fabricated passing tests.
15. Claims keep the CLEAR, DESCRIPTIVE and INFERENCE distinctions, citations, the pre-review status and bounded assurance.
16. All original C++ sub-activities and model branches are present in this file; language-specific execution adaptations are marked INFERENCE.
