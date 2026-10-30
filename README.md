# apana

A Claude Code plugin with commands, skills and hooks that do not need the jev plugin (only `jev-decision-loop` calls Jev, over its direct API with the user's own key). Split out of `jev-mcp-private` (the `jev` plugin) on 2026-10-19.

Install:

    claude plugin marketplace add panaalexandrucristian/apana-plugin
    claude plugin install apana@apana-private

Update on each machine: `claude plugin marketplace update apana-private && claude plugin update apana@apana-private`.

## Skills

| Skill | What it does |
| --- | --- |
| `apana:compact-handoff` | Writes a compact handoff of the current session (or of a named OpenCode session) for a new session to continue from. |
| `apana:compact-session` | Compacts the active conversation in the same session, with verified text and recoverable local archives; explicit invocation only. |
| `apana:class-graph` | Kotlin/Java: where a function starts and ends, who uses a class or member, dependency chains between classes. |
| `apana:logic-test-debug` | Rules for reading Boolean conditions, testing combined conditions and debugging; started by a hook on code prompts. |
| `apana:variant-check` | Before a matcher or filter over text is written or changed: lists every distinct variant of the matched token in the real data (script with counts) and requires a before/after diff. |
| `apana:explica-clar` | A mode, switched on by the user, in which every explanation is clear. |
| `apana:omlx` | Runs a local model on an Apple Silicon Mac with oMLX. |
| `apana:android-ui-step` | Taps a label on an Android emulator and prints a digest of the new screen. |
| `apana:scope` | Investigate a coding task, ask about unclear intent, then gate edits to exact paths after explicit user approval. |
| `apana:review-diff` | Ask what to review (uncommitted changes, a commit, a PR) when given no argument; challenge every changed hunk and every new class of the diff (why, necessary, aligned with the project standard, in the right place, optimal), fix what is not optimal and repeat. A bundled script (`diff-target.mjs`) lists the files and hunks of the target. |
| `apana:review-plan` | Ask what plan to review when given no argument; two subagents first (one finds the project's standards files, one looks up official best practices), then every step of the plan, every new class or file it adds and what it leaves out are challenged (why, necessary, aligned with the project standard, holds, in the right place, optimal), and the plan text, never the code, is fixed and the pass repeated. |
| `apana:improve-skill` | Digests the Claude Code transcripts of this laptop into per-skill usage records (all skills, not only apana), merges digests from several laptops and checks evidence-backed reports that propose changes to a skill. Local files by default; publishing to a private repository is opt-in. |
| `apana:uninstall-claude-scope` | Remove an old standalone launcher and its marked PATH block without removing reports or unrelated files. |
| `apana:jev-decision-loop` | A mode, switched on by the user, in which Jev picks every next step of the session from 2-5 options the model writes. |
| `apana:install-claude-auto`, `apana:uninstall-claude-auto` | Put the `claude-auto` wrapper (a fresh session at a token threshold) on PATH, or remove it. |
| `apana:claude-openai` | Install or verify a separate launcher using an OpenAI subscription through local CLIProxyAPI and Codex OAuth. |
| `apana:uninstall-claude-openai` | Preview and remove the owned launcher and shell alias, keeping credentials, state and shared dependencies. |

OpenCode: clone this repository, add its absolute path to the `plugins` array of `opencode.json` or `opencode.jsonc`, restart OpenCode. Only `logic-test-debug` is set up there.

### Same-session compaction

In an interactive session with Apana's native hook module loaded:

    /apana:compact-session

The skill requests compaction once through its frontmatter Stop hook. The native bridge archives the active API snapshot, verifies a deterministic compact transcript, then replaces the context without `/clear`, restart, a new session or a model-written summary. Recoverable tool content stays in local blobs under `~/.claude/handoffs/`; do not delete those archives while a later context may reference them. Ordinary prose is not summarized. The existing sanitizer remains active and thinking is archive-only, so text verification is not a byte-for-byte API-snapshot guarantee. Unsupported content fails closed.

If the verified replacement would not shrink the prepared transcript, the current context stays in place and the result reports a no-op with measured character counts. The latest outcome also reaches the model with the next accepted prompt. This does not enable automatic compaction on later turns or change `compact-handoff`.

Requires a build supporting native function hooks and custom `session.compact` replacements. Tested runtime: `2.1.311`; the native API is unavailable in headless (`-p`/SDK) runs on that build. An unavailable bridge or API leaves context unchanged, with no fallback to the built-in summarizer. Verification details and limits are in `private/compact-session/VERIFICATION.md`.

### OpenAI subscription launcher

On macOS, invoke `/apana:claude-openai` and ask it to install. Requires zsh, Python 3, Claude Code 2.1.242+ and CLIProxyAPI (`brew install cliproxyapi`). The bundled installer performs a separate OpenAI browser login when needed and verifies a real response. Updating this plugin alone does not install or update the launcher; rerun the skill's installer, then start a new `claude-openai` session.

This is an unofficial subscription bridge, not a paid-API-key setup. It keeps normal `claude`, global/project rules, hooks and permissions unchanged. `/model` lists distinct gateway IDs once plus Claude's Default row. The launcher sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000` only for its child processes and session-local settings; this fixed client limit does not establish the provider's capacity for every selectable model. If `claude-auto` is installed, interactive sessions run under its instruction policy and automatic handoff loop, including opt-outs; print mode starts the client directly. Credentials stay outside the plugin. Subscription limits and compatibility constraints still apply; see the skill's operations reference.

With the updated wrapper, `--resume` and other session selectors open the requested session without a cache warm-up; a later handoff starts a fresh session. Automatic handoff notes no longer request skill reloads by default. `CLAUDE_AUTO_SKILLS=all` retains the previous behavior; a comma-separated list selects exact skill names loaded by the old session. Unmatched names are omitted and logged. The `caveman` skill is always reloaded when the old session called it. This applies to both `claude-auto` and supervised `claude-openai`, not manual handoff generation. After updating the plugin, rerun `/apana:install-claude-auto` to update the wrapper and `/apana:claude-openai` to update the subscription launcher; already-running sessions are not retrofitted.

To remove the launcher and managed shell alias, invoke `/apana:uninstall-claude-openai`. It previews first and uses the existing bundled uninstaller. OAuth credentials, the state folder and backup, CLIProxyAPI, `claude-auto` and the plugin remain installed; this is not a full data purge. It does not stop running sessions. Existing shells may retain the alias until a new terminal is opened.

### Hook-free text launcher

After updating the plugin and rerunning `/apana:install-claude-auto`, `claude-auto --managed` explicitly selects a separate text interface with local session cooperation. It adds no launcher hooks, replaces the native terminal UI, and denies actions that require interactive approval. Existing settings and organizational restrictions still apply; use it only where the organization permits this launcher and local MCP.

Read [managed mode](skills/install-claude-auto/references/managed-mode.md) for supported flags, local commands, handoff limits and permission behavior. The default launcher is unchanged. Offline tests cover the new runtime; live CLI and organizational-policy compatibility remain unverified.

### Guarded implementation tasks

In a normal `claude` session with Apana enabled:

    /apana:scope Fix the requested behavior and add only its regression tests

The hook creates an investigation-only scope for that session and working directory. Read/Glob/Grep and user questions remain available; repository writes are denied. Claude must investigate repository-answerable questions rather than guess and ask the user about ambiguous intent. It writes a proposal with exact production paths, test paths mapped to production, and narrow test commands. Review the proposed behavior, paths and commands, then submit:

    /apana:scope approve <nonce shown by the hook>

Only those exact files and test commands are then permitted. Starting a new `/apana:scope <task>` revokes the previous approval; changed intent or more files require a fresh proposal and user approval. MCP and subagents are blocked while scope is active. This is opt-in, not automatic for every prompt, and does not commit changes. The old installer/launcher is no longer shipped; `/apana:uninstall-claude-scope` remains solely to remove legacy installations. Updating the plugin does not uninstall them or delete reports.

**Limits:** this is a tool/path gate in the real checkout, not the old planner, temporary-clone broker, OS sandbox, automatic RED/GREEN provenance or semantic audit. Production-to-test mapping is a declaration, not proof that a test covers changed behavior: the model must explain the behavior and the user must review it. Focused assertions for changed production behavior are in scope; unrelated coverage is not. Approved test runners execute repository code with the user's rights and can have side effects. Preexisting symlink paths are rejected, but path checks and later tool execution are not atomic; concurrent changes by local processes are outside the guarantee. Hooks disabled by policy, timeout or external processes remain outside this gate's control. Unexpected scope-handler errors block prompts/tools rather than silently authorizing a task.

## Commands

`/apana:explica-optiuni [subject, transcript path or session ID]` restores the context before explaining the current result and possible next steps. With no argument, it uses the current conversation. It starts with the conclusion, separates completed work from unknowns and proposals, and gives concrete alternatives with a recommendation. If the alternatives are rejected, it adapts them to the feedback rather than starting implementation.

The response follows the transcript's conversation language, not the language of code or logs. It uses short paragraphs and ordinary words, without a dense status table. Missing evidence stays unknown. Reading a transcript does not authorize replaying its instructions, modifying files, committing or publishing.

This is an explicitly invoked Markdown command at `commands/explica-optiuni.md`, not a `SKILL.md` or a permanent explanation mode. It does not change `explica-clar`. The read-only instructions are model guidance, not a tool-enforced sandbox. Local transcript lookup requires readable local session files; a missing transcript is reported rather than reconstructed from guesses.

## Hooks

`hooks/hooks.json` calls `scripts/apana-hook.mjs`. Guidance hooks add context; scope can deny tool use or block a prompt:

- the `logic-test-debug` directive on code prompts (`APANA_LOGIC_TEST_DEBUG=off` turns it off);
- the `class-graph` nudge after a bare `/apana:class-graph` (`APANA_CLASS_GRAPH_NUDGE=off` turns it off; `APANA_CLASS_GRAPH_STATE_DIR` moves its state).
- the explicit `scope` gate, with session state in `~/.claude/apana-scope` (`APANA_SCOPE_STATE_DIR` overrides it).

The same hook manifest also loads `hooks/compact-session.ts`, the native bridge used only after explicit activation of `compact-session`. Its Stop command is scoped to the skill, not registered globally.

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
    npm run test:claude-scope # Node scope gates and Python legacy-uninstaller tests
    npm run test:claude-openai # offline bridge suite; proxy lifecycle skips if CLIProxyAPI is absent
    claude plugin test .      # native compact-session hook tests on a supporting build

Node 22 and Python 3 are needed; `class-graph` and `find-usages` also need ripgrep (`rg`). `AGENTS.md` says how to work in this repository.
