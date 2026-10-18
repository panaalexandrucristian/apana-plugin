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
| `apana:explica-clar` | A mode, switched on by the user, in which every explanation is clear. |
| `apana:omlx` | Runs a local model on an Apple Silicon Mac with oMLX. |
| `apana:android-ui-step` | Taps a label on an Android emulator and prints a digest of the new screen. |
| `apana:install-claude-auto`, `apana:uninstall-claude-auto` | Put the `claude-auto` wrapper (a fresh session at a token threshold) on PATH, or remove it. |

OpenCode: clone this repository, add its absolute path to the `plugins` array of `opencode.json` or `opencode.jsonc`, restart OpenCode. Only `logic-test-debug` is set up there.

## Hooks

`hooks/hooks.json` calls `scripts/apana-hook.mjs`, which adds context and never decides anything:

- the `logic-test-debug` directive on code prompts (`APANA_LOGIC_TEST_DEBUG=off` turns it off);
- the `class-graph` nudge after a bare `/apana:class-graph` (`APANA_CLASS_GRAPH_NUDGE=off` turns it off; `APANA_CLASS_GRAPH_STATE_DIR` moves its state).

`opencode-plugin.js` sets `logic-test-debug` up on OpenCode.

## Tests

    npm test                  # node suite: hooks, skills, self tests, end to end
    npm run test:omlx         # offline Python suite of omlx
    npm run test:claude-auto  # offline Python suites of claude-auto and its installer

Node 22 and Python 3 are needed; `class-graph` and `find-usages` also need ripgrep (`rg`). `AGENTS.md` says how to work in this repository.
