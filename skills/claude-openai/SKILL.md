---
name: claude-openai
description: "Use when running Claude Code with an OpenAI subscription."
version: 0.3.0
author: Hermes Agent
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [claude-code, openai, codex, oauth, installer]
    related_skills: [claude-code]
---

# Claude Code → OpenAI subscription

Install/verify/remove `claude-openai`: real Claude Code through CLIProxyAPI and separate Codex OAuth. Not paid API billing or normal Anthropic/local-model setup. Explain this is an unofficial bridge subject to subscription limits.

## Install

Require macOS/zsh, Python 3 and Claude Code 2.1.242+. Check `claude --version` and `cliproxyapi --help` (tested proxy: 8.0.40). If the proxy is missing, run `brew install cliproxyapi`; if Claude is missing, use its official installation docs. No unrelated upgrades or global proxy service.

Resolve `<skill-dir>` from `${CLAUDE_SKILL_DIR}` (Claude) or `skill_view.skill_dir` (Hermes). Use the terminal/Bash tool, with a tracked PTY for login:

```sh
python3 <skill-dir>/scripts/claude_openai.py install
```

Run the bundled installer, not a rewritten equivalent. It creates the private state under `~/.local/share/claude-openai`, owned launcher/`.zshrc` alias, browser login when needed, and a live verification. Copying the skill alone does not install anything. Existing `claude`, hooks, project rules and permission mode remain unchanged; existing bridge credentials are reused. When `claude-auto` is installed, an interactive launch runs under it: its instruction rules, opt-outs and context handoff apply, and the new session keeps this model and routing. Print mode, help and subcommands start `claude` directly.

The launcher sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000` in its child environment and session-local settings only. Separately started `claude` sessions, the parent shell and global settings stay unchanged. This fixed client limit also applies to helper models and survives supervised handoffs; it is not per-model capacity discovery or proof that the provider accepts a full window. Re-run this installer after updating the plugin to refresh an existing launcher while retaining credentials and proxy configuration.

Passwords/2FA stay in the provider UI (use the vault for browser automation). Pause for user consent; never copy existing Hermes/Codex tokens, expose credentials, bypass account controls or silently switch account, provider, paid API key or relay. If paused, stop pending login and wait before reopening the browser. OAuth temporarily listens on port 1455 beyond loopback; use a trusted network.

## Commands and verification

In a new terminal: `claude-openai`. Choose a listed GPT model with `--model` or `CLAUDE_OPENAI_MODEL`.

Run `python3 <skill-dir>/scripts/claude_openai.py` with:
- `models`: list models; `login`: repeat OAuth; `verify`: real request.
- For removal, use `apana:uninstall-claude-openai`: it runs `uninstall --dry-run`, then `uninstall` only when requested. Removes owned launcher/alias; retains credentials, state, backup, proxy and skill.

For installation/testing:
1. Run `python3 -m unittest -v test_claude_openai.py` in `<skill-dir>/scripts`.
2. Confirm `zsh -ic 'type claude-openai'` and successful `verify`: real session ID, GPT model and `CLAUDE_OPENAI_OK`. Unit fixtures/model listings are not live success.
3. Test an interactive tool call; inspect prompts individually. Never disable hooks/permissions to pass. Report verified results and blockers.

Read [operations](references/operations.md) **only for failures, proxy changes or detailed security questions**; do not read scripts/references for routine installation unless needed. It covers model readiness, auth/quota errors, browser visibility, logging, environment isolation and network limits. [Verification](references/verification.md) records earlier tests, not current health.
