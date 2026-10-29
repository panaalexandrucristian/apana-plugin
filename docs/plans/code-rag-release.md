# code-rag integration for the combined release

## Scope and snapshot

The owner selected a combined release of session cooperation and code-rag. Preparation uses `release-0.6.0` in `apana-plugin-rel060-common`; the source worktrees remain unchanged. This log is preparation evidence, not evidence of publication or installation.

The source session confirmed its final file inventory and paused edits while integration copied `skills/code-rag/`, `skills/code-rag-setup/`, `evals/code-rag-search/` and `evals/code-rag-setup/`. The copy matched the source SHA-256 hashes and permission modes before and after copying; the source inventory was unchanged (measured, n=18 files). Existing version/manifest changes in the release worktree already matched the source proposal and were not overwritten.

Local snapshot manifests: `/var/folders/hj/_v79y2cn7sq81stpsbd_d5p80000gn/T/apana-code-rag-snapshot-7gtilv8i/{before,after,copied}.json`. Subsequent release-only changes below intentionally differ from that snapshot.

## Live evidence reported by the source session

Reported on 2026-10-29, not rerun by the integrating session:

- The real index of `dgapp2-android` completed after resuming interrupted work (reported measured totals: n=1 repository, 1,231 files and 14,444 chunks). Model: Qwen3-Embedding-0.6B on MPS, Apple M3.
- Retrieval found the expected class within the top-five results for 6/8 questions and within the top-three for 5/8 (reported measured, n=8 manually selected questions on that repository). The source session corrected an earlier top-three count.
- `AddPaymentUseCase` did not appear within the requested top-twenty results for adding a payment card. This is a reported miss; the alternative payment paths were not investigated.
- `DgCreateAccountViewModel` also did not appear within the requested top-twenty results for signup, but the reference answer is uncertain: the class is a navigation wrapper while Gigya, which appeared first, performs registration.
- The questions were selected by the source session using class names, not drawn from a pre-registered evaluation set. These observations do not establish general retrieval quality.
- Existing code-rag eval fixtures were present but untracked. The source session corrected its earlier claim that no prior eval set existed. Those fixtures were not run; their trigger/output criteria are not evidence of actual indexing or retrieval.

Source-session offline results (reported measured, n=1 run per listed suite): setup n=9 tests; engine n=30 tests with dependencies, no skips. The earlier network-denied engine run covered n=29 tests; the added disappeared-file test was included only in the later normal run. Linux execution was not tested there; availability checks of direct dependency wheels did not validate transitive dependencies.

## Integration changes

- Added npm entry points for setup and engine tests and CI installation of only the pinned test dependencies. CI does not install torch or download embedding weights for these tests.
- The engine command fails on test failures, any skips, or an empty suite. The guard is tested with real temporary unittest suites: passing, failing, skipped, empty, passing-plus-skipped and failing-plus-skipped (measured n=6 cases). These cover all realizable truth combinations of success, skips and empty-run status (t=3, INFERENCE: each condition independently affects acceptance; an empty run cannot have a failure or a skip).
- Corrected the active-lock exit contract: keep the diagnostic on stderr and exit with `EXIT_LOCKED` instead of passing the diagnostic string to `SystemExit`. The strengthened existing regression failed before the code change and passed afterward (measured n=1 regression); it also checks that the other process's lock remains untouched. The locking algorithm itself is unchanged.
- Corrected setup instructions: readiness comes from JSON `ready`, not the check command's exit status; device/dimension come from install's `smoke`, not `check`; step failure stderr is separate from JSON; reuse of cached weights does not guarantee no Hugging Face contact.

## Final combined validation

Combined Node suite passed without failures or skips (measured n=867 tests, n=1 full run, run alone). Setup suite passed from the copied release tree (measured n=9 tests, n=1 run). The actual engine command on the default interpreter found n=30 tests and skipped n=9 for missing dependencies; the strict command correctly returned exit 1 despite unittest printing `OK (skipped=9)` (measured n=1 negative-environment run). This is verification of the skip guard, not a complete engine pass. `git diff --check` passed at this stage.

The full engine run subsequently passed without skips under a network-denying macOS sandbox (measured n=30 tests, n=1 run). A socket preflight failed with `PermissionError` before the suite, verifying the network restriction. The fresh test-only venv is `/tmp/apana-code-rag-release-eVC5e4/venv`, Python 3.12.13; installed versions were checked against the exact test pins (measured n=6 packages). Package installation happened before entering the network-denying sandbox; it is not included in the offline claim. No installer or embedding-model download was run.

`claude plugin validate` passed with warnings about the root CLAUDE.md not being loaded as project context and a missing plugin icon. It does not validate admission to the plugin directory, Linux execution or model-based behavior. Earlier cooperation suites are recorded in `session-cooperation.md`; they are not rerun solely because the conversation rotated. No formal model-based eval was run during integration. Publication, tag, push and user installation have not been performed by this integrating session. Final manifest/documentation and CI-guard checks passed (measured n=16 tests, n=1 targeted run after the documentation edits), and `git diff --check` passed. Preparation is complete locally. The owner subsequently confirmed commit, tag and push for the combined release, followed by CI monitoring. That authorization does not install the plugin or launchers into existing sessions.
