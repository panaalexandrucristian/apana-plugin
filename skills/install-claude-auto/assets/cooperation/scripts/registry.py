"""Local, caller-identified coordination, not an authentication/permission boundary.

Only explicit publish instructions are offered to helpers; prompt text stays in
own_tasks. The database path and injected clock are trusted host inputs, never
request fields. Each request uses its own connection and an IMMEDIATE transaction.
"""
import json
import math
import os
from pathlib import Path
import sqlite3
import stat
import sys
import time
import uuid

MEMBERSHIP_TTL = 90.0
LEASE_TTL = 30.0
BUSY_TIMEOUT_MS = 5000
TEXT_LIMIT = 65536

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS members (
        member TEXT PRIMARY KEY, generation INTEGER NOT NULL,
        session TEXT NOT NULL, cwd TEXT NOT NULL, provider TEXT NOT NULL,
        owner_revision INTEGER NOT NULL DEFAULT 0,
        owner_state TEXT NOT NULL DEFAULT 'active',
        status TEXT NOT NULL DEFAULT 'live', expires_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS own_tasks (
        member TEXT NOT NULL REFERENCES members(member), revision INTEGER NOT NULL,
        text TEXT NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL,
        finished_at REAL, PRIMARY KEY (member,revision)
    )""",
    """CREATE TABLE IF NOT EXISTS tasks (
        task TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES members(member),
        owner_revision INTEGER NOT NULL, title TEXT NOT NULL,
        instructions TEXT NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS contributions (
        contribution TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(task),
        contributor TEXT NOT NULL REFERENCES members(member),
        generation INTEGER NOT NULL, session TEXT NOT NULL,
        lease TEXT NOT NULL UNIQUE, state TEXT NOT NULL, result TEXT, reason TEXT,
        started_at REAL NOT NULL, expires_at REAL NOT NULL, finished_at REAL
    )""",
    """CREATE UNIQUE INDEX IF NOT EXISTS one_claim_per_task
        ON contributions(task) WHERE state='claimed'""",
    """CREATE UNIQUE INDEX IF NOT EXISTS one_claim_per_helper
        ON contributions(contributor) WHERE state='claimed'""",
    """CREATE TABLE IF NOT EXISTS decisions (
        decision TEXT PRIMARY KEY, task TEXT NOT NULL UNIQUE REFERENCES tasks(task),
        contribution TEXT NOT NULL REFERENCES contributions(contribution),
        owner TEXT NOT NULL REFERENCES members(member), owner_revision INTEGER NOT NULL,
        contributor TEXT NOT NULL REFERENCES members(member), verdict TEXT NOT NULL,
        rationale TEXT NOT NULL, created_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS withdrawals (
        task TEXT PRIMARY KEY REFERENCES tasks(task),
        owner TEXT NOT NULL REFERENCES members(member), generation INTEGER NOT NULL,
        owner_revision INTEGER NOT NULL, reason TEXT NOT NULL, created_at REAL NOT NULL
    )""",
)
IDENTITY = {"member", "generation"}
FIELDS = {
    "register": (IDENTITY | {"session", "cwd", "provider"}, set()),
    "prompt": (IDENTITY | {"text"}, set()),
    "idle": (IDENTITY, {"expected_revision"}),
    "publish": (IDENTITY | {"title", "instructions"}, {"expected_revision"}),
    "claim": (IDENTITY, set()),
    "heartbeat": (IDENTITY, {"lease"}),
    "release": (IDENTITY | {"task", "lease", "reason"}, set()),
    "withdraw": (IDENTITY | {"task", "reason"}, {"expected_revision"}),
    "close": (IDENTITY, set()),
    "complete": (IDENTITY | {"task", "lease", "result"}, set()),
    "results": (IDENTITY, set()),
    "decide": (IDENTITY | {"task", "decision", "rationale"}, {"expected_revision"}),
    "snapshot": (set(), set()),
    "tick": (set(), set()),
}


def _validate(request):
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    op = request.get("op")
    if not isinstance(op, str) or op not in FIELDS:
        raise ValueError("unknown op")
    required, optional = FIELDS[op]
    keys = set(request) - {"op"}
    if not required <= keys or keys - required - optional:
        raise ValueError("missing or unknown fields")
    for field in ("member", "session", "task", "lease"):
        if field in request:
            value = request[field]
            if not isinstance(value, str) or str(uuid.UUID(value)) != value:
                raise ValueError(field + " must be a canonical UUID")
    for field in ("generation", "expected_revision"):
        if field in request:
            value = request[field]
            if type(value) is not int or not 0 <= value <= 9223372036854775807:
                raise ValueError(field + " must be a nonnegative SQLite integer")
    limits = {"cwd": 4096, "provider": 64, "title": 256,
              "instructions": 16384, "text": TEXT_LIMIT,
              "result": TEXT_LIMIT, "rationale": 4096, "reason": 256}
    for field, limit in limits.items():
        if field in request:
            value = request[field]
            if (not isinstance(value, str) or not value.strip() or "\0" in value
                    or len(value.encode("utf-8")) > limit):
                raise ValueError(field + " must be nonempty bounded UTF-8 text")
    if "cwd" in request and not os.path.isabs(request["cwd"]):
        raise ValueError("cwd must be absolute (it is metadata, never opened)")
    if op == "decide" and request["decision"] not in ("accept", "reject"):
        raise ValueError("decision must be accept or reject")
    return op


def _connect(path):
    path = Path(path)
    if str(path) == ":memory:":
        raise ValueError("database must be a durable filesystem path")
    missing = []
    parent = path.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for parent in reversed(missing):
        try:
            parent.mkdir(mode=0o700)
        except FileExistsError:
            pass  # Another registry process created the same directory.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                or info.st_uid != os.getuid()):
            raise ValueError("database must be an owned private regular file")
    else:
        os.close(fd)
    db = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_MS / 1000,
                         isolation_level=None)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout = " + str(BUSY_TIMEOUT_MS))
        # Simultaneous first opens can return SQLITE_BUSY from WAL negotiation
        # without invoking SQLite's busy handler. Retry only that initialization,
        # within a real-clock bound; never replay a committed request.
        deadline = time.monotonic() + BUSY_TIMEOUT_MS / 1000
        while True:
            try:
                mode = db.execute("PRAGMA journal_mode = WAL").fetchone()[0]
                if mode != "wal":
                    raise ValueError("database does not support WAL")
                break
            except sqlite3.OperationalError as exc:
                remaining = deadline - time.monotonic()
                code = getattr(exc, "sqlite_errorcode", 0) & 0xff
                if code not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) or remaining <= 0:
                    raise
                time.sleep(min(0.01, remaining))
        db.execute("PRAGMA synchronous = FULL")
        db.execute("PRAGMA foreign_keys = ON")
        return db
    except Exception:
        db.close()
        raise


def _rows(db, sql, args=()):
    return [dict(row) for row in db.execute(sql, args)]


def _member(db, member):
    rows = _rows(db, "SELECT * FROM members WHERE member=?", (member,))
    return rows[0] if rows else None


def _auth(db, request, now):
    member = _member(db, request["member"])
    if member is None or member["generation"] != request["generation"]:
        raise ValueError("unknown member or stale generation")
    if member["status"] != "live" or member["expires_at"] <= now:
        raise ValueError("membership is not live; register a newer generation")
    if "expected_revision" in request and request["expected_revision"] != member["owner_revision"]:
        raise ValueError("stale owner revision")
    return member


def _outstanding(db, member):
    return db.execute("""SELECT 1 FROM tasks WHERE owner=?
        AND state IN ('queued','claimed','completed') LIMIT 1""", (member,)).fetchone()


def _task(db, task):
    rows = _rows(db, "SELECT * FROM tasks WHERE task=?", (task,))
    if not rows:
        raise ValueError("unknown task")
    return rows[0]


def _attempt(db, task, state="claimed"):
    rows = _rows(db, "SELECT * FROM contributions WHERE task=? AND state=?",
                 (task, state))
    return rows[0] if rows else None


def _current_owner(db, task, now):
    owner = _member(db, task["owner"])
    if (owner["owner_revision"] != task["owner_revision"]
            or owner["status"] != "live" or owner["expires_at"] <= now):
        raise ValueError("task owner or revision is not live")
    return owner


def _claimed(db, request, now):
    task = _task(db, request["task"])
    _current_owner(db, task, now)
    attempt = _attempt(db, task["task"])
    if (task["state"] != "claimed" or attempt is None
            or attempt["contributor"] != request["member"]
            or attempt["generation"] != request["generation"]
            or attempt["lease"] != request["lease"]
            or attempt["expires_at"] <= now):
        raise ValueError("stale or foreign claim")
    return task, attempt


def _claim_view(db, attempt):
    return {**_task(db, attempt["task"]), "lease": attempt["lease"],
            "expires_at": attempt["expires_at"]}


def _cancel_attempt(db, attempt, reason, now):
    db.execute("""UPDATE contributions SET state='cancelled',reason=?,finished_at=?
        WHERE contribution=? AND state='claimed'""", (reason, now, attempt["contribution"]))
    db.execute("UPDATE tasks SET state='queued' WHERE task=? AND state='claimed'",
               (attempt["task"],))


def _release_member(db, member, reason, now):
    for attempt in _rows(db, "SELECT * FROM contributions WHERE contributor=? AND state='claimed'",
                         (member,)):
        _cancel_attempt(db, attempt, reason, now)


def _reap(db, now):
    expired = db.execute("UPDATE members SET status='expired' WHERE status='live' AND expires_at<=?",
                         (now,)).rowcount
    released = 0
    for attempt in _rows(db, "SELECT * FROM contributions WHERE state='claimed'"):
        helper = _member(db, attempt["contributor"])
        task = _task(db, attempt["task"])
        owner = _member(db, task["owner"])
        reason = None
        if helper["status"] != "live":
            reason = "member-expired"
        elif owner["status"] != "live":
            reason = "owner-unavailable"
        elif attempt["expires_at"] <= now:
            reason = "lease-expired"
        if reason:
            _cancel_attempt(db, attempt, reason, now)
            released += 1
    return {"members_expired": expired, "claims_released": released}


def _run(db, op, request, now):
    if op == "tick":
        return _reap(db, now)
    if op in ("register", "claim"):
        _reap(db, now)
    if op == "snapshot":
        # Table/order expressions are constants, never request-provided SQL.
        snapshot = {table: _rows(db, "SELECT * FROM " + table + " ORDER BY " + order)
                    for table, order in (("members", "member"), ("tasks", "created_at,task"),
                        ("own_tasks", "member,revision"),
                        ("contributions", "started_at,contribution"),
                        ("decisions", "created_at,decision"), ("withdrawals", "created_at,task"))}
        for own_task in snapshot["own_tasks"]:
            del own_task["text"]  # Only the owner's results operation returns private prompt text.
        return snapshot
    if op == "register":
        existing = _member(db, request["member"])
        if existing:
            if request["generation"] < existing["generation"]:
                raise ValueError("stale generation")
            if request["generation"] == existing["generation"]:
                _auth(db, request, now)
                if any(existing[field] != request[field] for field in ("session", "cwd", "provider")):
                    raise ValueError("same generation cannot change registration identity")
            else:
                _release_member(db, request["member"], "generation-rotated", now)
            db.execute("""UPDATE members SET generation=?,session=?,cwd=?,provider=?,
                status='live',expires_at=? WHERE member=?""",
                (request["generation"], request["session"], request["cwd"],
                 request["provider"], now + MEMBERSHIP_TTL, request["member"]))
        else:
            db.execute("""INSERT INTO members
                (member,generation,session,cwd,provider,expires_at)
                VALUES (?,?,?,?,?,?)""", (request["member"], request["generation"],
                request["session"], request["cwd"], request["provider"],
                now + MEMBERSHIP_TTL))
        return {"member": _member(db, request["member"])}
    member = _auth(db, request, now)
    key = member["member"]
    if op == "close":
        _release_member(db, key, "member-closed", now)
        db.execute("UPDATE members SET status='closed' WHERE member=?", (key,))
        return {"member": _member(db, key)}
    if op == "withdraw":
        task = _task(db, request["task"])
        if task["owner"] != key:
            raise ValueError("only owner may withdraw a task")
        _current_owner(db, task, now)
        if task["state"] != "withdrawn":
            if task["state"] not in ("queued", "claimed", "completed"):
                raise ValueError("only outstanding tasks may be withdrawn")
            attempt = _attempt(db, task["task"])
            if attempt:
                _cancel_attempt(db, attempt, request["reason"], now)
            db.execute("UPDATE tasks SET state='withdrawn' WHERE task=?", (task["task"],))
            db.execute("INSERT INTO withdrawals VALUES (?,?,?,?,?,?)",
                       (task["task"], key, member["generation"], member["owner_revision"],
                        request["reason"], now))
        return {"task": _task(db, task["task"]), "withdrawal": _rows(db,
                "SELECT * FROM withdrawals WHERE task=?", (task["task"],))[0]}
    if op == "release":
        task, attempt = _claimed(db, request, now)
        _cancel_attempt(db, attempt, request["reason"], now)
        return {"task": _task(db, task["task"]), "contribution": _rows(db,
                "SELECT * FROM contributions WHERE contribution=?", (attempt["contribution"],))[0]}
    if op == "heartbeat":
        attempt = None
        if "lease" in request:
            candidates = _rows(db, "SELECT * FROM contributions WHERE lease=?", (request["lease"],))
            if not candidates:
                raise ValueError("unknown lease")
            _, attempt = _claimed(db, {**request, "task": candidates[0]["task"]}, now)
            db.execute("UPDATE contributions SET expires_at=? WHERE contribution=?",
                       (now + LEASE_TTL, attempt["contribution"]))
        db.execute("UPDATE members SET expires_at=? WHERE member=?", (now + MEMBERSHIP_TTL, key))
        result = {"member": _member(db, key)}
        if attempt:
            result["task"] = _claim_view(db, _attempt(db, attempt["task"]))
        return result
    if op == "prompt":
        _release_member(db, key, "user-prompt", now)
        for attempt in _rows(db, """SELECT c.* FROM contributions c JOIN tasks t ON t.task=c.task
                WHERE t.owner=? AND c.state='claimed'""", (key,)):
            _cancel_attempt(db, attempt, "owner-revision", now)
        db.execute("""UPDATE tasks SET state='cancelled' WHERE owner=?
            AND state IN ('queued','claimed','completed')""", (key,))
        db.execute("""UPDATE own_tasks SET state='superseded',finished_at=?
            WHERE member=? AND state='active'""", (now, key))
        revision = member["owner_revision"] + 1
        db.execute("UPDATE members SET owner_revision=?,owner_state='active' WHERE member=?",
                   (revision, key))
        db.execute("""INSERT INTO own_tasks(member,revision,text,state,created_at)
            VALUES (?,?,?,'active',?)""", (key, revision, request["text"], now))
        return {"member": _member(db, key)}
    if op == "idle":
        if _outstanding(db, key):
            raise ValueError("owner has outstanding tasks")
        db.execute("UPDATE members SET owner_state='idle' WHERE member=?", (key,))
        db.execute("""UPDATE own_tasks SET state='done',finished_at=?
            WHERE member=? AND state='active'""", (now, key))
        return {"member": _member(db, key)}
    if op == "publish":
        if member["owner_state"] != "active":
            raise ValueError("publishing requires an active own task")
        task_id = str(uuid.uuid4())
        db.execute("""INSERT INTO tasks VALUES (?,?,?,?,?,'queued',?)""",
                   (task_id, key, member["owner_revision"], request["title"],
                    request["instructions"], now))
        return {"task": _task(db, task_id)}
    if op == "claim":
        if member["owner_state"] != "idle" or _outstanding(db, key):
            raise ValueError("owner is not explicitly idle")
        active = _rows(db, "SELECT * FROM contributions WHERE contributor=? AND state='claimed'",
                       (key,))
        if active:
            return {"task": _claim_view(db, active[0])}
        tasks = _rows(db, """SELECT t.* FROM tasks t JOIN members m ON m.member=t.owner
            WHERE t.state='queued' AND t.owner<>? AND m.status='live'
            AND m.expires_at>? AND m.owner_revision=t.owner_revision
            ORDER BY t.created_at,t.task LIMIT 1""", (key, now))
        if not tasks:
            return {"task": None}
        task_id = tasks[0]["task"]
        db.execute("""INSERT INTO contributions
            (contribution,task,contributor,generation,session,lease,state,started_at,expires_at)
            VALUES (?,?,?,?,?,?,'claimed',?,?)""", (str(uuid.uuid4()), task_id, key,
            member["generation"], member["session"], str(uuid.uuid4()), now, now + LEASE_TTL))
        db.execute("UPDATE tasks SET state='claimed' WHERE task=?", (task_id,))
        return {"task": _claim_view(db, _attempt(db, task_id))}
    if op == "complete":
        task, attempt = _claimed(db, request, now)
        db.execute("""UPDATE contributions SET state='completed',result=?,finished_at=?
            WHERE contribution=?""", (request["result"], now, attempt["contribution"]))
        db.execute("UPDATE tasks SET state='completed' WHERE task=?", (task["task"],))
        return {"contribution": _attempt(db, task["task"], "completed")}
    if op == "results":
        tasks = _rows(db, "SELECT * FROM tasks WHERE owner=? ORDER BY created_at,task", (key,))
        for task in tasks:
            latest = _rows(db, "SELECT * FROM contributions WHERE task=? ORDER BY rowid DESC LIMIT 1",
                           (task["task"],))
            task["contribution"] = latest[0] if latest else None
            withdrawal = _rows(db, "SELECT * FROM withdrawals WHERE task=?", (task["task"],))
            task["withdrawal"] = withdrawal[0] if withdrawal else None
        received = _rows(db, """SELECT c.* FROM contributions c JOIN tasks t ON t.task=c.task
            WHERE t.owner=? ORDER BY c.started_at,c.contribution""", (key,))
        helped = _rows(db, """SELECT * FROM contributions WHERE contributor=?
            ORDER BY started_at,contribution""", (key,))
        return {"tasks": tasks, "own_tasks": _rows(db,
                "SELECT * FROM own_tasks WHERE member=? ORDER BY revision", (key,)),
                "contributions": received, "helped": helped,
                "summary": {"own_completed": sum(c["state"] == "completed" for c in received),
                    "own_outstanding": sum(t["state"] in ("queued", "claimed", "completed") for t in tasks),
                    "helped_completed": sum(c["state"] == "completed" for c in helped),
                    "helped_cancelled": sum(c["state"] == "cancelled" for c in helped)}}
    if op == "decide":
        task = _task(db, request["task"])
        if task["owner"] != key or task["state"] != "completed":
            raise ValueError("only owner may decide an undecided result")
        _current_owner(db, task, now)
        attempt = _attempt(db, task["task"], "completed")
        decision_id = str(uuid.uuid4())
        db.execute("INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?)",
                   (decision_id, task["task"], attempt["contribution"], key,
                    member["owner_revision"], attempt["contributor"],
                    request["decision"], request["rationale"], now))
        db.execute("UPDATE tasks SET state=? WHERE task=?",
                   ("accepted" if request["decision"] == "accept" else "rejected", task["task"]))
        return {"decision": _rows(db, "SELECT * FROM decisions WHERE decision=?", (decision_id,))[0]}
    raise ValueError("unknown op")


def _now(clock):
    now = float(clock())
    if not math.isfinite(now):
        raise ValueError("clock must be finite")
    return now


def dispatch(db_path, request, *, clock=time.time):
    """Return a JSON-compatible response; clock is a host-only test seam."""
    db = None
    try:
        op = _validate(request)
        _now(clock)  # Reject a bad host clock before creating any files.
        db = _connect(db_path)
        db.execute("BEGIN IMMEDIATE")
        for statement in SCHEMA:
            db.execute(statement)
        # The request linearizes after acquiring the write lock, not on arrival:
        # lock contention must not let an expired lease complete with an old time.
        result = _run(db, op, request, _now(clock))
        db.commit()
        return {"ok": True, **result}
    except (ValueError, TypeError, OSError, sqlite3.Error) as exc:
        if db is not None and db.in_transaction:
            db.rollback()
        return {"ok": False, "error": str(exc)}
    finally:
        if db is not None:
            db.close()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("nonfinite JSON number: " + value)


def main():
    """One request/response; application errors are JSON, not tracebacks."""
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: python3 -I registry.py DB_PATH")
        data = sys.stdin.buffer.read(262145)
        if len(data) > 262144:
            raise ValueError("request exceeds byte limit")
        request = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object,
                             parse_constant=_invalid_constant)
        response = dispatch(sys.argv[1], request)
    except (ValueError, OSError, RecursionError) as exc:
        response = {"ok": False, "error": str(exc)}
    print(json.dumps(response, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    main()
