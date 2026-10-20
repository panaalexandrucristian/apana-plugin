# apana

A Claude Code plugin with skills and hooks that do not call Jev. Split out of `jev-mcp-private` (the `jev` plugin) on 2026-10-19.

Install:

    claude plugin marketplace add panaalexandrucristian/apana-plugin
    claude plugin install apana@apana-private

Update on each machine: `claude plugin marketplace update apana-private && claude plugin update apana@apana-private`.

## Skills

| Skill | What it does |
| --- | --- |
| `apana:compact-handoff` | Writes a compact handoff of the current session (or of a named OpenCode session) for a new session to continue from. |
| `apana:class-graph` | Kotlin/Java: where a function starts and ends, who uses a class or member, dependency chains between classes. |
| `apana:logic-test-debug` | Rules for reading Boolean conditions, testing combined conditions and debugging; started by a hook on code prompts. |
| `apana:variant-check` | Before a matcher or filter over text is written or changed: lists every distinct variant of the matched token in the real data (script with counts) and requires a before/after diff. |
| `apana:explica-clar` | A mode, switched on by the user, in which every explanation is clear. |
| `apana:omlx` | Runs a local model on an Apple Silicon Mac with oMLX. |
| `apana:android-ui-step` | Taps a label on an Android emulator and prints a digest of the new screen. |
| `apana:android-emulator-low-ram` | Measures Android Emulator memory and safely tunes a dedicated low-RAM AVD. |
| `apana:install-claude-scope` | Installs `claude-scope`, which automatically plans and enforces an exact change scope and accepts tests only for the production behavior changed by that task. |
| `apana:install-claude-auto`, `apana:uninstall-claude-auto` | Put the `claude-auto` wrapper (a fresh session at a token threshold) on PATH, or remove it. |

OpenCode: clone this repository, add its absolute path to the `plugins` array of `opencode.json` or `opencode.jsonc`, restart OpenCode. Only `logic-test-debug` is set up there.

### Guarded implementation tasks

Run `/apana:install-claude-scope` once, then from a clean Git repository:

    claude-scope "Fix the requested behavior and add only its regression tests"

`claude-scope` requires Claude Code 2.1.295+, plus `sandbox-exec` on macOS or `bubblewrap` on Linux. For Android/Gradle projects export `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) first: tests run in a sandbox with a private HOME, so a git-ignored `local.properties` is not available and the build fails with "SDK location not found". Test commands must be recognizable runner invocations (`node --test`, `python -m unittest|pytest`, `npm test`, Gradle/Maven test tasks); a refactor must name an existing narrow regression test and may not edit tests. On macOS the test sandbox allows only loopback networking; On Linux with bubblewrap, Ubuntu 24.04 needs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (otherwise `bwrap` fails with "loopback: Failed RTM_NEWADDR"); CI runs the sandbox tests on Linux. It derives an exact production-to-test manifest with repository-confined read-only tools, implements in an independent temporary clone, blocks writes outside the manifest, runs tests in an OS sandbox, checks feature/bugfix tests RED for the expected reason on baseline and GREEN with the production patch, performs a final semantic audit, then applies exactly the validated patch. Repository hooks/settings are ignored while the Apana hooks remain active. Plain `claude` remains unchanged. The accepted files stay uncommitted.

## Hooks

`hooks/hooks.json` calls `scripts/apana-hook.mjs`, which adds context and never decides anything:

- the `logic-test-debug` directive on code prompts (`APANA_LOGIC_TEST_DEBUG=off` turns it off);
- the `class-graph` nudge after a bare `/apana:class-graph` (`APANA_CLASS_GRAPH_NUDGE=off` turns it off; `APANA_CLASS_GRAPH_STATE_DIR` moves its state).

`opencode-plugin.js` sets `logic-test-debug` up on OpenCode.

## Configuration

Claude Code 2.1.271 or newer shows two Apana options in `/config` and in the plugin's **Configure** panel:

- **Logic test and debug guidance:** `on` (default) or `off`.
- **Class graph reminders:** `both` (default), `nudge-only`, `reminder-only` or `off`.

The existing environment variables remain compatible and take precedence when explicitly set: `APANA_LOGIC_TEST_DEBUG` and `APANA_CLASS_GRAPH_NUDGE` (`on`/`a`/`b`/`off`). OpenCode continues to use the environment variables because plugin `userConfig` is a Claude Code feature.

## Tests

    npm test                  # node suite: hooks, skills, self tests, end to end
    npm run test:omlx         # offline Python suite of omlx
    npm run test:claude-auto  # offline Python suites of claude-auto and its installer
    npm run test:claude-scope # offline Python suites of claude-scope and its installer

Node 22 and Python 3 are needed; `class-graph` and `find-usages` also need ripgrep (`rg`). `AGENTS.md` says how to work in this repository.
