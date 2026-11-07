# Hook-free text mode

Use `claude-auto --managed [supported flags] -- "initial prompt"` only when the user chooses the separate text interface. The default `claude-auto` terminal interface is unchanged. Installation alone does not enable managed mode.

## Before use

The organization must permit this external launcher. This mode is not an administrator approval or a way to bypass managed policy. It adds no launcher hooks and does not change user, project or managed settings. Existing configured hooks can still run if policy permits them; it does not disable those hooks.

The CLI must support stream-json input/output and `--permission-prompts none`. Unsupported flags cause failure. Use a trusted workspace. Sessions retain existing rules, settings and permissions. The launcher adds no tool allowlist. Approval-dependent actions are denied and reported; this mode has no native permission dialog. It rejects permission-bypass launch flags.

## Interface and limits

- Enter a message on a line. Messages arriving during work are queued until the active process exits. Local commands are `/help` and `/quit`; other slash commands are rejected. This is not the native editor, permission UI or command picker.
- Start model and effort choices through CLI flags, never `/model` or `/effort`. The supported argument list lives in `assets/claude_auto_managed.py` (`VALUE_FLAGS` and `PLAIN_FLAGS`); unknown flags fail before a session starts.
- Resume/continue selectors, anchor bootstrap and `CLAUDE_AUTO_NEXT_ARGS` are unsupported. The launcher owns session IDs and resumes between completed turns. Unset `CLAUDE_AUTO_ANCHOR_ID` and `CLAUDE_AUTO_NEXT_ARGS` before starting this mode.
- Automatic handoff checks the persisted transcript after a successful process exits. It does not enforce a context ceiling mid-turn. It writes the usual handoff note and starts a new session on the next human message. Missing transcripts or handoff-writer failures are reported rather than silently replacing context. Work must remain within the foreground turn; the launcher does not promise preservation of background commands/subagents when it closes that process group.

## Verification

`npm run test:claude-auto` covers both launcher modes and installation/removal in temporary homes. Tests use fake CLI processes; they do not establish compatibility with a particular managed laptop or live provider. A live test spends subscription/API quota and requires the user's approval. Never change global model/effort defaults for that test.
