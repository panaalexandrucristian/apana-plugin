# AutoScope Broker Implementation Plan (superseded)

Historical design only. The standalone planner/launcher was removed in favor of explicit `/apana:scope` hooks in ordinary Claude sessions. Do not implement or install this plan; current behavior and limits are documented in README.md and skills/scope/SKILL.md.

> **For Hermes:** implement task-by-task with strict RED → GREEN → REFACTOR; do not commit without the user's explicit approval.

**Goal:** Add an installable `claude-scope` workflow that accepts a natural-language implementation task, derives an exact change manifest read-only, runs the implementation in an isolated independent clone under fail-closed guards, accepts tests only when they prove the production change, and exports only a validated patch.

**Architecture:** A standalone Python 3 launcher orchestrates real Claude Code print-mode sessions. The planner has only Read/Glob/Grep and emits schema-validated exact paths. The executor runs in a temporary independent git clone with a generated fail-closed `PreToolUse` command hook. A final broker runs tests in an OS sandbox, performs path/diff validation, expected RED-on-baseline → GREEN-on-full-patch provenance and a mandatory semantic patch audit, then applies the exact validated bytes to an unchanged caller checkout. Existing Apana hooks are loaded normally; trusted class-graph scripts receive a parsed, read-only Bash exception.

**Tech stack:** Python standard library, independent local git clones, Claude Code CLI JSON/stream-JSON, sandbox-exec/bubblewrap, Node/Python/Gradle-compatible argv test commands, existing Apana plugin hooks.

---

### Task 1: Manifest and policy core

**Files:**
- Create: `skills/install-claude-scope/assets/claude_scope.py`
- Create: `skills/install-claude-scope/assets/test_claude_scope.py`

1. Write failing tests for schema validation, exact paths, traversal/symlink rejection, production↔test mapping, tests-only exception and trusted class-graph command parsing.
2. Run the targeted unittest suite and verify the expected failures.
3. Implement the minimal pure functions.
4. Re-run to green.

### Task 2: Planner and generated guard settings

**Files:** same launcher and tests.

1. Add failing fake-`claude` tests proving the planner gets only read tools and malformed/broad manifests stop before execution.
2. Add failing tests for the generated `PreToolUse` path hook, `onFailure:block`, shell default-deny and trusted analysis commands.
3. Implement planner invocation, schema parsing and settings generation.
4. Re-run to green.

### Task 3: Independent-clone executor and patch audit

1. Add failing integration tests around a temporary git repository and fake executor.
2. Prove implementation happens only in a temporary independent clone, out-of-scope changes fail closed, and caller files remain untouched on failure.
3. Implement clone lifecycle, executor invocation, exact diff audit and cleanup.
4. Re-run to green.

### Task 4: Test provenance gate

1. Add failing tests for feature/bugfix RED→GREEN, opportunistic tests that already pass on baseline, refactors without test edits, explicit tests-only tasks and pre-existing baseline failures.
2. Implement test-only patch extraction, isolated baseline clone, sandboxed argv test runner and expected-failure comparison.
3. Re-run to green.

### Task 5: Atomic export and failure recovery

1. Add failing tests that a validated patch applies to the caller checkout and an invalid/conflicting patch leaves it unchanged.
2. Implement `git apply --check` followed by apply, preserving untracked/pre-existing work and refusing dirty overlap.
3. Re-run to green.

### Task 6: Installer, skill, docs and packaging

**Files:**
- Create: `skills/install-claude-scope/SKILL.md`
- Create: `skills/install-claude-scope/scripts/install.py`
- Add installer tests.
- Modify: `README.md`, `package.json`, `.github/workflows/ci.yml`, both manifests and version-pin tests.

Document one-time installation and normal use: `claude-scope "task"`. Explain that activation is automatic inside this command, plain `claude` is unchanged, tests-only tasks are explicit, and no commit/push/release occurs.

### Task 7: Verification with real Claude Code

1. Run all offline suites and strict manifest validation.
2. Run real isolated sessions for feature, bugfix, refactor, tests-only, scope escape and irrelevant-test-in-allowed-file.
3. Repeat with `logic-test-debug` and active `class-graph-nudge` loaded.
4. Record cost, changed files and RED/GREEN results.
5. Obtain independent read-only review, then address findings through new RED→GREEN cycles.
