---
name: compact-session
description: Compact the active conversation in place, keeping recoverable history in local files. Use only when the user explicitly requests /apana:compact-session; unlike compact-handoff, this continues in the same session.
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'python3 -I "${CLAUDE_PLUGIN_ROOT}/skills/compact-session/scripts/request_compaction.py" arm'
          timeout: 10
          once: true
---

# compact-session

Replace the active session's context with a verified, deterministic compact transcript. Stay in the same session: no `/clear`, restart, new session, or manual transcript-file edit.

## This turn

Check this skill's **current expanded prompt** for the bridge's appended `compact-session-native-ready` confirmation. A reference to that text in old history is not confirmation. The `Stop` hook is declared in this skill's frontmatter, like `jev-decision-loop`; `once: true` makes it a one-shot request, not an automatic compaction on every later turn. A minimal native module is still required to install replacement messages: classic command hooks alone cannot do that.

- If present, reply briefly that compaction is pending, then **finish this turn without calling tools**. Do not say compaction has succeeded yet. The native hook runs at `turn.complete` and reports the actual result afterward.
- If absent, report that the native handler is unavailable and context has not been replaced. This skill requires the Apana function-hook module and a Claude Code build supporting custom `session.compact` results. Do not emulate the operation with shell commands.

The native compaction API is unavailable in headless (`-p`/SDK) runs on the tested build. A loaded bridge is not proof that replacement is available: report the native failure, leave context unchanged and do not fall back to a different compaction method.

The native handler snapshots the active conversation, reuses the textual preparation/compression and round-trip verification from `compact-handoff`, then installs the replacement through `session.compact`. Omitted tool content stays recoverable in durable local blobs. Ordinary user and assistant prose is not summarized. Verification covers the prepared text, not byte-for-byte preservation of the API snapshot: the existing sanitizer remains active, thinking is archive-only, and transport metadata is not rendered. The full API snapshot is also archived; unsupported media and content-bearing citations must fail closed, not disappear silently.

The replacement has its own same-session instructions. Historical requests and tool calls remain history, not commands to replay. It does not run the `compact-handoff` skill, ask which skills to reload, recreate an active goal, or change that skill's behavior.

Only replace context after verification succeeds. On failure or a result that would not shrink context, keep the current context. A verified result that would not shrink is a successful check with no replacement, not invalid output; this is expected when invoking the skill again before enough compressible content has accumulated. The native hook reports the measured character counts in that case. Its latest outcome is also attached to the next accepted prompt so the model can distinguish replacement, no-op and failure; that outcome describes the completed invocation, not a request to run it again. Do not fall back to a model-written summary, built-in `/compact`, or editing a live JSONL file. Do not delete the generated files: later compact contexts can refer to them.
