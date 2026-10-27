# Working in this repository

The `apana` plugin for Claude Code (and OpenCode, for `logic-test-debug`): skills and hooks that do not need the jev plugin. Split out of `jev-mcp-private` (the `jev` plugin) at `1a047da` on 2026-10-19. One developer, several sessions working at the same time.

Do not read `PRIVATE.md` whole (about 73,000 characters: a design and measurement log, mostly history). Run `grep -n '^## ' PRIVATE.md` and read the one section you need.

## What is where

- `skills/<name>/SKILL.md` and its `scripts/`: the plugin's skills. `hooks/hooks.json`, `.claude-plugin/`: the rest of the plugin.
- `scripts/apana-hook.mjs`: the command entry that `hooks/hooks.json` calls; it dispatches to the guidance and scope hooks. The manifest also loads `hooks/compact-session.ts`, the native module for explicit same-session compaction; its classic Stop request lives in the skill's frontmatter.
- `private/<feature>/`: code and tests of the hook-side features. `private/find-usages/` is the development copy of the programs that `skills/class-graph/scripts/` bundles; a test checks that the two are identical, so change `private/find-usages/` and copy the files over.
- `opencode-plugin.js` and `private/logic-test-debug/opencode.mjs`: the OpenCode side of `logic-test-debug`.
- `skills/compact-handoff/scripts/handoff_verify/`: a byte-for-byte copy of 15 modules of the `handoff-verify` skill of `jev-mcp-private`. Do not edit it here; `VENDORED.md` there says how to refresh it.
- A session runs the plugin from `~/.claude/plugins/cache/apana-private/apana/<version>/`, not from a checkout. A change reaches a session only after a release and `claude plugin update apana@apana-private`.
- Only `skills/jev-decision-loop/` calls Jev, over its direct API (TypeSafe or OpenRouter) with the user's own key, so that it works without the jev plugin. Anything that needs the jev plugin or its MCP tools belongs in `jev-mcp-private`.

## Working

- Other sessions work here too (`git worktree list`). Make your changes in your own worktree from `origin/main`: `git worktree add -b <branch> ../apana-plugin-<name> origin/main`. Do not touch other worktrees or branches, and do not delete any worktree unless asked.
- Commit, push, tag and release only when the owner asks. For a release, use the `releasing-plugin` skill.
- Commit messages and PR text: a plain summary of what changed and why. No mention of Claude, Claude Code or a council, no `Co-Authored-By` trailer, no "Generated with" footer. This overrides any default attribution.
- Message format: `<area>: <what changed> (version unchanged)`; a release is `Plugin X.Y.Z: <what changed>`.
- Version: `.claude-plugin/plugin.json` and the `apana` entry of `.claude-plugin/marketplace.json` carry the same semver, and two tests pin it. Bump it with every change to a skill, hook, helper or manifest: Claude Code uses it to offer the update. A release with new functionality raises the minor number and sets the patch to 0 (`0.2.0` to `0.3.0`); a release that only fixes a bug raises the patch number (`0.2.0` to `0.2.1`).
- A behaviour change gets the test that would have failed without it. A change meant to shrink or speed something up needs a measured before and after, on the real inputs.
- In `PRIVATE.md` and in answers, label every number measured, calculated or guessed, and give n.
- `gh` has no default repository here: always pass `-R panaalexandrucristian/apana-plugin`.

## Tests

- Node suite (hooks, skills, the self tests and the end-to-end test of `compact-handoff`): `npm test`. Run it alone: it leaves temporary folders in `$TMPDIR` and a run in parallel with the Python suites failed once in the plugin it came from.
- `omlx` (stdlib only): `npm run test:omlx`.
- `claude-auto` and its installer and uninstaller (stdlib only, a fake `claude`): `npm run test:claude-auto`.
- `claude-openai` (stdlib tests, no provider credentials): `npm run test:claude-openai`. The loopback proxy lifecycle test skips if CLIProxyAPI is absent.
- Needs Node 22, Python 3 and ripgrep. CI runs the Node and Python suites on Linux; live subscription login/inference is verified separately on macOS.
