import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../../skills/compact-session/scripts/request_compaction.py", import.meta.url));

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "compact-request-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const requests = join(home, ".claude", "compact-session", "requests");
  const path = (id) => join(requests, `${createHash("sha256").update(id).digest("hex")}.json`);
  return {
    home, requests, path,
    run(args, input = "") {
      return spawnSync("python3", ["-I", SCRIPT, ...args], {
        env: { ...process.env, HOME: home }, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8",
      });
    },
    put(id, value) {
      mkdirSync(requests, { recursive: true });
      writeFileSync(path(id), typeof value === "string" ? value : JSON.stringify(value));
    },
  };
}

const stop = (session_id = "session") => ({ hook_event_name: "Stop", session_id });

test("frontmatter's Stop command only arms an atomic, session-scoped, single-use request", (t) => {
  const f = fixture(t);
  const armed = f.run(["arm"], stop("first"));
  assert.equal(armed.status, 0, armed.stderr);
  assert.equal(armed.stdout, "", "a classic hook must not pretend to return replacement messages");
  assert.equal(JSON.parse(readFileSync(f.path("first"), "utf8")).sessionId, "first");
  assert.deepEqual(JSON.parse(f.run(["take", "other"]).stdout), { pending: false });
  assert.deepEqual(JSON.parse(f.run(["take", "first"]).stdout), { pending: true });
  assert.deepEqual(JSON.parse(f.run(["take", "first"]).stdout), { pending: false });
  assert.deepEqual(readdirSync(f.requests), []);
  assert.equal(f.run(["arm"], stop("first")).status, 0);
  assert.deepEqual(JSON.parse(f.run(["take", "first"]).stdout), { pending: true });
});

test("no Stop hook request means no compaction to take", (t) => {
  const f = fixture(t);
  const result = f.run(["take", "session"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { pending: false });
});

for (const [name, value] of [
  ["expired", { sessionId: "session", createdAt: Date.now() / 1000 - 700 }],
  ["future", { sessionId: "session", createdAt: Date.now() / 1000 + 700 }],
  ["wrong session", { sessionId: "other", createdAt: Date.now() / 1000 }],
]) {
  test(`${name} request is consumed without authorizing replacement`, (t) => {
    const f = fixture(t);
    f.put("session", value);
    const result = f.run(["take", "session"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { pending: false });
    assert.deepEqual(readdirSync(f.requests), []);
  });
}

for (const value of ["not json", {}, { sessionId: "session", createdAt: "bad" }]) {
  test(`malformed request ${JSON.stringify(value)} fails closed and is removed`, (t) => {
    const f = fixture(t);
    f.put("session", value);
    const result = f.run(["take", "session"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /compact-session request:/);
    assert.deepEqual(readdirSync(f.requests), []);
  });
}

for (const event of [null, [], {}, { hook_event_name: "PreCompact", session_id: "session" }, stop(""), stop(1)]) {
  test(`rejects invalid Stop input ${JSON.stringify(event)}`, (t) => {
    const f = fixture(t);
    const result = f.run(["arm"], JSON.stringify(event));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /compact-session request:/);
    assert.deepEqual(JSON.parse(f.run(["take", "session"]).stdout), { pending: false });
  });
}
