#!/usr/bin/env python3
"""compact-session for OpenCode: the request window of a `compaction` hook, as the compact-session engine reads it.

The input on stdin is {"sessionId": ..., "messages": [...]}, the messages as OpenCode 2.3.0 hands them to the hook (its
provider-neutral message shape: role system/user/assistant/tool, content parts text, reasoning, tool-call, tool-result,
effort, compaction). The exact input bytes are archived by the shared engine (skills/compact-session/scripts/compact_session.py),
which also does the preparation and the round-trip check. This file only converts the shape:

  rendered   text, tool calls, tool results (text, JSON or error; a call's namespace joins its name), system text, effort,
             and the text of a provider checkpoint
  archived   reasoning, and every `metadata`, `providerMetadata`, `cache`, `providerExecuted` field: they are kept in
             snapshot.json and are not turned into text that the model would then read as conversation
  refused    media, an encrypted checkpoint, a field this code does not know: the compaction fails closed

No model call, no database access.
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills" / "compact-session" / "scripts"))
import compact_session as cs  # noqa: E402

MESSAGE = {"id", "role", "content", "metadata", "providerMetadata"}
TEXT = {"type", "text", "cache", "providerMetadata"}
REASONING = {"type", "text", "encrypted", "cache", "providerMetadata"}
TOOL_CALL = {"type", "id", "name", "namespace", "input", "providerExecuted", "cache", "providerMetadata"}
TOOL_RESULT = {"type", "id", "name", "namespace", "result", "providerExecuted", "cache", "providerMetadata"}
EFFORT = {"type", "effort", "previous"}
CHECKPOINT = {"type", "provider", "id", "encrypted", "text"}


def tool_name(part, where):
    name = cs.require_string(part.get("name"), where + ".name", nonempty=True)
    namespace = part.get("namespace")
    if namespace is None:
        return name
    return cs.require_string(namespace, where + ".namespace", nonempty=True) + "_" + name


def result_text(result, where):
    """(text, is_error) of a tool result value; media inside a result is refused."""
    if not isinstance(result, dict):
        raise ValueError(f"{where} must be an object")
    kind = result.get("type")
    cs.require_fields(result, {"type", "value"}, where)
    value = result.get("value")
    if kind == "text":
        return (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, allow_nan=False)), False
    if kind in ("json", "error"):
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, allow_nan=False)
        return text, kind == "error"
    if kind == "content":
        if not isinstance(value, list):
            raise ValueError(f"{where}.value must be an array")
        texts = []
        for i, item in enumerate(value):
            if not isinstance(item, dict) or item.get("type") != "text":
                raise ValueError(f"unsupported media in {where}.value[{i}]")
            cs.require_fields(item, {"type", "text"}, f"{where}.value[{i}]")
            texts.append(cs.require_string(item.get("text"), f"{where}.value[{i}].text"))
        return "\n".join(texts), False
    raise ValueError(f"unsupported tool result type at {where}: {kind!r}")


def convert(snapshot):
    """The messages in the shape the shared engine reads (one block per message, so that no block swallows its neighbour)."""
    if not isinstance(snapshot, dict):
        raise ValueError("snapshot must be an object")
    cs.require_fields(snapshot, {"sessionId", "messages"}, "snapshot")
    cs.require_string(snapshot.get("sessionId"), "sessionId", nonempty=True)
    messages = snapshot.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages must be a nonempty array")
    out = []
    for i, message in enumerate(messages):
        where = f"messages[{i}]"
        if not isinstance(message, dict):
            raise ValueError(f"{where} must be an object")
        cs.require_fields(message, MESSAGE, where)
        role = message.get("role")
        if role not in ("system", "user", "assistant", "tool"):
            raise ValueError(f"{where}.role is not supported")
        if "id" in message and not isinstance(message["id"], str):
            raise ValueError(f"{where}.id must be a string")
        parts = message.get("content")
        if isinstance(parts, str):
            parts = [{"type": "text", "text": parts}]
        if not isinstance(parts, list) or not parts:
            raise ValueError(f"{where}.content must be a nonempty array or string")
        for j, part in enumerate(parts):
            at = f"{where}.content[{j}]"
            if not isinstance(part, dict):
                raise ValueError(f"{at} must be an object")
            kind = part.get("type")
            if kind == "reasoning" and role == "assistant":
                cs.require_fields(part, REASONING, at)
                cs.require_string(part.get("text"), at + ".text")
                continue
            if kind == "text" and role in ("system", "user", "assistant"):
                cs.require_fields(part, TEXT, at)
                text = cs.require_string(part.get("text"), at + ".text")
                if role == "system":
                    text = "[OpenCode system] " + text
                out.append({"role": "assistant" if role == "assistant" else "user", "content": [{"type": "text", "text": text}]})
            elif kind == "tool-call" and role == "assistant":
                cs.require_fields(part, TOOL_CALL, at)
                cs.require_string(part.get("id"), at + ".id", nonempty=True)
                value = part.get("input")
                if not isinstance(value, dict):
                    value = {"opencode_input": value}
                out.append({"role": "assistant", "content": [{"type": "tool_use", "id": part["id"], "name": tool_name(part, at), "input": value}]})
            elif kind == "tool-result" and role in ("assistant", "tool"):
                cs.require_fields(part, TOOL_RESULT, at)
                cs.require_string(part.get("id"), at + ".id", nonempty=True)
                tool_name(part, at)
                text, is_error = result_text(part.get("result"), at + ".result")
                out.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": part["id"], "content": text, "is_error": is_error}]})
            elif kind == "effort" and role == "system":
                cs.require_fields(part, EFFORT, at)
                out.append({"role": "user", "content": [{"type": "text", "text": "[OpenCode effort] " + json.dumps({k: part[k] for k in ("effort", "previous") if k in part}, ensure_ascii=False)}]})
            elif kind == "compaction" and role == "assistant":
                cs.require_fields(part, CHECKPOINT, at)
                text = part.get("text")
                if part.get("encrypted") is not None or not isinstance(text, str):
                    raise ValueError(f"an encrypted or empty provider checkpoint at {at} cannot be rendered")
                out.append({"role": "user", "content": [{"type": "text", "text": "[OpenCode provider checkpoint] " + text}]})
            else:
                raise ValueError(f"unsupported content part at {at}: {kind!r} for {role}")
    return {"sessionId": snapshot["sessionId"], "messages": out}


def records(snapshot):
    return cs.synthetic_records(convert(snapshot))


def main():
    try:
        result = cs.compact(sys.stdin.buffer.read(), records_factory=records)
    except (ValueError, TypeError, KeyError, OSError, cs.subprocess.CalledProcessError, AssertionError) as error:
        print(f"compact-session: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
