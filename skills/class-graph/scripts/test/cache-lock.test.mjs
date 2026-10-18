// Tests for the readers-writer lock of the graph cache: readers share it, a clear
// or replace waits for them and holds new ones back, stale locks of dead processes
// go away, and real parallel runs of the CLI end up with one whole cache.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withLock } from "../cache-lock.mjs";
import { cachePath, clearCache, loadCache, saveCache } from "../graph-cache.mjs";

const CLASS_GRAPH = join(dirname(fileURLToPath(import.meta.url)), "..", "class-graph.mjs");
const hasRg = spawnSync("rg", ["--version"]).status === 0;
const FAST = { timeoutMs: 100, pollMs: 5 };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** A promise that stays pending until `open()` is called. */
const gate = () => {
  let open;
  const wait = new Promise((resolve) => {
    open = resolve;
  });
  return { wait, open };
};
const until = async (condition, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (condition()) return;
  assert.fail("timed out waiting for a condition");
};

describe("the cache lock", () => {
  let base;
  let n = 0;
  const lockDir = () => join(base, `lock-${++n}`);
  before(() => {
    base = mkdtempSync(join(tmpdir(), "find-usages-lock-"));
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it("lets many readers in at the same time", async () => {
    const dir = lockDir();
    const gates = [gate(), gate(), gate()];
    let inside = 0;
    let most = 0;
    const readers = gates.map((g) =>
      withLock(dir, "shared", async () => {
        inside += 1;
        most = Math.max(most, inside);
        await g.wait;
        inside -= 1;
      }),
    );
    await until(() => inside === 3);
    assert.equal(most, 3);
    for (const g of gates) g.open();
    assert.ok((await Promise.all(readers)).every((r) => r.acquired));
  });

  it("makes a writer wait for the readers inside and keeps new readers behind it", async () => {
    const dir = lockDir();
    const first = gate();
    const events = [];
    const reader1 = withLock(dir, "shared", async () => {
      events.push("reader1 in");
      await first.wait;
      events.push("reader1 out");
    });
    await until(() => events.length === 1);
    const writer = withLock(dir, "exclusive", async () => events.push("writer"));
    await sleep(80);
    const reader2 = withLock(dir, "shared", async () => events.push("reader2"));
    await sleep(80);
    assert.deepEqual(events, ["reader1 in"], "the writer waits for reader1 and reader2 waits for the writer");
    first.open();
    await Promise.all([reader1, writer, reader2]);
    assert.deepEqual(events, ["reader1 in", "reader1 out", "writer", "reader2"]);
  });

  it("keeps readers out while a writer holds the lock", async () => {
    const dir = lockDir();
    const hold = gate();
    let writing = false;
    let readerRan = false;
    const writer = withLock(dir, "exclusive", async () => {
      writing = true;
      await hold.wait;
    });
    await until(() => writing);
    const reader = withLock(dir, "shared", async () => {
      readerRan = true;
    });
    await sleep(80);
    assert.equal(readerRan, false);
    hold.open();
    await Promise.all([writer, reader]);
    assert.equal(readerRan, true);
  });

  it("gives up after the timeout without running the work", async () => {
    const dir = lockDir();
    const hold = gate();
    let writing = false;
    const writer = withLock(dir, "exclusive", async () => {
      writing = true;
      await hold.wait;
    });
    await until(() => writing);
    let ran = false;
    const reader = await withLock(dir, "shared", async () => (ran = true), FAST);
    const second = await withLock(dir, "exclusive", async () => (ran = true), FAST);
    assert.deepEqual([reader.acquired, second.acquired, ran], [false, false, false]);
    hold.open();
    await writer;
    assert.equal((await withLock(dir, "exclusive", async () => 7, FAST)).value, 7, "the lock is free again");
    assert.deepEqual(readdirSync(dir), [], "nothing is left in the lock folder");
  });

  it("removes the locks of a process that is gone", async () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(dir, "writer"), String(gone));
    writeFileSync(join(dir, `r-${gone}-aabbccdd`), "");
    assert.equal((await withLock(dir, "shared", async () => 1, FAST)).acquired, true);
    writeFileSync(join(dir, "writer"), String(gone));
    writeFileSync(join(dir, `r-${gone}-aabbccdd`), "");
    assert.equal((await withLock(dir, "exclusive", async () => 1, FAST)).acquired, true);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("removes a lock that is too old even when its pid is alive", async () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    const old = join(dir, `r-${process.pid}-00000000`);
    writeFileSync(old, "");
    const longAgo = new Date(Date.now() - 10_000);
    utimesSync(old, longAgo, longAgo);
    assert.equal((await withLock(dir, "exclusive", async () => 1, { ...FAST, staleMs: 1000 })).acquired, true);
    assert.equal(existsSync(old), false);
  });
});

describe("the cache functions with the lock", () => {
  let base;
  let path;
  const root = "/project";
  const options = { classesOnly: false, properties: false };
  const records = () => new Map([["a.kt", { rel: "a.kt", sig: "1:1", edges: [["a.kt#A", "b.kt#B", 0, 1, [3]]] }]]);
  const lockDir = () => `${path}.lock`;
  before(async () => {
    base = mkdtempSync(join(tmpdir(), "find-usages-cachelock-"));
    path = cachePath(base, root, options);
    assert.ok((await saveCache(path, root, options, records())) > 0);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it("reads the cache it wrote", async () => {
    assert.equal((await loadCache(path, root, options)).get("a.kt").edges[0][1], "b.kt#B");
  });

  it("does not clear or replace the cache while a read is in progress", async () => {
    const hold = gate();
    let reading = false;
    const reader = withLock(lockDir(), "shared", async () => {
      reading = true;
      await hold.wait;
    });
    await until(() => reading);
    await assert.rejects(clearCache(path, FAST), /in use/);
    assert.equal(await saveCache(path, root, options, records(), FAST), 0, "a save gives up instead of swapping the file");
    assert.deepEqual(readdirSync(base).filter((name) => name.endsWith(".tmp")), [], "and leaves no temporary file");
    assert.ok(existsSync(path));
    hold.open();
    await reader;
  });

  it("does not read the cache while it is being cleared", async () => {
    const hold = gate();
    let clearing = false;
    const clearer = withLock(lockDir(), "exclusive", async () => {
      clearing = true;
      await hold.wait;
    });
    await until(() => clearing);
    assert.equal(await loadCache(path, root, options, FAST), null, "a read that cannot get the lock sees no cache");
    hold.open();
    await clearer;
    assert.ok(await loadCache(path, root, options), "and reads it again once the lock is free");
  });

  it("clears the cache once, then reports that there is none", async () => {
    assert.equal(await clearCache(path), true);
    assert.equal(existsSync(path), false);
    assert.equal(await clearCache(path), false);
    assert.equal(await loadCache(path, root, options), null);
  });
});

describe("parallel runs of class-graph on one cache", { skip: !hasRg && "ripgrep not installed" }, () => {
  let base;
  let project;
  let cacheDir;
  before(() => {
    base = mkdtempSync(join(tmpdir(), "find-usages-parallel-"));
    project = join(base, "project");
    cacheDir = join(base, "cache");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "A.kt"), "package p\n\nclass A {\n    val b = B()\n}\n");
    writeFileSync(join(project, "src", "B.kt"), "package p\n\nclass B {\n    val c = C()\n}\n");
    writeFileSync(join(project, "src", "C.kt"), "package p\n\nclass C\n");
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const run = (...args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLASS_GRAPH, ...args, "--root", project, "--cache-dir", cacheDir], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => resolve({ code, out, err }));
    });
  const graphOf = (text) => {
    const { stats, ...graph } = JSON.parse(text);
    return JSON.stringify(graph);
  };

  it("end with exit 0, the same graph as without a cache, and one whole cache file", async () => {
    const reference = await run("B", "--format", "json", "--no-cache");
    assert.equal(reference.code, 0, reference.err);
    const jobs = [
      ...Array.from({ length: 4 }, () => ["B", "--format", "json"]),
      ...Array.from({ length: 2 }, () => ["B", "--format", "json", "--rebuild"]),
    ];
    const done = await Promise.all(jobs.map((args) => run(...args)));
    for (const job of done) {
      assert.equal(job.code, 0, job.err);
      assert.equal(graphOf(job.out), graphOf(reference.out));
    }
    const names = readdirSync(cacheDir);
    assert.equal(names.filter((name) => name.endsWith(".json")).length, 1);
    assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), []);
    assert.match((await run("B", "--format", "json", "--stats")).err, /cache: (hit|updated)/, "and the next run uses that cache");
  });

  it("stay correct when --clear-cache runs among them", async () => {
    const reference = await run("B", "--format", "json", "--no-cache");
    const jobs = [
      ["B", "--format", "json"],
      ["--clear-cache"],
      ["B", "--format", "json"],
      ["--clear-cache"],
      ["B", "--format", "json", "--rebuild"],
      ["B", "--format", "json"],
    ];
    const done = await Promise.all(jobs.map((args) => run(...args)));
    for (const [i, job] of done.entries()) {
      assert.equal(job.code, 0, `${jobs[i].join(" ")}: ${job.err}`);
      if (jobs[i][0] === "B") assert.equal(graphOf(job.out), graphOf(reference.out));
      else assert.match(job.out, /cache cleared|no cache to clear/);
    }
  });

  it("--clear-cache deletes the cache and a second one says there is none", async () => {
    assert.equal((await run("B", "--format", "json")).code, 0);
    const first = await run("--clear-cache");
    assert.match(first.out, /^cache cleared: /);
    assert.deepEqual(readdirSync(cacheDir).filter((name) => name.endsWith(".json")), []);
    assert.match((await run("--clear-cache")).out, /^no cache to clear/);
    const after = await run("B", "--format", "json", "--stats");
    assert.match(after.err, /cache: miss/);
  });
});
