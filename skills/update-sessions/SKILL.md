---
name: update-sessions
description: "Updates the apana plugin to the newest marketplace version and reloads it in every open Claude Code session on this Mac: runs `claude plugin marketplace update` and `claude plugin update`, finds the idle sessions in iTerm2, types `/reload-plugins` at their empty prompts and confirms each `Reloaded:` line. Use when the user runs /apana:update-sessions or asks to bring all open sessions to the latest apana version."
argument-hint: [dry-run]
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/update-sessions.mjs *)
---

# update-sessions

One command updates apana on disk and reloads it in every open session. Needs node 22, macOS and iTerm2. Answer in the user's language.

Run it as one plain command with literal paths. Add `--dry-run` when `$ARGUMENTS` is `dry-run` or the user wants to look first:

    node ${CLAUDE_SKILL_DIR}/scripts/update-sessions.mjs --self ${CLAUDE_SESSION_ID}

Relay the table as it is. For every row that is not `reloaded`, `queued` or `would ...`, give the reason and the exact command to type in that session, for example: "stoiximan-e5 has text in its prompt: send or clear it, then type /reload-plugins".

- Exit 0: every session reloaded or queued. A `warning` row reloaded with a message: show the message.
- Exit 3: some sessions were not reloaded. Relay them and stop; the owner decides. `skipped` = nothing was typed. `typed, not confirmed` = the session got the command but no `Reloaded:` line appeared in time, so say it may still be running. `held` = an MCP change was held back to protect the prompt cache; offer `/reload-plugins --force` in that session, the owner decides.
- Exit 4: the update on disk failed. Read the message and report which command failed.
- Exit 5: iTerm2 cannot be read (not running, or macOS Automation not allowed). Relay the message.
- Exit 2: wrong arguments; relay the usage line.

A `queued` row is this session: its `/reload-plugins` runs right after this reply, so say so in one line.
