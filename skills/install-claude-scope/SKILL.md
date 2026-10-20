---
name: install-claude-scope
description: "Use when the user wants Claude Code to change only task-relevant production code and add or modify tests only for production behavior changed by that same task, or wants to install, update, repair or use the `claude-scope` automatic guarded workflow. Romanian: nu modifica nimic în plus, doar codul cerut, teste doar pentru codul schimbat, instalează claude-scope."
---
# install-claude-scope

Install `claude-scope`, a one-task launcher for Claude Code. The user supplies only a natural-language task; the launcher automatically:

1. requires a clean Git checkout;
2. runs a read-only planner that emits an exact-file production→test manifest;
3. implements in a temporary independent clone under fail-closed path and semantic hooks;
4. permits only exact trusted Apana class-graph analysis commands through Bash;
5. runs tests in an OS sandbox and verifies feature/bugfix tests are **RED** with their expected failure signature on baseline and GREEN with the production patch;
6. performs a mandatory final semantic patch audit and applies the same validated bytes to the unchanged caller checkout without committing them.

An explicit `tests-only` task is the exception that may add tests for untouched existing production code. A behavior-preserving refactor may not rewrite tests. Sessions started with plain `claude` are unchanged; protection is automatic for every task started with `claude-scope`.

## Install or update

Requirements: Claude Code **2.1.295 or newer** (for command hooks with `onFailure: "block"`), Git, Node.js and Python 3. On macOS the built-in `sandbox-exec` confines tests (loopback networking only); on Linux install `bubblewrap` (`bwrap`; on Ubuntu 24.04 set `kernel.apparmor_restrict_unprivileged_userns=0`, otherwise `bwrap` fails with "loopback: Failed RTM_NEWADDR"). Android/Gradle projects also need `ANDROID_HOME` exported, because tests run with a private HOME and cannot see a git-ignored `local.properties`. The command refuses to run tests without one of these sandbox providers.

Run the bundled installer rather than copying files or editing shell configuration by hand:

```bash
python3 -I ${CLAUDE_SKILL_DIR}/scripts/install.py
```

It installs `~/.claude/claude-scope/claude-scope` and adds one marked PATH block to `$ZDOTDIR/.zshrc` or `~/.zshrc`. It backs up an existing rc once. Useful options:

- `--dry-run`: report intended changes without writing;
- `--no-rc`: install the command without editing zsh configuration;
- `--rc FILE`: use another rc file.

Do not print the user's rc file; it may contain secrets.

## Use

From a clean Git repository:

```bash
claude-scope "Fix divide-by-zero and add its regression test"
```

Optional controls:

```bash
claude-scope --planner-model haiku --model sonnet --planner-budget 0.25 --budget 1.0 "task"
```

The command refuses dirty repositories, old Claude Code versions, malformed or broad manifests, out-of-scope edits, arbitrary shell/MCP writers, tests already green on baseline or failing for the wrong reason, failing full tests and patch conflicts. Repository settings/hooks are ignored; only explicit AutoScope settings and the Apana plugin are loaded. It writes the manifest, transcript and report under `~/.claude/claude-scope/runs/` (or `CLAUDE_SCOPE_DIR`) and leaves the accepted files modified but uncommitted.

## Report

Tell the user:

- where the command was installed and whether the rc changed;
- that a new terminal or `exec zsh` is needed for the PATH update;
- that only `claude-scope` tasks are guarded;
- that the repository must be clean first;
- that no commit, push or release is performed.
