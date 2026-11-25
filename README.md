# apana

A Claude Code plugin (with an OpenCode 2.3.0 side, see [OpenCode](#opencode)) with commands, skills and hooks that do not need the jev plugin (only `jev-decision-loop` calls Jev, over its direct API with the user's own key). Split out of `jev-mcp-private` (the `jev` plugin) on 2026-10-19.

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
| `apana:android-ui-step` | Taps a label on an Android emulator and prints a digest of the new screen. |
| `apana:scope` | Investigate a coding task, ask about unclear intent, then gate edits to exact paths after explicit user approval. |
| `apana:review-diff` | Ask what to review (uncommitted changes, a commit, a PR) when given no argument; a fresh reviewer subagent, without the conversation that produced the code, challenges every changed hunk and every new class of the diff (why, necessary, aligned with the project standard, in the right place, optimal) in one report; the main agent applies its exact edits only on the state the reviewer saw, then has a fresh reviewer check the result in a full pass or a targeted confirmation. A bundled read-only script (`diff-target.mjs`) lists the files and hunks of the target, takes and verifies a snapshot of the reviewed state, and checks a batch of edits against it before any write. |
| `apana:review-plan` | Ask what plan to review when given no argument; four subagents first (one finds written project standards, one looks up official best practices, one finds the most recently introduced comparable implementations with `git log`, one maps the application's layers), then a fresh reviewer subagent without the planning conversation checks each proposal across the layers it affects and challenges every step of the plan, every new class or file it adds and what it leaves out (why, necessary, aligned with the project standard, holds, in the right place, optimal); the plan text, never the code, is fixed and the pass repeated. |
| `apana:pr-convention-check` | Read-only check of a diff against the conventions of the repository: splits it into features and technical decisions, compares each decision with the 3-4 most recent comparable commits of a reference branch you name, and classifies deviations as justified, to fix or to decide. |
| `apana:assess-complexity` | Before a plan or code change is implemented: rates its size and blast radius and, separately, its Cynefin domain, then recommends the process (recon, steps, gates) and the model and effort per phase, with the cost at API rate. |
| `apana:improve-skill` | Digests the Claude Code transcripts of this laptop into per-skill usage records (all skills, not only apana), merges digests from several laptops and checks evidence-backed reports that propose changes to a skill. Local files by default; publishing to a private repository is opt-in. |
| `apana:update-sessions` | Updates the apana plugin on disk, then types `/reload-plugins` at the empty prompt of every idle Claude Code session in iTerm2 and checks each `Reloaded:` line. Started by hand only; other terminals are skipped with the command to type. |
| `apana:uninstall-claude-scope` | Remove an old standalone launcher and its marked PATH block without removing reports or unrelated files. |
| `apana:jev-decision-loop` | A mode, switched on by the user, in which Jev picks every next step of the session from 2-5 options the model writes. |
| `apana:install-claude-auto`, `apana:uninstall-claude-auto` | Put the `claude-auto` wrapper (a fresh session at a token threshold) on PATH, or remove it. |
| `apana:install-opencode-auto`, `apana:uninstall-opencode-auto` | Put the `opencode-auto` launcher (an OpenCode session handed off to a new one at a token threshold, in the same window) and its plugin link in place, or remove them. They run in OpenCode and in Claude Code. |
| `apana:claude-openai` | Install or verify a separate launcher using an OpenAI subscription through local CLIProxyAPI and Codex OAuth. |
| `apana:uninstall-claude-openai` | Preview and remove the owned launcher and shell alias, keeping credentials, state and shared dependencies. |
| `apana:claude-copilot` | Install or verify a separate GitHub Copilot subscription launcher with fresh account models and a fail-closed model guard. |
| `apana:uninstall-claude-copilot` | Preview and remove only its owned launcher/alias, retaining credentials, state, native plugin and dependencies. |
| `apana:harness2` | Install and run pinned Harness² on Apple Silicon from OpenCode or Claude Code; OpenCode is the only internal agent. |

OpenCode: see [OpenCode](#opencode) below. The skills that manage Claude Code itself (the launchers and their uninstallers, `install-claude-auto`, `improve-skill`, `update-sessions`) are Claude Code only.

## OpenCode

Verified on OpenCode **2.3.0** (the V2 plugin API; V1 is not supported). Either clone this repository and list the folder (a folder, not `opencode-plugin.js`) in `plugins` of `opencode.json` or `opencode.jsonc`, or use OpenCode's own Git install with your own Git credentials (`opencode plugin add github:panaalexandrucristian/apana-plugin`; the tests of this repository load the folder and an extracted `npm pack`, not a Git install). Restart OpenCode (or update the package) after a change: the text of the skills and commands is read when the plugin is set up, not watched.

**What runs there.** `android-ui-step`, `assess-complexity`, `class-graph`, `code-rag`, `code-rag-setup`, `compact-handoff`, `compact-session`, `explica-clar`, `harness2`, `install-opencode-auto`, `jev-decision-loop`, `logic-test-debug`, `pr-convention-check`, `review-diff`, `review-plan`, `scope`, `uninstall-opencode-auto`, `variant-check`, and the command `explica-optiuni`, each as `/apana:<name> <arguments>` (the arguments reach the skill untouched as the text after the command name). `compact-session` is explicit-only and is not offered to the model. The text of each skill gets a short note that maps Claude's tool names to OpenCode's; `allowed-tools` and `hooks` in a skill's frontmatter are not applied, and OpenCode's own permissions decide what runs (nothing here grants or lifts one).

**The modes.** They are switched on by the user's command, from the admitted message, not from the text of a prompt that may never be admitted: `/apana:scope <task>` (then `/apana:scope approve <nonce>`), `/apana:jev-decision-loop` (or `@jev-decision-loop`; a skill load by the model also starts it) and the bare `/apana:class-graph`. Scope allows reads and the proposal, then exactly the approved files and test commands; every other tool, Code Mode (`execute`), MCP tools and subagents included, is refused; a shell command must run in the project directory in the foreground. Jev needs one `GO` per tool call, refuses Code Mode, checks the end of a turn once, and `jev.mjs --off` ends it. **Scope and Jev cannot be on in the same session** (the second is refused and nothing changes; scope has no off switch, use another session). A fork does not inherit a mode, and a session moved to another directory is refused by its scope until a new task. Their state is kept under `$XDG_STATE_HOME/opencode/apana/`, apart from Claude Code's. These are tool gates, not an operating-system sandbox; tools that the model provider runs itself are outside them.

**Compaction.** `/apana:compact-session` asks OpenCode for a compaction and supplies the same verified, deterministic transcript that Claude Code gets, in the same session, with no model summary and no recent tail beside it. If the replacement would not be smaller, or anything fails, the context is unchanged and no summarizer runs. OpenCode 2.3.0 has no result for a verified no-op, so it records such a run as a failed compaction; the report the model receives with the next prompt says which of success, no-op and failure it was, and a success is reported only when OpenCode recorded the replacement. Archives go to `~/.claude/handoffs/` as for Claude Code; do not delete them. Media and encrypted provider checkpoints are not supported and make the compaction fail closed.

**Configuration** is by environment only (`APANA_LOGIC_TEST_DEBUG`, `APANA_CLASS_GRAPH_NUDGE`, `APANA_SCOPE_STATE_DIR`, `APANA_CLASS_GRAPH_STATE_DIR`, `JEV_GATE_DIR`); plugin `userConfig` is a Claude Code feature. If the larger integration cannot be set up, what it had registered is undone, one warning is printed and `logic-test-debug` keeps working on its own. `logic-test-debug` keeps its in-memory state per session, so a reload in the middle of a turn can drop its directive for that turn.

### Harness² on Apple Silicon

On each Mac, load Apana using the [OpenCode setup above](#opencode) or an Apana plugin version containing this skill in Claude Code. For local development, Claude Code can load the checkout in an interactive session with `claude --plugin-dir /absolute/path/to/apana-plugin`. In either host, invoke `/apana:harness2` and ask to check, install, or run the demo. Prerequisites: native macOS arm64, `python3`, Git and `uv`. The installer keeps the pinned checkout and Python environment under `~/.local/share/apana/harness2`; it does not change the host configuration.

The demo needs no model credentials. [JobBench on macOS](skills/harness2/reference/jobbench.md) is experimental and uses the OpenCode CLI already installed on the Mac for execution, improvement, and rubric judging. You choose the models and approve model calls separately. The skill does not install a second OpenCode or run Codex.

### Same-session compaction

In an interactive session with Apana's native hook module loaded:

    /apana:compact-session

The skill requests compaction once through its frontmatter Stop hook. The native bridge archives the active API snapshot, verifies a deterministic compact transcript, then replaces the context without `/clear`, restart, a new session or a model-written summary. Recoverable tool content stays in local blobs under `~/.claude/handoffs/`; do not delete those archives while a later context may reference them. Ordinary prose is not summarized. The existing sanitizer remains active and thinking is archive-only, so text verification is not a byte-for-byte API-snapshot guarantee. Unsupported content fails closed.

If the verified replacement would not shrink the prepared transcript, the current context stays in place and the result reports a no-op with measured character counts. The latest outcome also reaches the model with the next accepted prompt. This does not enable automatic compaction on later turns or change `compact-handoff`.

Requires a build supporting native function hooks and custom `session.compact` replacements. Tested runtime: `2.1.311`; the native API is unavailable in headless (`-p`/SDK) runs on that build. An unavailable bridge or API leaves context unchanged, with no fallback to the built-in summarizer. Verification details and limits are in `private/compact-session/VERIFICATION.md`.

### Automatic handoff in OpenCode (`opencode-auto`)

`opencode-auto` is the OpenCode counterpart of `claude-auto`. Run `/apana:install-opencode-auto` once, open a new terminal and start `opencode-auto` instead of `opencode`. When the context of a session opened in that window reaches the threshold (200000 tokens by default, never above OpenCode's own compaction ceiling minus a 15000 margin), the plugin stops the session, writes a handoff note with `compact-handoff`, creates a new session with the same agent, model and directory that is told to read the note and continue, and the same window moves to it. Before a tool call it hands off 15000 tokens earlier and refuses that call. A running subagent holds the handoff back (up to 30000 tokens above the threshold); a background subagent is not stopped, so the new session is given its id.

It is a plugin folder of its own, `opencode-auto/` (`server.js` and `tui.js`, linked into `~/.config/opencode/plugins/`), apart from the apana plugin: installing it adds no skills, commands or modes to OpenCode. A plain `opencode` is never affected: the launcher sets a variable that only the TUI it starts sees, the TUI marks the sessions you open (`apana.auto` in the session metadata), and the server part acts on marked sessions and only while `~/.local/state/opencode/apana/auto/enabled` exists. `/apana:uninstall-opencode-auto` removes the link, the launcher, the PATH block and that file (handoff notes stay unless `--purge-notes` is given). Settings: `APANA_OPENCODE_AUTO_TOKENS`, `_PRETOOL_MARGIN`, `_DEFER_EXTRA`, `_COOLDOWN`, `_MAX`, `_SKILLS`, `_DIR`, documented at the top of the launcher.

**Limits.** The plugin cannot see OpenCode's `compaction.buffer` setting, so the ceiling uses the default buffer; a larger buffer lets OpenCode compact before the handoff. OpenCode starts its own compaction at the next turn, so a handoff at the end of a step comes first. Measurements and the design log are in `PRIVATE.md`, section «opencode-auto».

### OpenAI subscription launcher

On macOS, invoke `/apana:claude-openai` and ask it to install. Requires zsh, Python 3, Claude Code 2.1.242+ and CLIProxyAPI (`brew install cliproxyapi`). The bundled installer performs a separate OpenAI browser login when needed and verifies a real response. Updating this plugin alone does not install or update the launcher; rerun the skill's installer, then start a new `claude-openai` session.

This is an unofficial subscription bridge, not a paid-API-key setup. It keeps normal `claude`, global/project rules, hooks and permissions unchanged. `/model` lists distinct gateway IDs once plus Claude's Default row. The launcher sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000` only for its child processes and session-local settings; this fixed client limit does not establish the provider's capacity for every selectable model. If `claude-auto` is installed, interactive sessions run under its instruction policy and automatic handoff loop, including opt-outs; print mode starts the client directly. Credentials stay outside the plugin. Subscription limits and compatibility constraints still apply; see the skill's operations reference.

With the updated wrapper, `--resume` and other session selectors open the requested session without a cache warm-up; a later handoff starts a fresh session. Automatic handoff notes no longer request skill reloads by default. `CLAUDE_AUTO_SKILLS=all` retains the previous behavior; a comma-separated list selects exact skill names loaded by the old session. Unmatched names are omitted and logged. The `caveman` skill is always reloaded when the old session called it. This applies to both `claude-auto` and supervised `claude-openai`, not manual handoff generation. After updating the plugin, rerun `/apana:install-claude-auto` to update the wrapper and `/apana:claude-openai` to update the subscription launcher; already-running sessions are not retrofitted.

To remove the launcher and managed shell alias, invoke `/apana:uninstall-claude-openai`. It previews first and uses the existing bundled uninstaller. OAuth credentials, the state folder and backup, CLIProxyAPI, `claude-auto` and the plugin remain installed; this is not a full data purge. It does not stop running sessions. Existing shells may retain the alias until a new terminal is opened.

### GitHub Copilot subscription launcher

Invoke `/apana:claude-copilot` to install on macOS arm64 with the reviewed CLIProxyAPI/native plugin combination. Native execution, device login and quota-consuming verification require explicit consent. The native binary is not bundled or automatically downloaded; licensing/attestation limits and the exact archive pin are in [operations](skills/claude-copilot/references/operations.md).

Each `claude-copilot` launch fetches the whole authenticated Copilot API catalog, reconciles a cold registry and selects CLI `--model`, then `CLAUDE_COPILOT_MODEL`, then `copilot/gemini-4-argon`. Missing models, failed refreshes and unaccepted substitutions stop without stale-cache, another-model or paid-key fallback. Explicit switching keeps normal policy/confirmation; the guard requires matching hooks before forwarding. Context/output ceilings are calculated from all eligible models, so small legacy models can reduce the entire session's allowance. Catalog metadata is not a per-model live capability guarantee.

Normal hooks/permissions remain active. Interactive sessions use compatible installed `claude-auto`; other modes pass through, and an absent wrapper permits standalone use. Updating Apana does not update the installed copy: rerun the installer and start a new session. Running sessions are unchanged. `/apana:uninstall-claude-copilot` previews before explicit removal, retains credentials/backup/native plugin/dependencies, and does not stop sessions or edit global settings.

### Hook-free text launcher

After updating the plugin and rerunning `/apana:install-claude-auto`, `claude-auto --managed` explicitly selects a separate text interface. It adds no launcher hooks, replaces the native terminal UI, and denies actions that require interactive approval. Existing settings and organizational restrictions still apply; use it only where the organization permits this launcher.

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

`opencode-plugin.js` is the OpenCode entry: it sets `logic-test-debug` up on its own and then the rest of the OpenCode integration (see [OpenCode](#opencode)); Claude Code does not read it.

## Configuration

Claude Code 2.1.271 or newer shows two Apana options in `/config` and in the plugin's **Configure** panel:

- **Logic test and debug guidance:** `on` (default) or `off`.
- **Class graph reminders:** `both` (default), `nudge-only`, `reminder-only` or `off`.

The existing environment variables remain compatible and take precedence when explicitly set: `APANA_LOGIC_TEST_DEBUG` and `APANA_CLASS_GRAPH_NUDGE` (`on`/`a`/`b`/`off`). OpenCode continues to use the environment variables because plugin `userConfig` is a Claude Code feature.

## Tests

    npm test                  # node suite: hooks, skills, self tests, end to end
    npm run test:claude-auto  # offline Python suites of claude-auto and its installer
    npm run test:opencode-auto # offline: the opencode-auto plugin parts, and its installer, uninstaller and launcher (a fake `opencode`, a temporary HOME)
    npm run test:claude-scope # Node scope gates and Python legacy-uninstaller tests
    npm run test:claude-openai # offline bridge suite; proxy lifecycle skips if CLIProxyAPI is absent
    npm run test:claude-copilot # offline Copilot fixtures; no native download/login/inference
    claude plugin test .      # native compact-session hook tests on a supporting build
    npm run test:opencode-runtime # the plugin on a real OpenCode 2.3.0 (private server, stand-in provider, no credentials); skipped by npm test

Node 22 and Python 3 are needed; `class-graph` and `find-usages` also need ripgrep (`rg`). `AGENTS.md` says how to work in this repository.
