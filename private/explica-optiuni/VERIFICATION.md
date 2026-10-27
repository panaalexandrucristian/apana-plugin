# explica-optiuni command verification

Prepared on 2026-10-27 in the isolated `feat/explica-optiuni` worktree, based on `origin/main`. The command is `commands/explica-optiuni.md`, not a skill. The separate `release/0.4.0` worktree is untouched. This feature branch prepares the required minor version `0.4.0`; it is not a release or an installed update.

## Inputs and method

`eval/cases.json` preserves the exact supplied inputs. The real cases are verified factual extracts from the user-selected sessions `e5c52c6f-bdca-4fd5-a7e8-773f09d79a5f` (missing repair, unknown cause) and `aa14935f-8d69-427d-91a9-2f625d7c22f3` (successful build/search, unverified request). They are not full transcript replays. The English missing-evidence case and rejected-options follow-up are synthetic and labeled as such.

The comparison crosses command variants (short instructions, fixed structure, evidence-first instructions) with evidence cases (missing repair, partial runtime test, incomplete English conversation). Full t=2 crossing, INFERENCE: every variant must face every evidence condition and the small crossing is practical. Executed cells: **9, measured; n=9 invocations**, with no repeats. These results are not an estimate of reliability or a validated fatigue/readability study.

The actual CLI loaded an explicit temporary plugin containing Markdown `commands/*.md`, then invoked `/explica-eval:<candidate>`. Final-candidate runs use the actual Apana worktree and `/apana:explica-optiuni`. CLI options: `--bare --setting-sources project --plugin-dir <directory> --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode dontAsk --no-session-persistence --no-chrome --output-format stream-json --verbose --max-budget-usd 1 -p '<command> <input>'`. The dollar value is a configured per-invocation ceiling, not measured spend.

Initialization reported `gpt-6-astra` throughout the comparison, with no available tools and successful command discovery. No model or effort defaults were changed. CLI stderr emitted an unrecognized-model warning; cost metadata has unknown cost basis, so no verified billing claim is made.

## Comparison

`eval/candidates/` holds the tested prompts; `eval/comparison.json` holds exact generated responses and execution metadata. Manual assessment checked factual limits, initial context, language choice, scope-appropriate alternatives, no assumed consent, and readability. It did not use a second model as a judge.

All comparison invocations completed with a nonempty result and correct command discovery (**9, measured; n=9**). These are execution checks, not an automatic quality score. All preserved the central evidence limit and followed the conversation language, including the English transcript under a Romanian wrapper, without questions or tables.

- **Short instructions:** compact, but the real cases became dense paragraphs and the missing-repair recommendation drifted toward further investigation despite the original narrow request. It offered applying a repair as another option without evidence that it caused the incident.
- **Fixed structure:** closest to the user's approved example. It kept clear sections and respected the completed narrow verification. However, it retained unnecessary implementation detail; the partial-test options mixed the verification goal with ways to unblock it.
- **Evidence-first instructions:** careful about provenance, but repeated details and became substantially longer. Not selected for this user's reading preference.

Whitespace-separated word counts below are descriptive measurements, **n=1 response per cell**; shorter is not automatically clearer.

| Candidate | Missing repair | Partial test | Missing evidence |
| --- | ---: | ---: | ---: |
| Short instructions | 298 | 326 | 138 |
| Fixed structure | 393 | 409 | 200 |
| Evidence-first | 539 | 603 | 274 |

## Refinement and limits

Selected the fixed-structure approach, adding local-transcript input guidance, preserving the conversation-language rule, separating alternatives from sequential steps, and retaining evidence/authorization boundaries. The first refinement still grew on real inputs: **421 and 461 words, measured; n=2 responses**, versus **393 and 409, measured; n=2** for the fixed-structure baseline. It was not accepted as a shortening. `eval/final.json` preserves these first-refinement outputs plus the incomplete-evidence and rejected-options cases.

A further edit adds an editorial length target, removes literal slash-separated headings, and discourages speculative extra options. The completed runs were inspected on 2026-10-27 after the handoff. `eval/final-v2.json` preserves exact responses, supplied inputs, command snapshots, execution metadata and stderr. Every snapshot matches the current command byte for byte. All invocations completed successfully with the command discovered and no available tools: **4, measured; n=4 invocations**. These were existing generation runs, not newly generated responses in the resumed session.

Whitespace-separated word counts are measured, **n=1 response per case per revision**. Deltas are calculated from those counts; the real inputs are the same verified extracts, not full transcripts.

| Case | First refinement | Final refinement | Delta (calculated) |
| --- | ---: | ---: | ---: |
| Missing repair (real extract) | 421 | 267 | -154 |
| Partial test (real extract) | 461 | 285 | -176 |
| Missing evidence (synthetic) | 181 | 255 | +74 |
| Rejected options (synthetic) | 241 | 256 | +15 |

The real-extract responses became shorter; the synthetic responses did not. Do not describe this as universal shortening or proof of improved readability. Manual inspection found:

- **Missing repair:** keeps absence of the repair separate from incident causation, explains the original request, and recommends stopping after the requested verification. It omits the raw commit and parameter identifiers, but still retains an unnecessary incident ID and the interrupted-inspection history.
- **Partial test:** keeps build/search success separate from delivery of the privacy field, labels old unit-test claims as reported rather than rerun, and leaves the authentication cause unknown. It offers stopping with an explicitly partial result or continuing verification, rather than presenting consecutive steps as alternatives. It still includes avoidable field names and unit-test values.
- **Missing evidence:** answers in English despite the Romanian wrapper, distinguishes reported completion from observed results, and does not infer that undocumented actions never happened. The added detail on timing, test scope and delivery makes this synthetic case longer; the extra length is not evidence of improved clarity. It correctly avoids manufacturing alternatives when the explanation-only request is already satisfied.
- **Rejected options:** responds to the constraint of no account data and no code changes with different, conditional proposals. It does not claim available builds or distribution records exist, and distinguishes test-environment evidence from the real incident. It repeats some context and retains a relatively long set of alternatives. The stream contains a synthetic continuation request after an interrupted response (**1, measured; n=1 feedback invocation**); the final result succeeded, but this is not an uninterrupted single-response sample. The notice is preserved with the result.

Assessment: the sampled responses preserve the central facts, conversation language and authorization limits. The final command is ready for the user's own readability trial, not proven universally easy to read. Remaining editorial issues above are not hidden by the passing execution checks. No further prompt edit was made during this verification.

Local command discovery under `--bare` failed in the initial probes even though the process returned text. Those outputs were excluded: successful process exit did not establish command expansion. Loading an explicit plugin corrected discovery. Raw scratch artifacts, including failed discovery probes, exact invocation arrays, command snapshots and stderr, remain at `/tmp/explica-command-tests-jqVyscCX/`.

The generation checks disable tools and hooks. They test command expansion and answer generation, not local session-ID lookup, large-transcript extraction, arbitrary languages, installed marketplace updates, or interaction with every installed hook. Read-only behavior in the shipped command is instruction-based, not a security boundary.

## Repository checks

- Packaging regression was RED before the command and README section existed: **3 failures, measured; n=3 tests**. After integration it was GREEN: **3 passes, measured; n=3 tests**.
- Plugin validation passed with the existing missing-icon warning.
- Full Node suite (`npm test`) passed: **767 passes, measured; n=767 tests**, no failures or skips. It ran alone, after the first final-candidate generation batch and before the next one. Python suites were not run because no Python runtime or installer behavior changed.
- Final refinement generation checks: completed and manually inspected as described above. No generation rerun was needed: saved command snapshots exactly match the current file.
- Resumed-session checks on the final command: packaging tests passed (**3, measured; n=3 tests**), plugin validation passed with the existing missing-icon warning, and the full Node suite ran alone and passed again (**767, measured; n=767 tests**, no failures or skips). Log: `/tmp/explica-command-tests-jqVyscCX/npm-test-resumed-71e295e3.log`. Python suites remain unrun for the reason above.
- At the end of the verification above, no commit, push, tag, release, global command installation or installed-plugin update had been performed.
- The user subsequently approved the explanation format after a read-only application to another local transcript and requested integration and push to `release/0.4.0`. That application used the command's instructions in the current session, not an installed slash-command invocation. It does not replace the remaining end-to-end lookup coverage.
