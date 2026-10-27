# compact-session verification

Prepared locally on 2026-10-27 from `origin/main`, with the feature and its
reporting fix integrated under the `apana` namespace. The manifests stage version
`0.4.0`; this document is not a release or installation record. Tests used Node
v22.23.1 and the native hook harness in engine build `2.1.311`.

## Real-session evidence and cause

The session transcript at
`~/.claude/projects/-Users-apana-Dev-apana-plugin/5efb397e-3afe-4495-bcf9-73c240cded18.jsonl`
records the original local-mod trial. These private paths are local evidence,
not runtime dependencies or shipped fixtures.

Measured, n=2 real invocations before the reporting fix:

- The first invocation installed a compact context in the same session, followed
  by an actual model response using it. The archived context is
  `~/.claude/handoffs/compact-session-gnh0iccs/CONTEXT.md`.
- The next invocation ran its Stop hook without hook errors and reached native
  compaction, but kept the current context. Its status was
  `The compactor returned an invalid or nonshrinking replacement.`
  The verified candidate would have grown the prepared transcript from 86,331
  to 87,446 characters (measured, n=1 archived attempt). The corresponding
  snapshot and candidate remain under `compact-session-nh3qgh93`.

The second result was valid, not a failed or missing request. Keeping the old
context was correct; the problems were ambiguous reporting and the fact that
the terminal-only result was not delivered to the model's next prompt.

## Fix and behavioral comparison

The native module now validates shape separately from size, labels a verified
nonshrinking candidate as a no-op with measured character counts, and attaches
the last result to the next accepted prompt without rewriting the user's text.
A dropped prompt does not consume the report. Report state is in-memory and
resets on module reload; it is not a durable status store.

Measured, n=2 saved real snapshots replayed through the old and corrected local
hooks using the same actual Python preparation result: the successful case
installed identical text, and the nonshrinking case installed nothing in both.
Success status was unchanged. The no-op status became specific and measured;
the fixed hook additionally delivered each result as next-prompt context. Longer
temporary archive paths increased replay character counts relative to original
artifacts; no compression algorithm or limit changed.

The original and integrated Python helper files are identical. All existing
compact-handoff script dependencies match the earlier implementation (measured,
n=29 non-cache files). No compact-handoff source or vendored module was edited.

## Executed checks

- Before the local fix, measured n=10 added native regression tests failed for
  the intended reporting behavior; n=4 existing tests passed. An earlier fixture
  error from duplicate hook registration was corrected before that RED run.
- Integrated focused Node tests: measured n=90, all passed.
- Full `npm test`, run without parallel Python suites: measured n=854, all passed.
- Integrated `claude plugin test .`: measured n=14 native tests, all passed.
- Remaining offline suites ran sequentially after Node and all passed: `omlx`
  measured n=79; `claude-auto` measured n=92 runtime and n=35 installer tests;
  scope measured n=10 Node and n=5 Python tests; `claude-openai` measured n=15.
- `claude plugin validate .`: passed; the existing missing-icon directory warning
  remains. This is not a separate TypeScript compiler check.
- `git diff --check`: passed for tracked changes.

Report-delivery tests exhaust success/no-op/failure × accepted/dropped-first
prompt: t=2 (INFERENCE: the factors jointly determine delivery and consumption),
measured n=6 combinations in each harness. Existing activation × pending × turn
reason routing tests retain exhaustive t=3 coverage (INFERENCE), without claiming
that combination coverage proves all behavior. Independent cases retain checks
for subagents, ordinary compaction, truncation, invalid content, headless refusal,
one-shot behavior and later invocation superseding an undelivered report.

## Limits

The new reporting behavior has run in native hook tests and on saved real inputs,
not yet in another human invocation of the updated Apana plugin. No release,
cache installation or public-directory submission was performed. The API remains
unavailable in headless (`-p`/SDK) mode on the tested build. No fallback to the
standard summarizer exists. Unsupported content and failed verification leave
the context unchanged. Verification covers prepared text, not byte-for-byte
preservation of the native API snapshot: sanitization stays active and thinking
is archive-only. Character counts are not measured token savings.
