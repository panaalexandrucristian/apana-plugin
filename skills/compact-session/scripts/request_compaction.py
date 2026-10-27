#!/usr/bin/env python3
"""One-shot bridge from the skill's classic Stop hook to native compaction."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time


HOME = Path.home() / ".claude" / "compact-session" / "requests"


def request_path(session_id):
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("session_id must be a nonempty string")
    return HOME / (hashlib.sha256(session_id.encode("utf-8")).hexdigest() + ".json")


def arm(event):
    if not isinstance(event, dict) or event.get("hook_event_name") != "Stop":
        raise ValueError("only the skill's Stop event may request compaction")
    session_id = event.get("session_id")
    target = request_path(session_id)
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix="request-", dir=HOME)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"sessionId": session_id, "createdAt": time.time()}, stream)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def take(session_id):
    target = request_path(session_id)
    try:
        fd, consumed = tempfile.mkstemp(prefix="consumed-", dir=HOME)
    except FileNotFoundError:
        return {"pending": False}
    os.close(fd)
    try:
        try:
            os.replace(target, consumed)
        except FileNotFoundError:
            return {"pending": False}
        request = json.loads(Path(consumed).read_text(encoding="utf-8"))
        age = time.time() - request["createdAt"]
        return {"pending": request["sessionId"] == session_id and 0 <= age < 600}
    finally:
        Path(consumed).unlink(missing_ok=True)


def main():
    try:
        if sys.argv[1:] == ["arm"]:
            arm(json.load(sys.stdin))
        elif len(sys.argv) == 3 and sys.argv[1] == "take":
            print(json.dumps(take(sys.argv[2])))
        else:
            raise ValueError("usage: request_compaction.py arm | take SESSION_ID")
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"compact-session request: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
