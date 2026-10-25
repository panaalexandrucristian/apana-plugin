# Operations: load only when needed

## Troubleshooting

- **401/expired auth:** run `python3 <skill-dir>/scripts/claude_openai.py login`, finish the browser flow, then retry verification. Do not force a new login on every install.
- **No models:** `/v1/models` may return HTTP 200 before asynchronous OAuth registration completes. Wait for nonempty registration when credentials exist. Inspect `models`; listing is not proof of entitlement—verify inference. The wrapper prefers listed `gpt-6-astra`, otherwise the first available GPT model; choose an explicit listed model with `--model` or `CLAUDE_OPENAI_MODEL`.
- **Quota:** respect the indicated wait. For account denial, unavailable entitlement or browser challenges, report the blocker instead of circumventing it. Never fall back silently to a paid API key, remote relay, another account/provider or Anthropic model.
- **Repeated models in `/model`:** keep Opus/Fable/Sonnet/Haiku routing, but curate the display with the documented `modelPicker` setting in the launcher's session-only `--settings` file (Claude Code 2.1.242+). Use `replaceBuiltInOptions: true` and one row per exact `/v1/models` ID; put the selected model first. This replaces duplicate family/gateway rows without changing `availableModels`, global settings or helper routing. Claude always retains its separate Default row. Preserve image/review entries unless the user requests filtering. Never patch the Claude binary or remove routing aliases to tidy the menu. On older clients, explain the version requirement rather than silently upgrading. Inspect the real menu and runtime settings; verify all catalog IDs survive, and test both inference and a tool call. Cancel with Escape or use `s` for a session-only test switch—Enter saves to user settings. Catalog entries are remote routing choices, not locally loaded models or proof of inference access.
- **Warnings:** Claude can report an unrecognized GPT model and disable Claude.ai organization connectors under third-party authentication. A successful response envelope and tool execution determine whether the request worked. Claude dollar estimates and `firstParty` labels do not establish an OpenAI API charge.
- **Invisible browser:** inspect the actual native browser with `computer_use`; bring its window forward only when requested. A managed browser or successful `open` return does not prove user visibility. Stop pending login when the user pauses; wait for permission before reopening. Passwords/2FA stay in the provider UI or credential-vault flow, not chat.

## Runtime and preservation

The installer owns `~/.local/bin/claude-openai`, a marked `.zshrc` alias block and `~/.local/share/claude-openai`. It refuses foreign launcher/state files. Private state contains OAuth credentials, local proxy configuration, the installed script and shell backup. Credentials are separate from existing Hermes/Codex logins.

Each Claude session uses a random loopback port and local client key; the sidecar stops on normal exit. Main, helper and subagent defaults route to the selected GPT model. Hooks, project instructions and the existing permission mode remain loaded, including bypass mode if the user already selected it. Never add bypass flags or disable hooks merely to pass a test. Claude-specific cloud features need not work through this bridge.

Uninstall removes only owned launcher/alias content. It preserves credentials, state, shell backup, CLIProxyAPI and the skill. Explain this before removal. Credential deletion/revocation is a separate user decision. Reinstallation is supported.

## Shared claude-auto instructions

Reuse the installed `claude-auto` source rather than copying `VARIANT_RULE` or launching its wrapper. Resolve it from PATH, falling back to `~/.claude/claude-auto/claude-auto`. Import it with a non-main run name and call only its `passthrough(args)` and `rule_args(args)` helpers; its main/handoff loop is not started. The reviewed installed Python wrapper has no startup side effects outside its main guard. If the local wrapper's module-level behavior changes, review that import boundary before reusing it.

The current extra rule requires enumerating real token variants before writing text matchers/filters, then comparing old/new output on real data and explaining differences. Read the rule fresh on each launch so updates remain shared. Ordinary global/project `CLAUDE.md`, rules and hooks still load through Claude Code itself; do not duplicate them into the appended prompt.

Preserve the source's exceptions: `CLAUDE_AUTO_RULE=off`/`0`, explicit `--append-system-prompt` or `--append-system-prompt-file` (including `=` syntax), and passthrough invocations such as `-p`/`--print`, help/version and subcommands. Arguments after `--` are literal prompt text. Insert the shared instruction args before the user's args, preserving argv boundaries. The handoff loop, hooks, thresholds and `CLAUDE_AUTO_NEXT_ARGS` are not imported as behavior. If claude-auto is absent, keep the standalone OpenAI launcher usable; if a present source cannot provide the helpers, fail explicitly rather than silently ignoring instructions.

Verify both layers: unit tests for source reload, missing/incompatible source and exact subprocess argv; parity checks against the actual installed helpers; then an interactive Claude session whose live argv contains the exact rule once and whose response demonstrates it. Do not use a print-mode run as proof of interactive injection: print mode deliberately omits the extra rule, matching claude-auto.

## Offline test portability

Mock executable discovery as well as process/HTTP calls in sidecar unit tests. Run the suite once with CLIProxyAPI absent from PATH to catch accidental host dependencies; only the actual loopback lifecycle integration test may skip. Run it again with the real proxy available. Linux CI passing with a skip does not establish live OAuth or model inference.

## Proxy security: CLIProxyAPI 8.0.40

Consult this section before editing the proxy configuration or changing versions.

- Inference listener: `127.0.0.1`; random local client key. Keep directories 0700 and credential/config files 0600. Never publish credentials, keys, shell backups, full request logs or private transcripts.
- `server.commercial-mode: true` disables request capture middleware. `request-log: false` alone still captures error payloads. Keep dashboard, remote management, discovery, plugins and profiling disabled.
- Start with `-local-model` and no explicit catalog URLs for embedded catalogs. Do not start the global Homebrew proxy service or install unrelated updates.
- Sanitize the proxy subprocess environment for uppercase/lowercase `HOME_JWT`, `PGSTORE_*`, `GITSTORE_*`, `OBJECTSTORE_*`, `MANAGEMENT_PASSWORD` and `DEPLOY`; these can select remote credential/configuration storage or expose management. Keep its working directory private: startup loads a local `.env`. Do not globally strip Claude's configuration/environment.
- Do not claim OpenAI-only networking: this version fetches Antigravity and Grok version metadata. Reviewed paths perform metadata GETs, not prompt/token uploads.
- Browser OAuth temporarily binds all interfaces on port 1455 despite inference being loopback-only. Use a trusted network. Do not change callback ports as a workaround: the OAuth redirect stays hardcoded to 1455.

## Verification details

Use the bundled unit/integration tests plus actual `verify`, shell alias discovery and an interactive tool call. Unit mock fixtures and a healthy HTTP listener are not real model success. Inspect the JSON envelope even if exit status is zero: require `subtype=success`, no error, GPT model usage and `CLAUDE_OPENAI_OK`. `verification.json` records the last check, not current health. A request must succeed through the intended OAuth route; never synthesize a result.

[Recorded integration results](verification.md) describe prior checks and limits. For a controlled probe, select `--permission-mode manual` and allow only necessary tools. Inspect trust/permission prompts rather than blindly sending Enter.

## Measuring the skill's context footprint

Keep routine instructions in `SKILL.md`; move failure-specific detail here without weakening the bundled installer. Compare actual Skill-expanded text from fresh Claude sessions using identical prompts, model, effort and tools. Require a real `Skill` call and the same usable installation command before/after. Confirm routine installation does not automatically read scripts/references.

For token counts, send each expanded text through the same upstream model with identical fixed wrappers and an empty-wrapper control; subtract that control and include cache-read input tokens. Record usage, model and boundaries. Do not treat characters, dollar estimates, cached-only counts or early streaming usage as exact skill tokens. CLIProxyAPI 8.0.40 falls back to `cl100k_base` for unrecognized model names such as `gpt-6-astra`; its local count endpoint is not authoritative upstream tokenization. The main-file reduction is not a promise to halve total session usage, and opening these references adds their context back.

After edits, keep the installed Claude and Hermes copies identical, check installer/test hashes, rerun the existing suite and a real skill-driven reinstall plus interactive tool request. Package only the skill files, never private benchmark transcripts or state.

## Sources

- https://github.com/router-for-me/CLIProxyAPI
- https://help.router-for.me/configuration/provider/codex
- https://developers.openai.com/codex/auth
- https://code.claude.com/docs/en/settings-reference#modelpicker
