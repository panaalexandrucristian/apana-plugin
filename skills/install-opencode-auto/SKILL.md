---
name: install-opencode-auto
description: "Installs opencode-auto, the launcher that starts `opencode` so that its session is handed off to a new one in the same terminal window before the context reaches 200k tokens, and puts it on PATH through ~/.zshrc. Use this whenever the user wants to install, set up, reinstall, update, repair or check opencode-auto, or says things like \"instalează opencode-auto\", \"pune opencode-auto în zshrc\", \"handoff automat în OpenCode\", \"opencode-auto: command not found\", even if they never say \"skill\". For removing it use apana:uninstall-opencode-auto instead."
---

# install-opencode-auto

`opencode-auto` is the OpenCode counterpart of `claude-auto`. You start it instead of `opencode`. When the context of a session you opened in that window reaches the threshold (200000 tokens), the apana-auto plugin stops the session, writes a handoff note with the compact-handoff skill, creates a new session with the same agent, model and directory, tells it to read the note and continue, and the same window moves to it. Sessions of a plain `opencode` are never affected: the launcher sets a variable that only the TUI it starts sees, the TUI marks the sessions you open (`apana.auto` in the session metadata, with the settings), and the plugin acts on marked sessions only.

The plugin is its own folder, `opencode-auto/` in the apana repository, apart from the apana plugin (`opencode-plugin.js`): installing it adds no skills, commands or modes to OpenCode. A running subagent holds the handoff back (up to 30000 tokens above the threshold, `APANA_OPENCODE_AUTO_DEFER_EXTRA`); background subagents are not stopped by the handoff, so the new session is told their ids and asked to check them.

This skill puts it in place. The bundled `scripts/install.py` does the work, so run it instead of linking folders or editing `~/.zshrc` by hand. It is idempotent, and it saves the original rc once as `~/.zshrc.opencode-auto.bak`.

## Steps

1. Run the installer:

   ```bash
   python3 -I ${CLAUDE_SKILL_DIR}/scripts/install.py
   ```

   It does four things:
   - links `~/.config/opencode/plugins/apana-auto` (or `$XDG_CONFIG_HOME/opencode/plugins/`) to the `opencode-auto/` folder of the apana repository it belongs to. From a plugin cache copy (`~/.claude/plugins/cache/...`) it uses the marketplace clone instead, because a cache copy is replaced on every update. OpenCode finds a new or removed link within about 10 seconds, without a restart (measured);
   - copies the launcher to `~/.config/opencode/opencode-auto/` and adds one marked block to the zsh rc (`$ZDOTDIR/.zshrc`, else `~/.zshrc`) that puts that folder on PATH. A block from an older install is updated in place, so there is never a second one;
   - creates `~/.local/state/opencode/apana/auto/enabled` (or under `$XDG_STATE_HOME`): handoffs happen only while this file exists;
   - checks the result: `opencode` and `python3` are on PATH, `opencode` is 2.4.x (the supported line, verified on 2.4.2), the compact-handoff script exists.

   Useful flags: `--dry-run` shows what would change and writes nothing (use it when the user wants to see first); `--no-rc` skips the rc edit; `--rc FILE` edits another file; `--source DIR` points the link at another checkout.

2. Read the output. Lines start with `ok`, `info`, `warn` or `fail`; a `warn` makes the exit code 1 even though the install went through.
   - `opencode is not on PATH`: nothing to fix here; opencode-auto cannot start a session without it. Tell the user.
   - `the plugin was measured on 2.4.x only`: the hooks and events it uses may differ on that release. Say so; do not claim it works.
   - `is not a link; it was left alone`: something else sits where the link goes. Show the path and ask.
   - `markers ... unbalanced`: the rc has half a block, probably from a hand edit. The installer left the rc alone on purpose, because guessing which lines to keep could damage it. Show the user the two marker lines (`# >>> opencode-auto >>>` / `# <<< opencode-auto <<<`) and ask what to do.
   - `mentions opencode-auto outside the block`: a line the user wrote (an alias, an export). It is left alone, but it may shadow the PATH entry. Mention it.

3. Report in a few lines: what was new, updated or unchanged; that the rc got the block (and where the backup is); that a running OpenCode picks up the server part by itself but a TUI that is already open has no TUI part, so the user opens a new terminal (or runs `exec zsh`) and starts `opencode-auto` instead of `opencode`. Quote the threshold line the installer prints. Do not restart OpenCode or its service yourself.

## Things worth knowing

- **Do not print the rc file.** It often holds API keys and tokens. The installer never prints its contents, and you have no reason to either.
- **Why PATH and not an alias:** a PATH entry also works from scripts and non-interactive shells, and one marked block is easy to remove exactly.
- **The threshold** is `DEFAULTS.tokens` in `private/opencode-auto/server.mjs` (200000). It never goes above OpenCode's own compaction ceiling (window minus the larger of 15% and 16k) minus the margin, so that the handoff comes before OpenCode would compact. Before a tool call the plugin hands off earlier, `APANA_OPENCODE_AUTO_PRETOOL_MARGIN` (default 15000) tokens below the threshold: it refuses that call and starts the handoff. For one run: `APANA_OPENCODE_AUTO_TOKENS=120000 opencode-auto`. The settings are written on each session when the TUI marks it, so a new value reaches new and newly opened sessions, not sessions that are already marked.
- **`compaction.buffer` is not visible to the plugin** (there is no config in its context): the ceiling uses OpenCode's default buffer. If the user sets a larger buffer in their OpenCode config, OpenCode's compaction can come before the handoff.
- **Session title after handoff.** The destination inherits the source title and appends its position in the handoff chain, replacing any trailing numeric suffix ` (n)` (`X` → `X (2)` → `X (3)`). The title also appears in the first message sent to the destination. If the source title is missing or empty, the message has no title line so OpenCode can generate the destination title from it.
- **Skill reload after handoff.** By default the new session reloads no skills; `APANA_OPENCODE_AUTO_SKILLS=all` or a comma-separated list of exact names changes that. The one exception is `caveman`: if the closed session loaded it, the note asks the next session to reload it, because that mode stays on until the user ends it.
- **Edit the repository, not the installed copy.** The launcher's source is `assets/opencode-auto` here; every install overwrites the copy in `~/.config/opencode/opencode-auto/`. A change reaches the user only after a plugin release and `claude plugin update apana@apana-private` (and an update of the marketplace clone), then a new run of this skill.
- **Tests.** `npm run test:opencode-auto` (the plugin's unit tests and `scripts/test_setup.py`, on a throw-away HOME), `npm run test:opencode-runtime` (a real OpenCode server with a stub model, cost 0). `scripts/live_check.py` runs a real TUI in a pty against a private server and a stub model; it costs nothing and touches no real config, but it starts processes, so run it only when the user asks or after a change to the TUI part.
- Handoff notes go to `~/.local/share/opencode/apana/handoffs/auto/`, and `auto.log` to `~/.local/state/opencode/apana/auto/`.
