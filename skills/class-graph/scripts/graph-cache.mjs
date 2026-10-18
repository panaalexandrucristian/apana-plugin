// Disk cache of the dependency graph (Node stdlib only). One JSON file per
// project root and option set, outside the repository, holding for every source
// file its signature (mtime and size), declarations, imports and the edges it
// contributes. It is valid only for the same root, options, cache format and
// version of the code that builds the graph; anything else reads as "no cache".
// The file is written to a temporary name and renamed, so a crashed or parallel
// run never leaves a half-written cache. Reading takes a shared lock and replacing
// or clearing the file an exclusive one (cache-lock.mjs): many reads at once, but
// a replace or a clear waits for the reads in progress and holds new ones back.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withLock } from "./cache-lock.mjs";

export const CACHE_FORMAT = 1;

/** Hash of the sources that decide what the graph contains: a change to them retires every cache. */
export const TOOL_HASH = createHash("sha1")
  .update(["graph.mjs", "kotlin-symbols.mjs", "lex.mjs"].map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).join("\0"))
  .digest("hex");

export function defaultCacheDir(env = process.env) {
  return env.FIND_USAGES_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "find-usages");
}

export function cachePath(dir, root, options) {
  return join(dir, `${createHash("sha1").update(`${root}\0${JSON.stringify(options)}`).digest("hex").slice(0, 16)}.json`);
}

const lockDir = (path) => `${path}.lock`;

/**
 * Map of path -> record for a cache valid for `root` and `options`, or null (also
 * when the lock could not be had within the timeout). `lock` overrides the lock
 * timings (see cache-lock.mjs).
 */
export async function loadCache(path, root, options, lock = {}) {
  try {
    const read = await withLock(lockDir(path), "shared", () => readRecords(path, root, options), lock);
    return read.acquired ? read.value : null;
  } catch {
    return null;
  }
}

/** The file has one JSON value per line (a header, then one record per file) and is read in chunks cut at line ends, so it is never held as one string. */
async function readRecords(path, root, options) {
  let stream;
  try {
    stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 16 });
    let header = null;
    const records = new Map();
    /** False when the header says the cache is not valid for this run. */
    const take = (line) => {
      if (header === null) {
        header = JSON.parse(line);
        return header.format === CACHE_FORMAT && header.tool === TOOL_HASH && header.root === root && JSON.stringify(header.options) === JSON.stringify(options);
      }
      if (line === "") return true;
      const record = JSON.parse(line);
      record.edges = record.edges.map(([from, to, tier, count, edgeLines]) => [from, header.ids[to], tier, count, edgeLines]);
      records.set(record.rel, record);
      return true;
    };
    let rest = "";
    for await (const chunk of stream) {
      let from = 0;
      for (let end = chunk.indexOf("\n", from); end >= 0; end = chunk.indexOf("\n", from)) {
        const line = rest === "" ? chunk.slice(from, end) : rest + chunk.slice(from, end);
        rest = "";
        from = end + 1;
        if (!take(line)) return null;
      }
      if (from < chunk.length) rest += chunk.slice(from);
    }
    if (rest !== "" && !take(rest)) return null;
    return header === null ? null : records;
  } catch {
    return null;
  } finally {
    stream?.destroy();
  }
}

/** Write the records atomically, one line each; returns the size in bytes, or 0 when the cache could not be written. */
export async function saveCache(path, root, options, records, lock = {}) {
  let handle;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const ids = [];
    const index = new Map();
    for (const record of records.values()) {
      for (const edge of record.edges) {
        if (!index.has(edge[1])) {
          index.set(edge[1], ids.length);
          ids.push(edge[1]);
        }
      }
    }
    await mkdir(join(path, ".."), { recursive: true });
    handle = await open(temporary, "w");
    let bytes = 0;
    const put = async (text) => {
      bytes += text.length;
      await handle.write(text);
    };
    await put(`${JSON.stringify({ format: CACHE_FORMAT, tool: TOOL_HASH, root, options, ids })}\n`);
    let batch = [];
    for (const record of records.values()) {
      const encoded = { ...record, edges: record.edges.map(([from, to, tier, count, lines]) => [from, index.get(to), tier, count, lines]) };
      batch.push(JSON.stringify(encoded));
      if (batch.length >= 200) {
        await put(`${batch.join("\n")}\n`);
        batch = [];
      }
    }
    if (batch.length > 0) await put(`${batch.join("\n")}\n`);
    await handle.close();
    handle = null;
    const swapped = await withLock(lockDir(path), "exclusive", () => rename(temporary, path), lock); // only the swap is exclusive, not the writing
    if (!swapped.acquired) throw new Error("cache lock is busy");
    return bytes;
  } catch {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    return 0;
  }
}

/** Remove the cache file under the exclusive lock; true when there was one. Throws when the lock stays busy. */
export async function clearCache(path, lock = {}) {
  try {
    await stat(path);
  } catch {
    return false;
  }
  const cleared = await withLock(lockDir(path), "exclusive", () => rm(path, { force: true }), lock);
  if (!cleared.acquired) throw new Error(`the cache is in use (lock ${lockDir(path)} stayed busy)`);
  return true;
}
