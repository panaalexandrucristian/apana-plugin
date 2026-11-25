#!/usr/bin/env node
// diff-target: the facts about the diff that /apana:review-diff reviews, in ONE read-only command: the files (new ones included, also the ones git does not track yet),
// every hunk as file:line, whether the target is on the current branch, the sibling worktree path when it is not, merge and root commits, the requirement text
// (commit message, PR title and body, or the branch name) and, for a PR, owner/repo for `gh -R`.
//   node diff-target.mjs uncommitted | commit <sha> | pr <number> | ref <ref>
// `ref` is one diff of the working tree against the merge base of <ref> and HEAD (what is committed, what is not, and the untracked files). `pr` needs `gh`; nothing is written anywhere.
//   node diff-target.mjs [-C <dir>] snapshot <target>                   the same, plus a manifest of the reviewed state and its digest (-C: run in <dir>, as git -C)
//   node diff-target.mjs verify sha256:<hex>|expected:<hex> <target>   read the state again and compare it with a snapshot or with an expected state
//   node diff-target.mjs expect sha256:<hex> <edits.json> <target>     check a batch of exact replacements against a snapshot; print the state they must give
// The manifest holds the checkout, HEAD, the fixed revisions of the comparison, the patch, the index and the type and SHA-256 of every file of the diff, every file
// changed in the checkout and every untracked file. Everything is read twice and must agree; a match is not atomic with any later read or write.
// Exit codes: 0 ok, 2 bad arguments, 3 refused (not a git repository, no commit, not a commit, a merge or root commit for a snapshot, no common ancestor, origin not on
// github.com, gh missing or failing, a PR diff that cannot be bound to its commits, a patch it cannot parse whole, a file it cannot read, a checkout that changed while
// it was read), 4 the checkout does not match the digest, 5 expect refused some edits.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

class Usage extends Error {}
class Refusal extends Error {}

const USAGE = [
  "usage: diff-target.mjs [-C <dir>] [snapshot] <target>",
  "       diff-target.mjs [-C <dir>] verify sha256:<hex>|expected:<hex> <target>",
  "       diff-target.mjs [-C <dir>] expect sha256:<hex> <edits.json> <target>",
  "<target>: uncommitted | commit <sha> | pr <number> | ref <ref>",
].join("\n");
const MAX_BUFFER = 1 << 30;
const REQUIREMENT_LINES = 40;
const BINARY_SNIFF_BYTES = 8000;
const ARGUMENTS_OF = { uncommitted: 0, commit: 1, pr: 1, ref: 1 };
const SNAPSHOT_FORMAT = "review-diff-snapshot/1";
const MISMATCH = 4;
const EDITS_REFUSED = 5;
// -U0 so that git reports the runs of changed lines itself; explicit prefixes and -M so that a user's diff.noprefix, diff.mnemonicPrefix or diff.renames cannot change what is parsed;
// diff.autoRefreshIndex=false so that a diff of the working tree does not rewrite the index; no external diff and no textconv, so that the patch is of the bytes themselves
const DIFF = ["-c", "core.quotePath=false", "-c", "diff.autoRefreshIndex=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U0", "--src-prefix=a/", "--dst-prefix=b/"];

/** The numbers of one `@@ -a[,b] +c[,d] @@` header (a missing count is 1), or null when the line is not a plain two-sided header. */
export function parseHunkHeader(line) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4] };
}

const ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };

/** A path as git prints it: in double quotes it has C escapes (\" \\ \t \n and \NNN octal bytes of UTF-8); any other text is returned as it is. */
export function unquotePath(text) {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const chars = Array.from(text.slice(1, -1));
  const bytes = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") { bytes.push(...Buffer.from(chars[i])); continue; }
    const octal = /^[0-7]{3}$/.exec(chars.slice(i + 1, i + 4).join(""));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; } else if (Object.hasOwn(ESCAPES, chars[i + 1])) { bytes.push(ESCAPES[chars[++i]]); } else { bytes.push(92); }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** owner/repo of a github.com remote URL (https with or without .git and credentials, git@github.com:o/r, ssh://), or null for any other URL. */
export function parseRemote(url) {
  const name = "([\\w.-]+)/([\\w.-]+?)(?:\\.git)?/?$";
  const m = new RegExp(`^(?:https?://(?:[^@/]+@)?github\\.com/|git@github\\.com:|ssh://(?:[^@/]+@)?github\\.com(?::\\d+)?/)${name}`).exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const quotedEnd = (text) => { for (let i = 1; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') return i; } return -1; };
const withoutPrefix = (p) => (/^[ab]\//.test(p) ? p.slice(2) : null);

/** The old and new path of a `diff --git a/x b/y` line (the text after `diff --git `), or null where the line alone cannot tell (a renamed name with a space). */
function pathsOfDiffLine(rest) {
  let first;
  let second;
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest);
    if (end < 0) return null;
    first = unquotePath(rest.slice(0, end + 1));
    second = unquotePath(rest.slice(end + 2));
  } else if (rest.indexOf(' "b/') > 0) {
    first = rest.slice(0, rest.indexOf(' "b/'));
    second = unquotePath(rest.slice(rest.indexOf(' "b/') + 1));
  } else {
    // without a rename both names are the same, so "a/P b/P" has 2 * |P| + 5 characters
    const n = (rest.length - 5) / 2;
    if (!Number.isInteger(n) || n < 1 || rest.slice(2 + n, 5 + n) !== " b/" || rest.slice(2, 2 + n) !== rest.slice(rest.length - n)) return null;
    first = rest.slice(0, 2 + n);
    second = rest.slice(3 + n);
  }
  const [oldPath, newPath] = [withoutPrefix(first), withoutPrefix(second)];
  return oldPath !== null && newPath !== null ? { oldPath, newPath } : null;
}

/** The path on a `--- ` or `+++ ` line (git adds a tab after a name with a space), or null for /dev/null. */
function markerPath(text) {
  const raw = text.startsWith('"') ? text : text.replace(/\t.*$/, "");
  return raw === "/dev/null" ? null : (withoutPrefix(unquotePath(raw)) ?? unquotePath(raw));
}

/**
 * The files of a unified diff, with the runs of changed lines of each as hunks {kind: add|delete|change, oldStart, oldCount, newStart, newCount}.
 * A hunk with context lines is split at them, so the hunks are the same as with -U0 (an add reports the old line before it, a delete the new line before it).
 * `unparsed` holds the lines it did not understand (combined diffs) and every hunk whose body does not have the lines its header counts (a cut patch); they are reported, not dropped.
 */
export function parsePatch(patch) {
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const files = [];
  const unparsed = [];
  let section = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  let removed = 0;
  let added = 0;
  let runOld = 0;
  let runNew = 0;

  const flush = () => {
    if (section && (removed || added)) {
      section.hunks.push({ kind: removed && added ? "change" : added ? "add" : "delete", oldStart: removed ? runOld : runOld - 1, oldCount: removed, newStart: added ? runNew : runNew - 1, newCount: added });
    }
    removed = added = 0;
  };
  const open = () => { if (!removed && !added) { runOld = oldLine; runNew = newLine; } };
  const endHunk = () => {
    flush();
    if (hunk && (hunk.oldLeft || hunk.newLeft)) unparsed.push(`${hunk.header} (cut: ${hunk.oldLeft} old and ${hunk.newLeft} new lines missing)`);
    hunk = null;
  };
  const close = () => {
    endHunk();
    if (!section) return;
    const path = section.renameTo ?? section.plus ?? section.minus ?? section.fromLine?.newPath ?? null;
    if (path === null) unparsed.push(`diff --git (no path): ${section.header}`);
    else files.push({ path, oldPath: section.status === "R" ? (section.renameFrom ?? section.fromLine?.oldPath ?? null) : null, status: section.status, binary: section.binary, hunks: section.hunks });
    section = null;
  };

  for (const row of rows) {
    if (row.startsWith("diff --git ")) {
      close();
      section = { header: row, fromLine: pathsOfDiffLine(row.slice(11)), status: "M", binary: false, hunks: [], hunked: false, renameFrom: null, renameTo: null, minus: null, plus: null };
    } else if (row.startsWith("diff --cc ") || row.startsWith("diff --combined ") || row.startsWith("@@@")) {
      if (row.startsWith("@@@")) endHunk(); else close();
      unparsed.push(row);
    } else if (row.startsWith("@@")) {
      endHunk();
      const header = section ? parseHunkHeader(row) : null;
      if (!header) { unparsed.push(row); continue; }
      oldLine = header.oldCount === 0 ? header.oldStart + 1 : header.oldStart;
      newLine = header.newCount === 0 ? header.newStart + 1 : header.newStart;
      hunk = { header: row, oldLeft: header.oldCount, newLeft: header.newCount };
      section.hunked = true;
    } else if (hunk) {
      if (row.startsWith("\\")) continue; // "\ No newline at end of file"
      const context = row[0] === " " || row === "";
      const fits = context ? hunk.oldLeft > 0 && hunk.newLeft > 0 : row[0] === "-" ? hunk.oldLeft > 0 : row[0] === "+" && hunk.newLeft > 0;
      if (!fits) { unparsed.push(row); continue; }
      if (row[0] === "-") { open(); removed++; oldLine++; hunk.oldLeft--; }
      else if (row[0] === "+") { open(); added++; newLine++; hunk.newLeft--; }
      else { flush(); oldLine++; newLine++; hunk.oldLeft--; hunk.newLeft--; }
      if (!hunk.oldLeft && !hunk.newLeft) endHunk();
    } else if (section) {
      // after a hunk, only another hunk, the no-newline marker or a blank line may follow; anything else is a line a header did not count
      if (section.hunked) { if (row !== "" && !row.startsWith("\\")) unparsed.push(row); }
      else if (row.startsWith("new file mode")) section.status = "A";
      else if (row.startsWith("deleted file mode")) section.status = "D";
      else if (row.startsWith("rename from ")) { section.status = "R"; section.renameFrom = unquotePath(row.slice(12)); }
      else if (row.startsWith("rename to ")) { section.status = "R"; section.renameTo = unquotePath(row.slice(10)); }
      else if (row.startsWith("--- ")) section.minus = markerPath(row.slice(4));
      else if (row.startsWith("+++ ")) section.plus = markerPath(row.slice(4));
      else if (row.startsWith("Binary files ") || row.startsWith("GIT binary patch")) section.binary = true;
    }
  }
  close();
  return { files, unparsed };
}

const firstLine = (text) => text.trim().split("\n")[0].slice(0, 200);
const short = (sha) => sha.slice(0, 8);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function git(cwd, args) {
  const done = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (done.error) throw new Refusal(`git could not run: ${done.error.message}`);
  return done;
}

function gitText(cwd, args, what) {
  const done = git(cwd, args);
  if (done.status !== 0) throw new Refusal(`git ${what}: ${firstLine(done.stderr)}`);
  return done.stdout;
}

/** The exact bytes git printed; output cut at the buffer limit is a refusal, not a shorter answer. */
function gitBytes(cwd, args, what) {
  const done = spawnSync("git", args, { cwd, maxBuffer: MAX_BUFFER });
  if (done.error) throw new Refusal(`git could not run: ${done.error.message}`);
  if (done.status !== 0) throw new Refusal(`git ${what}: ${firstLine(done.stderr.toString("utf8"))}`);
  return done.stdout;
}

const diffBytes = (root, revisions) => gitBytes(root, [...DIFF, ...revisions, "--"], "diff");

/** The paths of a NUL-separated list; a path that is not valid UTF-8 cannot be named exactly, so it refuses. */
function decodePaths(bytes, what) {
  let text;
  try { text = strictUtf8.decode(bytes); } catch { throw new Refusal(`a path among the ${what} is not valid UTF-8`); }
  return text.split("\0").filter(Boolean);
}

function resolveCommit(root, rev) {
  const done = git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (done.status !== 0) throw new Refusal(`not a commit: ${rev}`);
  return done.stdout.trim();
}

const isAncestorOfHead = (root, sha) => git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]).status === 0;

function mergeBaseOf(root, a, b, what) {
  const done = git(root, ["merge-base", a, b]);
  if (done.status !== 0) throw new Refusal(`no common ancestor of ${what}`);
  return done.stdout.trim();
}

/** The entry of a file git does not track yet, from its bytes: one `add` hunk of all its lines, or none for an empty or binary file (a symbolic link is one line). */
function untrackedEntry(path, kind, bytes) {
  const file = { path, oldPath: null, status: "A", binary: false, hunks: [], untracked: true, note: null };
  let lineCount = 0;
  if (kind === "link") lineCount = 1;
  else if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) file.binary = true;
  else if (bytes.length > 0) lineCount = bytes.reduce((n, byte) => n + (byte === 10 ? 1 : 0), 0) + (bytes.at(-1) === 10 ? 0 : 1);
  if (lineCount > 0) file.hunks.push({ kind: "add", oldStart: 0, oldCount: 0, newStart: 1, newCount: lineCount });
  return file;
}

/** An untracked file for the inventory, as a diff of an empty file against it; what cannot be read is listed without hunks. */
function untrackedFile(root, path) {
  let info;
  try { info = lstatSync(join(root, path)); } catch { return untrackedEntry(path, "file", Buffer.alloc(0)); }
  if (info.isSymbolicLink()) return untrackedEntry(path, "link");
  if (info.isDirectory()) return { ...untrackedEntry(path, "file", Buffer.alloc(0)), note: "directory not read" };
  if (!info.isFile()) return { ...untrackedEntry(path, "file", Buffer.alloc(0)), note: "not a regular file" };
  return untrackedEntry(path, "file", readFileSync(join(root, path)));
}

/** `git diff <base>` (the working tree against base) parsed, plus the untracked files. */
function workingTreeDiff(root, base) {
  const parsed = parsePatch(diffBytes(root, [base]).toString("utf8"));
  const untracked = decodePaths(gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z"], "ls-files"), "untracked files");
  return { files: [...parsed.files, ...untracked.map((path) => untrackedFile(root, path))], unparsed: parsed.unparsed };
}

function requirement(label, text) {
  const rows = text.replace(/\r\n?/g, "\n").trim().split("\n").map((row) => row.trimEnd());
  const shown = rows.slice(0, REQUIREMENT_LINES).map((row) => (row ? `  ${row}` : ""));
  if (rows.length > REQUIREMENT_LINES) shown.push("  (truncated)");
  return { label, rows: shown };
}

function currentBranchRequirement(root) {
  const name = gitText(root, ["branch", "--show-current"], "branch").trim();
  return requirement("branch name", name || "(detached HEAD)");
}

function uncommitted(root) {
  return { what: "uncommitted changes", diff: "git diff HEAD, plus untracked files", onBranch: "yes", requirement: currentBranchRequirement(root), ...workingTreeDiff(root, "HEAD") };
}

function againstRef(root, ref) {
  const base = mergeBaseOf(root, resolveCommit(root, ref), "HEAD", `${ref} and HEAD`);
  return { what: `ref ${ref}`, diff: `git diff ${base}, plus untracked files`, onBranch: "yes", requirement: currentBranchRequirement(root), ...workingTreeDiff(root, base) };
}

function commitTarget(root, rev) {
  const sha = resolveCommit(root, rev);
  const what = `commit ${short(sha)}`;
  const onBranch = isAncestorOfHead(root, sha) ? "yes" : "no";
  const worktree = onBranch === "yes" ? null : `../${basename(root)}-review-${short(sha)}`;
  const message = requirement("commit message", gitText(root, ["show", "-s", "--format=%B", sha], "show"));
  const parents = gitText(root, ["rev-list", "--parents", "-n", "1", sha], "rev-list").trim().split(" ").length - 1;
  if (parents !== 1) return { what, sha, special: parents === 0 ? "root" : "merge", onBranch, worktree, requirement: message, files: [], unparsed: [] };
  const patch = diffBytes(root, [`${sha}^`, sha]);
  return { what, sha, patch, diff: `git diff ${sha}^..${sha}`, onBranch, worktree, requirement: message, ...parsePatch(patch.toString("utf8")) };
}

function gh(root, args) {
  const done = spawnSync("gh", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (done.error) throw new Refusal(`gh could not run: ${done.error.message}`);
  if (done.status !== 0) throw new Refusal(`gh ${args.slice(0, 5).join(" ")}: ${firstLine(done.stderr)}`);
  return done.stdout;
}

function githubRepo(root) {
  const remote = git(root, ["remote", "get-url", "origin"]);
  if (remote.status !== 0) throw new Refusal("no origin remote");
  const repo = parseRemote(remote.stdout);
  if (!repo) throw new Refusal("origin is not a github.com remote");
  return repo;
}

function prView(root, number, repo, fields) {
  try { return JSON.parse(gh(root, ["pr", "view", number, "-R", repo, "--json", fields])); } catch (error) {
    if (error instanceof SyntaxError) throw new Refusal(`gh pr view ${number} -R ${repo}: the answer is not JSON`);
    throw error;
  }
}

const commitId = (value) => (typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value) ? value : null);

function prFacts(root, number, repo, view) {
  const head = commitId(view.headRefOid);
  const onBranch = head && git(root, ["cat-file", "-e", `${head}^{commit}`]).status === 0 ? (isAncestorOfHead(root, head) ? "yes" : "no") : "unknown";
  const text = [view.title ?? "", view.body ?? ""].map((part) => part.trim()).filter(Boolean).join("\n\n");
  return { what: `PR #${number}`, repo, onBranch, worktree: onBranch === "yes" ? null : `../${basename(root)}-review-pr${number}`, requirement: requirement("PR title and body", text) };
}

function prTarget(root, number) {
  const repo = githubRepo(root);
  const view = prView(root, number, repo, "title,body,headRefOid,baseRefName");
  const parsed = parsePatch(gh(root, ["pr", "diff", number, "-R", repo, "--color", "never"]));
  return { ...prFacts(root, number, repo, view), diff: `gh pr diff ${number} -R ${repo}`, ...parsed };
}

function fileRow(file) {
  const tags = [];
  if (file.untracked) tags.push("untracked");
  if (file.binary) tags.push("binary");
  else if (file.note) tags.push(file.note);
  else if (file.hunks.length === 0) tags.push("no line changes");
  return `  ${file.status} ${file.oldPath ? `${file.oldPath} -> ` : ""}${file.path}${tags.length ? ` (${tags.join(", ")})` : ""}`;
}

function hunkRow(path, h) {
  const detail = { change: `old ${h.oldStart},${h.oldCount} new ${h.newStart},${h.newCount}`, add: `new ${h.newStart},${h.newCount}`, delete: `old ${h.oldStart},${h.oldCount}` }[h.kind];
  return `  ${path}:${h.newStart} ${h.kind} ${detail}`;
}

/** The text printed for a target: a summary line first, then the facts, then the requirement, then the files and the hunks (the longest part, last). */
function render(target) {
  const hunks = target.files.flatMap((file) => file.hunks.map((h) => hunkRow(file.path, h)));
  const summary = target.special ? `${target.special} commit, not diffed` : `files ${target.files.length}, hunks ${hunks.length}`;
  const out = [`diff-target: ${target.what}: ${summary}`];
  if (target.digest) out.push(`snapshot: sha256:${target.digest}`);
  if (target.diff) out.push(`diff: ${target.diff}`);
  out.push(`on current branch: ${target.onBranch}`);
  if (target.worktree) out.push(`worktree: ${target.worktree}`);
  if (target.special) out.push(`special: ${target.special}`);
  if (target.repo) out.push(`repo: ${target.repo}`);
  if (target.localChanges) out.push(`local changes: ${target.localChanges.length ? `${target.localChanges.length} (${target.localChanges.slice(0, 20).map((p) => JSON.stringify(p)).join(", ")}${target.localChanges.length > 20 ? ", ..." : ""})` : "none"}`);
  if (target.unparsed.length) out.push(`unparsed: ${target.unparsed.length} lines not understood (a combined diff or a cut patch?)`);
  out.push(`requirement (${target.requirement.label}):`, ...target.requirement.rows);
  if (target.files.length) out.push("files:", ...target.files.map(fileRow));
  if (hunks.length) out.push("hunks:", ...hunks);
  if (target.manifest) out.push("manifest:", ...target.manifest.map((line) => `  ${line}`));
  return `${out.join("\n")}\n`;
}

// ---- snapshot: the reviewed state as a manifest, read twice ----

/** A patch the snapshot relies on: every line understood and every path exact, or a refusal. */
function parseWhole(patch, what) {
  const parsed = parsePatch(patch.toString("utf8"));
  if (parsed.unparsed.length) throw new Refusal(`${what} has ${parsed.unparsed.length} lines that cannot be parsed (a combined diff or a cut patch): its files and hunks cannot be confirmed`);
  const bad = parsed.files.find((file) => `${file.path}${file.oldPath ?? ""}`.includes("�"));
  if (bad) throw new Refusal(`a path in ${what} is not valid UTF-8: ${bad.path}`);
  return parsed;
}

const filesKey = (files) => files.map((f) => JSON.stringify([f.status, f.oldPath, f.path, f.binary, f.hunks.map((h) => [h.kind, h.oldStart, h.oldCount, h.newStart, h.newCount])])).sort().join("\n");
const pathsOf = (files) => files.flatMap((file) => [file.path, file.oldPath].filter((p) => p !== null));

/** The part of the reviewed state that does not depend on the checkout's files: the revisions of the comparison and, for a commit or a PR, its patch. */
function fixedPart(root, mode, arg) {
  const head = resolveCommit(root, "HEAD");
  const fixed = { root, mode, head, newRev: null, prBase: null, patch: null, parsed: null };
  if (mode === "uncommitted") return { ...fixed, label: "uncommitted", base: head, view: { what: "uncommitted changes", diff: "git diff HEAD, plus untracked files", onBranch: "yes", requirement: currentBranchRequirement(root) } };
  if (mode === "ref") {
    const base = mergeBaseOf(root, resolveCommit(root, arg), head, `${arg} and HEAD`);
    return { ...fixed, label: `ref ${JSON.stringify(arg)}`, base, view: { what: `ref ${arg}`, diff: `git diff ${base}, plus untracked files`, onBranch: "yes", requirement: currentBranchRequirement(root) } };
  }
  if (mode === "commit") {
    const { patch, sha, special, files, unparsed, ...view } = commitTarget(root, arg);
    if (special) throw new Refusal(`${view.what} is a ${special} commit, which is not diffed: ask what to compare`);
    return { ...fixed, label: `commit ${sha}`, base: resolveCommit(root, `${sha}^`), newRev: sha, patch, parsed: parseWhole(patch, `git diff ${sha}^..${sha}`), view };
  }
  const repo = githubRepo(root);
  const before = prView(root, arg, repo, "title,body,headRefOid,baseRefName,baseRefOid");
  const remote = parsePatch(gh(root, ["pr", "diff", arg, "-R", repo, "--color", "never"]));
  const after = prView(root, arg, repo, "headRefOid,baseRefOid");
  const [newRev, prBase] = [commitId(before.headRefOid), commitId(before.baseRefOid)];
  if (!newRev || !prBase) throw new Refusal(`gh pr view ${arg} -R ${repo}: no head or base commit`);
  if (after.headRefOid !== newRev || after.baseRefOid !== prBase) throw new Refusal(`PR #${arg} moved while it was being read; run the command again`);
  const missing = [newRev, prBase].filter((sha) => git(root, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0);
  if (missing.length) throw new Refusal(`commit ${missing.map(short).join(" and ")} of PR #${arg} is not in this repository: git fetch origin pull/${arg}/head ${before.baseRefName ?? "<base branch>"}, then run the command again`);
  const base = mergeBaseOf(root, prBase, newRev, `the head and the base of PR #${arg}`);
  const patch = diffBytes(root, [base, newRev]);
  const parsed = parseWhole(patch, `git diff ${base} ${newRev}`);
  if (remote.unparsed.length || filesKey(remote.files) !== filesKey(parsed.files)) {
    throw new Refusal(`gh pr diff ${arg} -R ${repo} does not match git diff ${short(base)} ${short(newRev)}: the PR diff cannot be bound to its commits`);
  }
  const view = { ...prFacts(root, arg, repo, before), diff: `git diff ${base} ${newRev} (the PR's merge base and head; gh pr diff ${arg} -R ${repo} gives the same files and hunks)` };
  return { ...fixed, label: `pr ${arg} ${repo}`, base, newRev, prBase, patch, parsed, view };
}

/** What a path holds in the checkout: absent, a file (exec when executable) or a symbolic link, each with the SHA-256 of its bytes; a read that fails is a refusal, not an absence. */
function pathState(root, path) {
  const full = join(root, path);
  let info;
  try { info = lstatSync(full); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { state: "absent", kind: "absent", bytes: null };
    throw new Refusal(`cannot read ${path}: ${error.code ?? error.message}`);
  }
  const kind = info.isSymbolicLink() ? "link" : info.isFile() ? (info.mode & 0o100 ? "exec" : "file") : null;
  if (!kind) throw new Refusal(`${path} is ${info.isDirectory() ? "a directory (a nested repository?)" : "not a regular file"}: it cannot be captured`);
  let bytes;
  try { bytes = kind === "link" ? readlinkSync(full, { encoding: "buffer" }) : readFileSync(full); } catch (error) { throw new Refusal(`cannot read ${path}: ${error.code ?? error.message}`); }
  return { state: `${kind} sha256:${sha256(bytes)}`, kind, bytes };
}

/** The part of the reviewed state in the checkout: HEAD, the branch, the index, the working-tree patch (uncommitted changes and a ref) and the state of every relevant path. */
function localPart(fixed) {
  const { root } = fixed;
  if (resolveCommit(root, "HEAD") !== fixed.head) throw new Refusal("HEAD moved while the checkout was being read; run the command again");
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || "(detached HEAD)";
  const index = sha256(gitBytes(root, ["ls-files", "--stage", "-z"], "ls-files"));
  const untracked = decodePaths(gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z"], "ls-files"), "untracked files");
  let patch = fixed.patch;
  let parsed = fixed.parsed;
  let changed = pathsOf(parsed?.files ?? []);
  let own = null;
  if (fixed.newRev === null) {
    patch = diffBytes(root, [fixed.base]);
    parsed = parseWhole(patch, `git diff ${fixed.base}`);
    changed = pathsOf(parsed.files);
  } else {
    // the checkout's own changes, from the patch: unlike --name-only without an index refresh, it leaves out a file whose stat changed but whose bytes did not
    own = pathsOf(parseWhole(diffBytes(root, ["HEAD"]), "git diff HEAD").files);
    changed = [...changed, ...own];
  }
  const states = new Map([...new Set([...changed, ...untracked])].sort().map((path) => [path, pathState(root, path)]));
  for (const path of untracked) if (states.get(path).kind === "absent") throw new Refusal(`untracked ${path} disappeared while the checkout was being read; run the command again`);
  return { head: fixed.head, branch, index, patch: sha256(patch), parsed, untracked, states, own: own && [...new Set([...own, ...untracked])].sort() };
}

function manifestLines(fixed, local) {
  return [
    `format ${SNAPSHOT_FORMAT}`,
    `checkout ${JSON.stringify(fixed.root)}`,
    `head ${local.head}`,
    `branch ${JSON.stringify(local.branch)}`,
    `target ${fixed.label}`,
    `base ${fixed.base}`,
    `new ${fixed.newRev ?? "worktree"}`,
    ...(fixed.prBase ? [`pr-base ${fixed.prBase}`] : []),
    `patch sha256:${local.patch}`,
    `index sha256:${local.index}`,
    ...[...local.states].map(([path, s]) => `path ${JSON.stringify(path)} ${s.state}`),
  ];
}

const digestOf = (lines) => sha256(`${lines.join("\n")}\n`);
// the state edits are checked against: everything but the patch, which follows from the base and the files
const projection = (lines) => lines.filter((line) => !line.startsWith("patch "));

/** The reviewed state, read twice: the two reads must give the same manifest. `hooks.between` runs between them (tests). */
export function capture(root, mode, arg, hooks = {}) {
  const fixed = fixedPart(root, mode, arg);
  const local = localPart(fixed);
  const lines = manifestLines(fixed, local);
  hooks.between?.();
  if (digestOf(manifestLines(fixed, localPart(fixed))) !== digestOf(lines)) throw new Refusal("the checkout changed while it was being read; run the command again when nothing else writes to it");
  const files = fixed.newRev === null ? [...local.parsed.files, ...local.untracked.map((path) => untrackedEntry(path, local.states.get(path).kind, local.states.get(path).bytes))] : local.parsed.files;
  return { fixed, local, lines, digest: digestOf(lines), files };
}

const mismatch = (given, now, lines) => ({ code: MISMATCH, out: `verify: mismatch: ${given} was given, the checkout gives ${now}\nmanifest now:\n${lines.map((line) => `  ${line}`).join("\n")}\n` });

function verifyCommand(root, digest, mode, arg) {
  const snap = capture(root, mode, arg);
  const kind = digest.slice(0, digest.indexOf(":"));
  const lines = kind === "expected" ? projection(snap.lines) : snap.lines;
  const now = `${kind}:${digestOf(lines)}`;
  return now === digest ? { code: 0, out: `verify: match ${digest}\n` } : mismatch(digest, now, lines);
}

// ---- expect: a batch of exact replacements checked on the reviewed bytes ----

function readEdits(file, cwd, root) {
  const path = resolve(cwd, file);
  let text;
  try { text = readFileSync(path, "utf8"); } catch (error) { throw new Usage(`cannot read the edits file ${file}: ${error.code ?? error.message}`); }
  const inside = relative(realpathSync(root), realpathSync(path));
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new Usage(`the edits file ${file} is inside the checkout, where it changes the reviewed state: write it outside`);
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Usage(`the edits file is not JSON: ${error.message}`); }
  const list = data?.edits;
  if (!Array.isArray(list) || list.length === 0) throw new Usage('the edits file needs {"edits": [{"id": "e1", "path": "...", "old": "...", "new": "...", "depends": []}]}');
  const ids = new Set();
  return list.map((edit, i) => {
    if (typeof edit?.path !== "string" || typeof edit.old !== "string" || typeof edit.new !== "string") throw new Usage(`edit ${i + 1}: path, old and new must be strings`);
    const id = typeof edit.id === "string" && edit.id ? edit.id : `e${i + 1}`;
    if (ids.has(id)) throw new Usage(`edit id ${id} is used twice`);
    ids.add(id);
    const depends = edit.depends ?? [];
    if (!Array.isArray(depends) || depends.some((d) => typeof d !== "string")) throw new Usage(`edit ${id}: depends must be a list of ids`);
    return { id, path: relative(root, resolve(root, edit.path)).split(sep).join("/"), old: Buffer.from(edit.old), new: Buffer.from(edit.new), depends };
  });
}

function occurrences(bytes, needle) {
  const at = [];
  for (let i = bytes.indexOf(needle); i >= 0; i = bytes.indexOf(needle, i + 1)) at.push(i);
  return at;
}

const rowsOf = (bytes) => { const rows = []; let from = 0; for (let i = bytes.indexOf(10); i >= 0; i = bytes.indexOf(10, from)) { rows.push(bytes.subarray(from, i)); from = i + 1; } rows.push(bytes.subarray(from)); return rows; };

/** The lines of the file an edit changes, on whole lines: {from, to} when it replaces or removes lines, {after} when it only inserts after that line (0 = the top). */
export function changedLines(bytes, start, oldText, newText) {
  let from = start;
  while (from > 0 && bytes[from - 1] !== 10) from--;
  let to = start + oldText.length;
  if (bytes[to - 1] !== 10) { while (to < bytes.length && bytes[to] !== 10) to++; if (to < bytes.length) to++; }
  const oldSlice = bytes.subarray(from, to);
  const newSlice = Buffer.concat([bytes.subarray(from, start), newText, bytes.subarray(start + oldText.length, to)]);
  const oldRows = rowsOf(oldSlice);
  const newRows = rowsOf(newSlice);
  // when both end with a newline, the empty row after it is not a line: matched as unchanged, it moves an insertion that starts with a blank line one line down
  if (oldSlice.at(-1) === 10 && newSlice.at(-1) === 10) { oldRows.pop(); newRows.pop(); }
  let pre = 0;
  while (pre < oldRows.length && pre < newRows.length && oldRows[pre].equals(newRows[pre])) pre++;
  let post = 0;
  while (post < oldRows.length - pre && post < newRows.length - pre && oldRows.at(-1 - post).equals(newRows.at(-1 - post))) post++;
  const line = 1 + bytes.subarray(0, from).reduce((n, byte) => n + (byte === 10 ? 1 : 0), 0) + pre;
  const removed = oldRows.length - pre - post;
  return removed > 0 ? { from: line, to: line + removed - 1 } : { after: line - 1 };
}

/** Whether the changed lines lie in the hunks of the file (new-side lines; an insertion next to a run of added or changed lines or where lines were deleted). */
export function inHunks(span, hunks) {
  if (span.after !== undefined) return hunks.some((h) => (h.newCount > 0 ? span.after >= h.newStart - 1 && span.after <= h.newStart + h.newCount - 1 : span.after === h.newStart));
  for (let line = span.from; line <= span.to; line++) if (!hunks.some((h) => h.newCount > 0 && line >= h.newStart && line < h.newStart + h.newCount)) return false;
  return true;
}

const spanText = (span) => (span.after !== undefined ? `an insertion after line ${span.after}` : span.from === span.to ? `line ${span.from}` : `lines ${span.from}-${span.to}`);

function sameAsRevision(root, rev, path, bytes) {
  const done = spawnSync("git", ["cat-file", "blob", `${rev}:${path}`], { cwd: root, maxBuffer: MAX_BUFFER });
  return !done.error && done.status === 0 && done.stdout.equals(bytes);
}

/** Whether `bytes` with that kind are what the base revision holds at the path, so that the path leaves the working-tree diff. */
function sameAsBase(root, base, path, kind, bytes) {
  const entry = gitBytes(root, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", base, "--", path], "ls-tree").toString("utf8").split("\0")[0];
  const mode = { file: "100644", exec: "100755" }[kind];
  return entry.startsWith(`${mode} blob `) && sameAsRevision(root, base, path, bytes);
}

function expectCommand(root, cwd, digest, editsFile, mode, arg) {
  const edits = readEdits(editsFile, cwd, root);
  const snap = capture(root, mode, arg);
  if (`sha256:${snap.digest}` !== digest) return mismatch(digest, `sha256:${snap.digest}`, snap.lines);
  const reviewed = new Map(snap.files.map((file) => [file.path, file]));
  const verdict = new Map();
  const refuse = (edit, reason) => verdict.set(edit.id, { ok: false, reason });
  for (const edit of edits) {
    const file = reviewed.get(edit.path);
    const state = snap.local.states.get(edit.path);
    if (!file) refuse(edit, "not a file of the reviewed diff");
    else if (file.status === "D") refuse(edit, "the diff deletes this file");
    else if (state?.kind !== "file" && state?.kind !== "exec") refuse(edit, `the checkout has no regular file there (${state?.kind ?? "absent"})`);
    else if (snap.fixed.newRev && !sameAsRevision(root, snap.fixed.newRev, edit.path, state.bytes)) refuse(edit, `the checkout's copy differs from the reviewed revision ${short(snap.fixed.newRev)}, so its lines cannot be matched to the reviewed ones`);
    else if (edit.old.length === 0) refuse(edit, "the old text is empty: anchor an insertion with unchanged text");
    else if (edit.old.equals(edit.new)) refuse(edit, "the old and the new text are the same");
    else {
      const found = occurrences(state.bytes, edit.old);
      if (found.length !== 1) { refuse(edit, `the old text is found ${found.length} times in the reviewed file`); continue; }
      const span = changedLines(state.bytes, found[0], edit.old, edit.new);
      if (!inHunks(span, file.hunks)) refuse(edit, `it changes ${spanText(span)}, outside the hunks of the diff`);
      else verdict.set(edit.id, { ok: true, start: found[0], end: found[0] + edit.old.length, span });
    }
  }
  // overlaps, dependencies and the edits in order on the bytes the earlier ones leave, until nothing more is refused
  let contents;
  for (let again = true; again; ) {
    again = false;
    const live = edits.filter((edit) => verdict.get(edit.id).ok);
    for (const edit of live) {
      const blocked = edit.depends.find((id) => !verdict.get(id)?.ok);
      if (blocked !== undefined) { refuse(edit, verdict.has(blocked) ? `it depends on ${blocked}, which is refused` : `it depends on ${blocked}, which is not in the edits file`); again = true; continue; }
      const other = live.find((o) => o !== edit && o.path === edit.path && verdict.get(o.id).ok && verdict.get(o.id).start < verdict.get(edit.id).end && verdict.get(edit.id).start < verdict.get(o.id).end);
      if (other) { refuse(edit, `it overlaps ${other.id}`); refuse(other, `it overlaps ${edit.id}`); again = true; }
    }
    if (again) continue;
    contents = new Map();
    for (const edit of live) {
      const bytes = contents.get(edit.path) ?? snap.local.states.get(edit.path).bytes;
      const found = occurrences(bytes, edit.old);
      if (found.length !== 1) { refuse(edit, `after the edits before it, the old text is found ${found.length} times`); again = true; break; }
      contents.set(edit.path, Buffer.concat([bytes.subarray(0, found[0]), edit.new, bytes.subarray(found[0] + edit.old.length)]));
    }
  }
  const accepted = edits.filter((edit) => verdict.get(edit.id).ok);
  const out = [`expect: the checkout matches sha256:${snap.digest}`];
  for (const edit of edits) {
    const v = verdict.get(edit.id);
    out.push(`edit ${edit.id} ${JSON.stringify(edit.path)}: ${v.ok ? `ok, ${spanText(v.span)}` : `refused: ${v.reason}`}`);
  }
  out.push(`apply in this order: ${accepted.map((edit) => edit.id).join(", ") || "none"}`);
  if (accepted.length) {
    const expected = new Map([...snap.local.states].map(([path, s]) => [path, s.state]));
    for (const [path, bytes] of contents) {
      const { kind } = snap.local.states.get(path);
      if (snap.fixed.newRev === null && !snap.local.untracked.includes(path) && sameAsBase(root, snap.fixed.base, path, kind, bytes)) expected.delete(path);
      else expected.set(path, `${kind} sha256:${sha256(bytes)}`);
    }
    const lines = [...projection(snap.lines).filter((line) => !line.startsWith("path ")), ...[...expected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, state]) => `path ${JSON.stringify(path)} ${state}`)];
    out.push(`expected: expected:${digestOf(lines)}`);
  }
  return { code: accepted.length === edits.length ? 0 : EDITS_REFUSED, out: `${out.join("\n")}\n` };
}

function parseCommandLine(argv) {
  let positionals;
  let values;
  try { ({ positionals, values } = parseArgs({ args: argv, options: { checkout: { type: "string", short: "C" } }, allowPositionals: true })); } catch (error) { throw new Usage(error.message); }
  let action = "inventory";
  let digest = null;
  let editsFile = null;
  if (positionals[0] === "snapshot") { action = "snapshot"; positionals.shift(); }
  else if (positionals[0] === "verify" || positionals[0] === "expect") {
    action = positionals.shift();
    digest = positionals.shift() ?? "";
    const kinds = action === "verify" ? /^(sha256|expected):[0-9a-f]{64}$/ : /^sha256:[0-9a-f]{64}$/;
    if (!kinds.test(digest)) throw new Usage(`not a ${action === "verify" ? "sha256: or expected:" : "sha256:"} digest: ${digest}`);
    if (action === "expect") editsFile = positionals.shift();
    if (action === "expect" && !editsFile) throw new Usage("expected an edits file");
  }
  const [mode, arg, ...extra] = positionals;
  if (!Object.hasOwn(ARGUMENTS_OF, mode) || (arg === undefined ? 0 : 1) + extra.length !== ARGUMENTS_OF[mode]) throw new Usage("expected a mode and its argument");
  if (arg?.startsWith("-")) throw new Usage(`not a ${mode === "pr" ? "pull request number" : "revision"}: ${arg}`);
  if (mode === "pr" && !/^[1-9]\d{0,8}$/.test(arg)) throw new Usage(`not a pull request number: ${arg}`);
  return { action, digest, editsFile, mode, arg, dir: values.checkout ?? null };
}

/** What `argv` (the arguments after the script name) prints and its exit code, run in `cwd`; throws Usage or Refusal. */
export function run(argv, cwd = process.cwd()) {
  const { action, digest, editsFile, mode, arg, dir } = parseCommandLine(argv);
  const start = dir === null ? cwd : resolve(cwd, dir);
  if (dir !== null && !lstatSync(start, { throwIfNoEntry: false })?.isDirectory()) throw new Usage(`-C: not a folder: ${dir}`);
  const top = git(start, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Refusal("not inside a git repository");
  const root = top.stdout.trim();
  if (git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).status !== 0) throw new Refusal("the repository has no commit yet");
  if (action === "verify") return verifyCommand(root, digest, mode, arg);
  if (action === "expect") return expectCommand(root, cwd, digest, editsFile, mode, arg);
  if (action === "snapshot") {
    const snap = capture(root, mode, arg);
    return { code: 0, out: render({ ...snap.fixed.view, files: snap.files, unparsed: [], digest: snap.digest, manifest: snap.lines, localChanges: snap.local.own }) };
  }
  const target = { uncommitted: () => uncommitted(root), commit: () => commitTarget(root, arg), pr: () => prTarget(root, arg), ref: () => againstRef(root, arg) }[mode]();
  return { code: 0, out: render(target) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { code, out } = run(process.argv.slice(2));
    process.stdout.write(out);
    process.exitCode = code;
  } catch (error) {
    if (error instanceof Usage) { console.error(`diff-target: ${error.message}\n${USAGE}`); process.exit(2); }
    if (error instanceof Refusal) { console.error(`diff-target: ${error.message}`); process.exit(3); }
    throw error;
  }
}
