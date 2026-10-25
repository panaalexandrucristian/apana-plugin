# Verification and limits

## Verified integration

- Host: macOS; Homebrew CLIProxyAPI 8.0.40.
- Separate OpenAI Codex browser OAuth completed; no existing Hermes/Codex tokens were copied and no paid API key was configured.
- Print-mode smoke test succeeded with GPT model usage and the exact `CLAUDE_OPENAI_OK` marker. Session: `eace3892-f99c-4893-8404-b1457e2d0e5c`.
- A real interactive Claude Code session used `gpt-6-astra`, invoked `Read` for the test fixture, received its contents and returned `OPENAI_TOOL_READ_OK_7b9e21`. Session: `1e9a371c-89f7-43e5-a854-d3d0bce3685a`; interactive CLI version recorded in its transcript: 2.1.310.
- The same interactive session completed a second turn with the exact `SESSION_OPENAI_OK` reply.
- An additional real run explicitly selected `--permission-mode manual`, allowed only the `Read` built-in and succeeded with `OPENAI_TOOL_READ_OK_7b9e21`, two turns and no permission denials. Session: `c0ecc377-2031-4e62-b40e-f8c2000bf033`.
- The zsh alias resolved to the separate installed launcher.
- Unit/integration tests cover private/idempotent installation, login verification, model routing, remote-environment sanitization, asynchronous model readiness, authenticated loopback server and cleanup, uninstall/reinstall, and JSON success validation. Unit mock data is separate from the live session evidence above.

## Shared claude-auto instructions, skill v0.2.2

- The launcher imports only the installed wrapper's instruction-selection helpers through a non-main module load; it does not start its handoff loop. It passes the resulting append-system-prompt arguments before user arguments. Normal global/project instruction loading remains unchanged.
- Both new regressions were observed failing before implementation. All 14 tests passed, covering live source rereads, missing/incompatible source, the exact generated argv, and preservation of model routing/settings without adding handoff hooks or permission overrides.
- 72 combinations of actual installed `passthrough`/`rule_args` behavior matched the OpenAI launcher's helper, including environment opt-outs, explicit appended prompts, literal arguments after `--`, print mode and informational subcommands.
- Real reinstall reused OAuth and returned `CLAUDE_OPENAI_OK` on `gpt-6-astra`, session `8be6d43e-44d8-4f54-b973-863012345383`.
- Interactive session `0df20f74-cb4e-4052-a801-1f03dd95131d` ran on `gpt-6-astra`. Its live process command contained exactly one occurrence of the installed source's full rule. Its persisted assistant reply required enumerating all token variants actually present in real data, covering them in the matcher/filter, then diffing old/new outputs on real data and explaining every difference.
- `.zshrc`, user Claude settings, global `CLAUDE.md`, the `claude-auto` source and the private proxy config retained their original hashes. The installed runtime matched the updated skill source.
- Sharing instructions does not guarantee model obedience. This change deliberately preserves claude-auto's print-mode omission and opt-outs; it does not add automatic handoffs.

## Model picker cleanup, skill v0.2.1

Uses the documented `modelPicker` in session-only `--settings`, with `replaceBuiltInOptions: true` and deduplicated live catalog IDs. Requires Claude Code 2.1.242+; tested on 2.1.310. The default model comes first; labels preserve exact IDs. No `availableModels` allowlist, global settings or routing aliases are changed. Claude retains its built-in Default row.

- Before: 19 menu rows, including four custom family aliases duplicating Astra, the gateway Astra row, and Default.
- After: 15 menu rows: all 14 unique gateway IDs plus Default. Exactly one named `gpt-6-astra` row; image/review entries are retained. Runtime settings were compared with the live `/v1/models` response.
- Both focused regressions were observed failing before their fixes; all 12 tests then passed.
- Reinstall reused the existing OAuth login and returned `CLAUDE_OPENAI_OK` on `gpt-6-astra`, verification session `455741bb-d9f6-475b-bde0-dd798825e385`.
- Interactive session `898dcfae-da2e-4677-9ed7-9d561d48dace` performed a real fixture `Read` and returned `MODEL_PICKER_READ_OK`. The `/model` screen showed the curated lineup. Selecting `gpt-6-luna` with the session-only `s` action, then accepting the inspected cache warning, produced a real `gpt-6-luna` response `MODEL_SWITCH_OK`; the persisted transcript confirmed the model and global settings remained unchanged.
- Installed script and both skill copies match. `.zshrc`, user Claude settings and proxy configuration hashes were preserved; hooks and permission checks were not disabled.

## Context reduction, skill v0.2.0

The load-only A/B probe used Claude Code 2.1.310 and `gpt-6-astra`, the same prompt/effort/tools, a real `Skill(claude-openai)` call and no supporting-file reads. Both variants returned the same installation command.

| Skill-expanded context | Before | After |
|---|---:|---:|
| Characters | 7,737 | 2,864 |
| Input tokens attributable to skill | 1,684 | 658 |

Reduction: **60.93%**. Counts came from actual upstream non-streaming usage for the exact loaded text: control 324 tokens, original 2,008, revised 982. The fixed empty-wrapper control was subtracted; cache-read input would be included. This is the skill's loaded-text footprint, not a reduction of the entire CLI session or its billing. References are loaded only when needed and cost additional context if opened.

Live skill-driven reinstall succeeded without a new login: Claude invoked the skill and exactly one bundled `install` command, with no permission denials. Inner verification session `cfb62629-fe61-4d4e-a8c9-cbdac3a5000f` returned `CLAUDE_OPENAI_OK` on `gpt-6-astra`; outer session `935ee707-7319-43e5-b789-e4983a8e9e6c`. All 11 existing tests passed. Installer/test code hashes, `.zshrc` and Claude user settings remained unchanged.

A fresh interactive PTY run also passed: session `cee35626-3f26-4df0-8621-79b4d03da39d`, `gpt-6-astra`, one `Read` of the isolated fixture and exact final `CLAUDE_OPENAI_TOOL_OK`. The invocation selected `--permission-mode manual`, the transcript recorded `default`, and only the fixture read was explicitly allowed. No hooks or permission checks were disabled.

These are recorded checks, not ongoing health guarantees. For repeatable measurements, see [operations](operations.md#measuring-the-skills-context-footprint).

## Interpretation

These checks prove the tested local path, not all Claude features, unlimited usage, safety of arbitrary inherited plugins or compatibility with future releases. The inherited local Claude configuration used `bypassPermissions` in the interactive fixture; the wrapper did not add it. Existing user/project settings and plugins remain loaded. For a safe controlled probe, explicitly pass `--permission-mode manual` and the minimal allowed tools.

## Security review sources

Pinned upstream source: CLIProxyAPI v8.0.40, commit `d946c4fba6fc9a5cfbca1f3d85184d62ad2fb683`.

- Request capture guard: `internal/api/server.go` (commercial mode) and `internal/runtime/executor/helps/logging_helpers.go`.
- Environment/remote stores: `cmd/server/main.go`.
- OAuth callback bind: `internal/auth/codex/oauth_server.go`.
- Unconditional metadata fetches: `internal/misc/antigravity_version.go`, `internal/runtime/executor/helps/xai_version.go`.

Do not package credential directories, proxy config/local keys, shell backups, browser screenshots or private Claude transcripts. Deliver only the skill, installer, tests and this nonsecret verification reference.
