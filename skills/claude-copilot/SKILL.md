---
name: claude-copilot
description: Use when running Claude Code with a GitHub Copilot subscription, installing its standalone launcher, refreshing its model catalog or diagnosing its private proxy route.
version: 0.1.0
---

# Claude Code through GitHub Copilot

Use the bundled standalone helper. This is an unofficial subscription bridge, not a GitHub or Anthropic integration guarantee. Normal hooks, permissions and managed policies remain active; an incompatible policy stops the route rather than being bypassed.

## Install or update

1. Read [operations](references/operations.md) before installation: prerequisites, reviewed native artifact, licensing uncertainty, account consent and quota use. Obtain explicit permission for local native execution, device login and verification. A plugin update alone does not update the installed launcher.
2. Obtain the exact pinned archive from the release URL in operations, in a new empty download directory. Keep scripts outside it. Use the user's intended GitHub login, never import an existing token. With consent, run the bundled command, substituting the local archive path and login.

```sh
python3 -I "${CLAUDE_SKILL_DIR}/scripts/claude_copilot.py" install --archive /path/to/reviewed.zip --account GITHUB_LOGIN --accept-native-code
```

3. The user completes device authorization and confirms the account before credentials are promoted. Success requires the helper's completed verification, not merely an installed alias. On partial installation, report the failing phase and retained state; do not claim success or change providers.
4. Open a fresh zsh terminal and run `claude-copilot`. Installation writes only its owned launcher/state and managed `.zshrc` block. Existing sessions keep their old runtime; rerun installation after a plugin update to update later sessions.

## Run, inspect or verify

```sh
python3 -I "${CLAUDE_SKILL_DIR}/scripts/claude_copilot.py" models
python3 -I "${CLAUDE_SKILL_DIR}/scripts/claude_copilot.py" run --model copilot/gemini-4-argon
python3 -I "${CLAUDE_SKILL_DIR}/scripts/claude_copilot.py" verify
```

Every run refreshes the entire authenticated API catalog and reconciles the cold native registry before launching, including with an explicit model. Selection is CLI, then `CLAUDE_COPILOT_MODEL`, then the verified Gemini default above. Missing models, incomplete refreshes and unaccepted substitutions fail closed; there is no stale-cache or paid API-key fallback. Verify consumes subscription quota; obtain permission before running it.

Interactive calls use compatible installed `claude-auto`; print/help/subcommands pass through its existing contract. Without it, the launcher runs standalone. For auth failures, model changes, context limits, cleanup and the scope of measured evidence, read [operations](references/operations.md).

For removal, use the `uninstall-claude-copilot` skill: preview first, then explicit consent. Credentials, backups and dependencies are retained.
