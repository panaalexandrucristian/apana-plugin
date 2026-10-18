// Readers-writer lock for the graph cache (Node stdlib only). Any number of
// readers may hold it at once. The writer (a replace or a clear of the cache file)
// holds it alone: it keeps new readers out the moment it asks, waits for the
// readers that are already in, and only then touches the file.
//
// The lock is a folder next to the cache file:
//   writer        exists while a writer holds or waits for the lock (its pid inside)
//   r-<pid>-<id>  one file per reader
// A reader writes its file and then looks for the writer; the writer writes its
// file and then looks for readers. Each looks after writing, so at least one of
// them sees the other and steps back or waits. A holder whose process is gone, or
// whose file is older than `staleMs`, is stale and is removed by whoever finds it.
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_DEFAULTS = Object.freeze({ timeoutMs: 30_000, staleMs: 120_000, pollMs: 20 });

const WRITER = "writer";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // a process of another user is still a live process
  }
}

/** True when `name` is held by a live process that took it recently; a stale file is removed. `pid` is NaN when it could not be read yet. */
async function held(dir, name, pid, staleMs) {
  try {
    const info = await stat(join(dir, name));
    if ((Number.isNaN(pid) || alive(pid)) && Date.now() - info.mtimeMs <= staleMs) return true;
  } catch {
    return false; // gone meanwhile
  }
  await rm(join(dir, name), { force: true });
  return false;
}

async function writerHeld(dir, staleMs) {
  let text;
  try {
    text = await readFile(join(dir, WRITER), "utf8");
  } catch {
    return false;
  }
  return held(dir, WRITER, Number.parseInt(text, 10), staleMs); // an empty file is a writer that has not written its pid yet
}

async function readersHeld(dir, staleMs) {
  let any = false;
  for (const name of await readdir(dir)) {
    const match = /^r-(\d+)-/.exec(name);
    if (match && (await held(dir, name, Number(match[1]), staleMs))) any = true;
  }
  return any;
}

async function acquireShared(dir, settings) {
  const mine = join(dir, `r-${process.pid}-${randomBytes(4).toString("hex")}`);
  const deadline = Date.now() + settings.timeoutMs;
  await mkdir(dir, { recursive: true });
  for (;;) {
    if (!(await writerHeld(dir, settings.staleMs))) {
      await writeFile(mine, "");
      if (!(await writerHeld(dir, settings.staleMs))) return () => rm(mine, { force: true });
      await rm(mine, { force: true }); // a writer came in meanwhile: step back so it is not starved
    }
    if (Date.now() >= deadline) return null;
    await sleep(settings.pollMs);
  }
}

async function acquireExclusive(dir, settings) {
  const marker = join(dir, WRITER);
  const deadline = Date.now() + settings.timeoutMs;
  await mkdir(dir, { recursive: true });
  for (;;) {
    try {
      const handle = await open(marker, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await writerHeld(dir, settings.staleMs); // clears a stale marker
    }
    if (Date.now() >= deadline) return null;
    await sleep(settings.pollMs);
  }
  const release = () => rm(marker, { force: true });
  while (await readersHeld(dir, settings.staleMs)) {
    if (Date.now() >= deadline) {
      await release();
      return null;
    }
    await sleep(settings.pollMs);
  }
  return release;
}

/**
 * Run `work` while holding the lock in `dir`: mode "shared" (readers) or "exclusive"
 * (the writer). Resolves to {acquired: true, value}, or {acquired: false} when the
 * lock could not be had within `timeoutMs`. Options: timeoutMs, staleMs, pollMs.
 */
export async function withLock(dir, mode, work, options = {}) {
  const settings = { ...LOCK_DEFAULTS, ...options };
  const release = await (mode === "exclusive" ? acquireExclusive : acquireShared)(dir, settings);
  if (!release) return { acquired: false };
  try {
    return { acquired: true, value: await work() };
  } finally {
    await release();
  }
}
