---
name: harness2
description: Installs and runs the pinned Harness² package on Apple Silicon Macs from OpenCode or Claude Code. Use when the user asks to set up, check, demo, or run Harness² with OpenCode as its only internal agent.
---

# Harness²

Invoke `/apana:harness2` in OpenCode or Claude Code. For JobBench, use the OpenCode executable already installed on the Mac for execution, improvement and grading model calls. Keep JobBench's rubric scoring; only the model transport changes. Do not install another OpenCode or fall back to Codex, Claude Code or a direct judge API. Loading this skill alone never authorizes installation, authentication or model calls.

## Install or verify

On native macOS arm64, require `python3`, Git and `uv`. Do not install system tools, use Rosetta, or fall back to a VM. Start with:

```sh
python3 "${CLAUDE_SKILL_DIR}/scripts/setup.py" check
```

Use the loaded skill directory if the host does not expand the variable. If missing, run `install --dry-run` in place of `check`. Show the destination, source pin and planned downloads, then run `install` only after approval. Use `check` again to report the absolute CLI paths. Reuse a verified installation; stop on inconsistent state without deleting or overwriting it. Do not change the user's shell, tool settings or repo.

## Demo, no models or credentials

Run the reported `harness2-demo` executable with working directory set to the managed Harness² checkout and `--output` pointing at a fresh absolute directory under that checkout's `runs/`. Report the exit status, completed/failed counts and path to `demo.json`. This exercises the local workflow, not OpenCode, model access or patch quality.

## JobBench — experimental on macOS

Read [reference/jobbench.md](reference/jobbench.md) only for an explicit benchmark request. It requires separate approval for setup and for model calls. Do not start either from a demo or install request. No arbitrary repos, private task inputs, WorkBuddy, or automatic patch application.
