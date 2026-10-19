#!/usr/bin/env node
// variant-check helper: lists every distinct text that a regular expression matches in real data files, with the
// number of occurrences and where each variant first appears. Reads files only; writes nothing; no network, no model.
//
//   node variants.mjs [--top N] [--ignore-case] PATTERN PATH...
//
// PATTERN is a JavaScript regular expression (no delimiters). PATH is a file or a folder (searched recursively;
// .git and node_modules are skipped, and so is any file with a NUL byte in its first 8 KB). Exit 0 on success,
// also when nothing matches; exit 2 on a usage error, an invalid pattern or when no PATH can be read.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TOP = 30;
const SHOW_CHARS = 120;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** The files under one PATH, in a stable order. A missing or unreadable PATH is returned in `unreadable`. */
export function collectFiles(paths) {
  const files = [];
  const unreadable = [];
  const walk = (path) => {
    let info;
    try {
      info = statSync(path);
    } catch {
      unreadable.push(path);
      return;
    }
    if (info.isDirectory()) {
      let names;
      try {
        names = readdirSync(path).sort();
      } catch {
        unreadable.push(path);
        return;
      }
      for (const name of names) if (!SKIP_DIRS.has(name)) walk(join(path, name));
    } else if (info.isFile()) {
      files.push(path);
    }
  };
  for (const path of paths) walk(path);
  return { files, unreadable };
}

function looksBinary(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Count the distinct matches of `regex` (it must carry the g flag) over the lines of `files`.
 * Returns { variants: [{ text, count, first }], total, emptyMatches, filesRead, filesSkipped } with the variants
 * sorted by count (most first), then by text. `first` is "path:line" of the first occurrence.
 */
export function countVariants(regex, files) {
  const seen = new Map();
  let total = 0;
  let emptyMatches = 0;
  let filesRead = 0;
  let filesSkipped = 0;
  for (const file of files) {
    let text;
    try {
      if (looksBinary(file)) {
        filesSkipped += 1;
        continue;
      }
      text = readFileSync(file, "utf8");
    } catch {
      filesSkipped += 1;
      continue;
    }
    filesRead += 1;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index].matchAll(regex)) {
        if (match[0] === "") {
          emptyMatches += 1;
          continue;
        }
        total += 1;
        const entry = seen.get(match[0]);
        if (entry) entry.count += 1;
        else seen.set(match[0], { text: match[0], count: 1, first: `${file}:${index + 1}` });
      }
    }
  }
  const variants = [...seen.values()].sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return { variants, total, emptyMatches, filesRead, filesSkipped };
}

/** A variant as one readable token: JSON-escaped, so tabs, line breaks and odd spaces are visible; long ones cut. */
export function showVariant(text) {
  const escaped = JSON.stringify(text);
  return escaped.length > SHOW_CHARS ? `${escaped.slice(0, SHOW_CHARS - 1)}…` : escaped;
}

export function render(result, top) {
  const { variants, total, emptyMatches, filesRead, filesSkipped } = result;
  const notes = [];
  if (emptyMatches) notes.push(`${emptyMatches} empty matches ignored`);
  if (filesSkipped) notes.push(`${filesSkipped} files skipped (binary or unreadable)`);
  const head = `${total} matches, ${variants.length} distinct variants, ${filesRead} files read${notes.length ? ` (${notes.join("; ")})` : ""}`;
  const rows = variants.slice(0, top).map((v) => `${String(v.count).padStart(7)}  ${showVariant(v.text)}  first: ${v.first}`);
  if (variants.length > top) rows.push(`        … ${variants.length - top} more variants (raise --top)`);
  return [head, ...rows].join("\n");
}

function usage(message) {
  process.stderr.write(`${message}\nusage: node variants.mjs [--top N] [--ignore-case] PATTERN PATH...\n`);
  process.exit(2);
}

function main(argv) {
  let top = DEFAULT_TOP;
  let ignoreCase = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ignore-case") ignoreCase = true;
    else if (arg === "--top") {
      const value = argv[i + 1];
      if (!/^[1-9]\d*$/.test(value ?? "")) usage("--top needs a positive whole number");
      top = Number(value);
      i += 1;
    } else rest.push(arg);
  }
  if (rest.length < 2) usage("a PATTERN and at least one PATH are required");
  const [pattern, ...paths] = rest;
  let regex;
  try {
    regex = new RegExp(pattern, ignoreCase ? "gi" : "g");
  } catch (error) {
    usage(`invalid pattern: ${error.message}`);
  }
  const { files, unreadable } = collectFiles(paths);
  for (const path of unreadable) process.stderr.write(`cannot read: ${path}\n`);
  if (files.length === 0) usage("no readable file under the given PATHs");
  process.stdout.write(`${render(countVariants(regex, files), top)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
