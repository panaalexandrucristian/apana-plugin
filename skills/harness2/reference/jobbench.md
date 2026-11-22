# One JobBench task using OpenCode

This is an experimental native macOS path, not an upstream-supported benchmark configuration. First pass the local demo.

1. Locate the installed `opencode` (`command -v opencode`); record its absolute path and `--version`. Require support for `run --standalone`, `--format json`, `--auto`, and `--model provider/model#variant`. Verify that `timeout` on the child's `PATH` supports `--kill-after`. Stop on incompatibility or missing tools; do not install another OpenCode or change platform.
2. Create a fresh, dedicated checkout of the exact Harness² revision reported by `setup.py check` (a local clone of the verified install is enough). From that checkout, run `git apply --check` and then `git apply` with the bundled [adapter patch](harness2-jobbench-installed-opencode.patch). Do not patch the managed checkout. For all commands below, work in the patched checkout and set `PYTHONPATH` to its absolute path and `HARNESS2_INSTALLED_OPENCODE` to the installed executable's absolute path. Use the absolute virtualenv CLI paths reported by `setup.py check`. Show `harness2-setup jb --substrate oc --dry-run`; it should show JobBench data and dependencies but no OpenCode or Bun installation. Run the setup without `--dry-run` only after approval for those downloads. Record `dependencies/job-bench-eval/dataset/main/.harness2-download.json`.
3. Use only public JobBench data. Use a separate `HOME`, separate OpenCode XDG config/data/cache/state directories and an allowlisted environment. Do not share the host's OpenCode config, plugins or session database. With approval, transfer only the providers needed via the installed CLI: send `opencode auth export <provider>` directly into `opencode auth import --standalone` running in the separate profile; never print or log the export. Do not pass a separate judge API key. The profile is **not** OS or network isolation; stop if the executor still has access to private files, repos or unrelated credentials.
4. Ask the user to choose or confirm `HARNESS2_SOLVER_MODEL`, `HARNESS2_IMPROVER_MODEL` and `HARNESS2_JUDGE_MODEL`, all in `provider/model` form. Confirm the improver's effort and set `HARNESS2_IMPROVER_EFFORT` explicitly. Check all model IDs with the installed binary's `models --standalone` in the separate profile, and run `harness2-check --bench jb --substrate oc` there. Get approval before any ADC token check triggered by a `google-vertex` executor or improver. These checks don't prove model access; stop on failure rather than switching binaries, providers or auth paths.
5. Set `HARNESS2_RUNS_DIR` to a fresh absolute directory under the patched checkout's `runs/`. Pick one domain in the installed data. Preview:

   ```sh
   harness2 --bench jb --substrate oc --mode parallel --k 1 --only-domains <domain> --max-tasks 1 --dry-run
   ```

   Require a successful preview of exactly the expected task: the cap is per domain. Before removing `--dry-run`, present the task, output location, data disclosed and effective models/providers for reference runs, probes, improvement, final execution and both evaluations. Explain that `k=1` is neither one API call nor a spend cap. Let the user change models, confirm or cancel. Any change requires rechecking effective settings and a fresh confirmation. Without explicit consent, do not run or judge.
6. After a successful rollout, keep the same executable, separate profile, model settings and runs directory. Run:

   ```sh
   harness2-judge --bench jb --substrate oc --mode parallel --k 1
   harness2-judge --bench jb --substrate oc --mode parallel --k 1 --bases
   harness2-report --bench jb --substrate oc --mode parallel --k 1
   ```

    Report failures as failures. Correlate the task and run IDs in the summary, `judged.json` and `base_judged.json`; the standard report covers the final, not the baselines. A numeric zero is valid; missing/null scores are not graded. To claim live success, record the installed binary path/version, redacted evidence of execution and improvement through it, and actual OpenCode rubric verdicts for final and baselines. Cache hits or local no-output scores do not demonstrate the evaluator. This is a functional smoke test, not a comparable upstream benchmark result.
