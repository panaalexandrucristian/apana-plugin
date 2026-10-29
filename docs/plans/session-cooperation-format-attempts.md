# Exact final response after automatic handoff

Release scope update, 2026-10-28: the owner subsequently authorized a combined `0.6.0` release with `code-rag`. The research authorization below records the earlier boundary; it does not prohibit that later explicitly authorized release. No live evidence or strict assertion is changed by publishing.

The owner's research request (2026-10-28) authorizes web research and justified fix attempts until the existing strict test passes, with a user-imposed maximum of 15 attempts. This supersedes the earlier pause on paid formatting retries in `session-cooperation.md`; it does not authorize a release, installation, global settings changes or weakening the test. The earlier failed runs remain failures.

Success means the existing live harness's first terminal owner response after `coordinate finish` equals `PTY_COLLABORATION_OK_323`, with the existing functional and isolation checks still passing. No output trimming beyond the unchanged harness comparison, response replacement, special-casing the marker, or corrective Stop-hook rerolls.

## Research

- OpenAI, [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide): resolve ambiguous or contradictory instructions and make exceptions explicit.
- Anthropic, [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#control-the-format-of-responses): specify output constraints explicitly. Guidance informs the candidate; it is not proof of a fix.
- Claude Code, [hooks reference](https://code.claude.com/docs/en/hooks): blocking Stop requests another turn after a response. It does not retract an already emitted answer, so it is not the chosen repair.

## Attempt 1 — preserve the output contract in the automatic resume prompt

Hypothesis: generic manual-handoff summary instructions compete with the original user's exact-response requirement. The constraint survived in prior transcripts, so missing context is not established as the cause.

Change: append a generic instruction to `new_session_prompt`, after pending-file directions: this is continuation of the same task, not a request for a handoff summary; preserve the user's final response format, including exact text. Irreversible-action and user-decision gates, continuation, and pending-file handling remain unchanged. No marker or test-specific instruction is added to production code.

Regression: the new test failed before the change (measured n=1 test, n=4 failing pending-count subcases). The `PendingFiles` group passes afterward (measured n=4 tests). Pending-count values are 0, 1, 12 and 13; strength t=1 (INFERENCE: one varied input dimension, covering absence, direct listing and the directory-summary boundary). `git diff --check` passes.

Live invocation, unchanged from the previous diagnostic:

```sh
/opt/homebrew/opt/python@3.14/bin/python3.14 -I -B /tmp/apana-wire-driver-7a78d1ef.py
```

Status: PASS (measured n=1 live run). Evidence: `/private/var/folders/hj/_v79y2cn7sq81stpsbd_d5p80000gn/T/apana-cooperation-wire-959ec703e301/observations.json`. The first terminal answer is exactly `PTY_COLLABORATION_OK_323`, `failed_checks` is empty, and the run reaches `stage=complete`. The unchanged functional checks, rotation, cancellation/re-claim, attribution/finish and OpenAI payload-isolation checks all pass. `private_auth_removed=true` and `global_settings_unchanged=true`.

The existing parser comparison accounts for every difference (measured n=10 finalized logs; n=1 known cancellation-suffix repair, no errors). Captured source hashes match the current files (measured n=18 files); the wrapper is the only captured file changed from the previous failing run. Cancellation is observed at 0.312621583994769 seconds (measured n=1 run), still transport evidence only, not proof of stopped provider-internal computation.

Full `npm run test:claude-auto` passes: wrapper assets (measured n=113 tests) and installer/setup (measured n=39 tests). `npm test` also passes without failures, cancellations or skips (measured n=861 tests), run after the Python and live processes completed. No further paid attempts are needed under the user's stop-on-success request. This one passing scenario does not establish a general reliability rate or complete provider isolation; prior failures remain recorded.
