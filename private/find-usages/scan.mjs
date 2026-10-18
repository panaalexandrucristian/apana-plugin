// Candidate files for the usage scan: ripgrep lists the source files that contain
// any of the words, so only those files are read afterwards. Node stdlib only.
import { spawn } from "node:child_process";

export const SOURCE_GLOBS = Object.freeze(["*.kt", "*.java", "*.xml"]);

/** Paths (relative to `root`, NUL-separated by ripgrep) of source files containing any of `words` as a whole word. */
export function candidateFiles(root, words, { globs = SOURCE_GLOBS } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "--files-with-matches",
      "--null",
      "--word-regexp",
      "--fixed-strings",
      "--no-messages",
      "--no-require-git",
      ...globs.flatMap((glob) => ["--glob", glob]),
      ...words.flatMap((word) => ["-e", word]),
      "--",
      ".",
    ];
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    const files = [];
    let rest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const parts = (rest + chunk).split("\0");
      rest = parts.pop();
      for (const part of parts) files.push(part.replace(/^\.\//, ""));
    });
    child.on("error", (error) => reject(error.code === "ENOENT" ? new Error("ripgrep (rg) is required but was not found on PATH") : error));
    child.on("close", () => resolve(files));
  });
}

/** Paths (relative to `root`) of all files matching the globs, as ripgrep lists them (ignore files respected). */
export function projectFiles(root, globs) {
  return new Promise((resolve, reject) => {
    const args = ["--files", "--null", "--no-messages", "--no-require-git", ...globs.flatMap((glob) => ["--glob", glob]), "--", "."];
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    const files = [];
    let rest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const parts = (rest + chunk).split("\0");
      rest = parts.pop();
      for (const part of parts) files.push(part.replace(/^\.\//, ""));
    });
    child.on("error", (error) => reject(error.code === "ENOENT" ? new Error("ripgrep (rg) is required but was not found on PATH") : error));
    child.on("close", () => resolve(files.sort()));
  });
}

/** Run `work(item)` over `items` with at most `limit` in flight. */
export async function forEachPooled(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
