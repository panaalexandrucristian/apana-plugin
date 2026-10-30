#!/usr/bin/env node
// diff-target: the facts about the diff that /apana:review-diff reviews, in ONE read-only command: the files (new ones included, also the ones git does not track yet),
// every hunk as file:line, whether the target is on the current branch, the sibling worktree path when it is not, merge and root commits, the requirement text
// (commit message, PR title and body, or the branch name) and, for a PR, owner/repo for `gh -R`.
//   node diff-target.mjs uncommitted | commit <sha> | pr <number> | ref <ref>
// `ref` is one diff of the working tree against the merge base of <ref> and HEAD (what is committed, what is not, and the untracked files). `pr` needs `gh`; nothing is written anywhere.
// Exit codes: 0 ok, 2 bad arguments, 3 refused (not a git repository, no commit, not a commit, no common ancestor, origin not on github.com, gh missing or failing).
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

class Usage extends Error {}
class Refusal extends Error {}

const USAGE = "usage: diff-target.mjs uncommitted | commit <sha> | pr <number> | ref <ref>";
const MAX_BUFFER = 1 << 30;
const REQUIREMENT_LINES = 40;
const BINARY_SNIFF_BYTES = 8000;
const ARGUMENTS_OF = { uncommitted: 0, commit: 1, pr: 1, ref: 1 };
// -U0 so that git reports the runs of changed lines itself; explicit prefixes and -M so that a user's diff.noprefix, diff.mnemonicPrefix or diff.renames cannot change what is parsed
const DIFF = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-M", "-U0", "--src-prefix=a/", "--dst-prefix=b/"];

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
 * `unparsed` holds the lines it did not understand (combined diffs); they are reported, not dropped.
 */
export function parsePatch(patch) {
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const files = [];
  const unparsed = [];
  let section = null;
  let inHunk = false;
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
  const close = () => {
    flush();
    if (!section) return;
    const path = section.renameTo ?? section.plus ?? section.minus ?? section.fromLine?.newPath ?? null;
    if (path === null) unparsed.push(`diff --git (no path): ${section.header}`);
    else files.push({ path, oldPath: section.status === "R" ? (section.renameFrom ?? section.fromLine?.oldPath ?? null) : null, status: section.status, binary: section.binary, hunks: section.hunks });
    section = null;
    inHunk = false;
  };

  for (const row of rows) {
    if (row.startsWith("diff --git ")) {
      close();
      section = { header: row, fromLine: pathsOfDiffLine(row.slice(11)), status: "M", binary: false, hunks: [], renameFrom: null, renameTo: null, minus: null, plus: null };
    } else if (row.startsWith("diff --cc ") || row.startsWith("diff --combined ") || row.startsWith("@@@")) {
      if (!row.startsWith("@@@")) close();
      unparsed.push(row);
      inHunk = false;
    } else if (row.startsWith("@@")) {
      flush();
      const header = section ? parseHunkHeader(row) : null;
      if (!header) { unparsed.push(row); inHunk = false; continue; }
      oldLine = header.oldCount === 0 ? header.oldStart + 1 : header.oldStart;
      newLine = header.newCount === 0 ? header.newStart + 1 : header.newStart;
      inHunk = true;
    } else if (inHunk) {
      if (row[0] === "-") { open(); removed++; oldLine++; }
      else if (row[0] === "+") { open(); added++; newLine++; }
      else if (row[0] === " " || row === "") { flush(); oldLine++; newLine++; }
      // anything else is the "\ No newline at end of file" marker
    } else if (section) {
      if (row.startsWith("new file mode")) section.status = "A";
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

function resolveCommit(root, rev) {
  const done = git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (done.status !== 0) throw new Refusal(`not a commit: ${rev}`);
  return done.stdout.trim();
}

const isAncestorOfHead = (root, sha) => git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]).status === 0;

/** A file git does not track yet, as a diff of an empty file against it: one `add` hunk of all its lines, or none for an empty or binary file. */
function untrackedFile(root, path) {
  const file = { path, oldPath: null, status: "A", binary: false, hunks: [], untracked: true, note: null };
  let info;
  try { info = lstatSync(join(root, path)); } catch { return file; }
  let lineCount = 0;
  if (info.isSymbolicLink()) lineCount = 1;
  else if (info.isDirectory()) file.note = "directory not read";
  else if (!info.isFile()) file.note = "not a regular file";
  else {
    const bytes = readFileSync(join(root, path));
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) file.binary = true;
    else if (bytes.length > 0) lineCount = bytes.reduce((n, byte) => n + (byte === 10 ? 1 : 0), 0) + (bytes.at(-1) === 10 ? 0 : 1);
  }
  if (lineCount > 0) file.hunks.push({ kind: "add", oldStart: 0, oldCount: 0, newStart: 1, newCount: lineCount });
  return file;
}

/** `git diff <base>` (the working tree against base) parsed, plus the untracked files. */
function workingTreeDiff(root, base) {
  const parsed = parsePatch(gitText(root, [...DIFF, base, "--"], "diff"));
  const untracked = gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"], "ls-files").split("\0").filter(Boolean);
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
  const mergeBase = git(root, ["merge-base", resolveCommit(root, ref), "HEAD"]);
  if (mergeBase.status !== 0) throw new Refusal(`no common ancestor of ${ref} and HEAD`);
  const base = mergeBase.stdout.trim();
  return { what: `ref ${ref}`, diff: `git diff ${base}, plus untracked files`, onBranch: "yes", requirement: currentBranchRequirement(root), ...workingTreeDiff(root, base) };
}

function commitTarget(root, rev) {
  const sha = resolveCommit(root, rev);
  const what = `commit ${sha.slice(0, 8)}`;
  const onBranch = isAncestorOfHead(root, sha) ? "yes" : "no";
  const worktree = onBranch === "yes" ? null : `../${basename(root)}-review-${sha.slice(0, 8)}`;
  const message = requirement("commit message", gitText(root, ["show", "-s", "--format=%B", sha], "show"));
  const parents = gitText(root, ["rev-list", "--parents", "-n", "1", sha], "rev-list").trim().split(" ").length - 1;
  if (parents !== 1) return { what, special: parents === 0 ? "root" : "merge", onBranch, worktree, requirement: message, files: [], unparsed: [] };
  const parsed = parsePatch(gitText(root, [...DIFF, `${sha}^`, sha, "--"], "diff"));
  return { what, diff: `git diff ${sha}^..${sha}`, onBranch, worktree, requirement: message, ...parsed };
}

function gh(root, args) {
  const done = spawnSync("gh", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (done.error) throw new Refusal(`gh could not run: ${done.error.message}`);
  if (done.status !== 0) throw new Refusal(`gh ${args.slice(0, 5).join(" ")}: ${firstLine(done.stderr)}`);
  return done.stdout;
}

function prTarget(root, number) {
  const remote = git(root, ["remote", "get-url", "origin"]);
  if (remote.status !== 0) throw new Refusal("no origin remote");
  const repo = parseRemote(remote.stdout);
  if (!repo) throw new Refusal("origin is not a github.com remote");
  let view;
  try { view = JSON.parse(gh(root, ["pr", "view", number, "-R", repo, "--json", "title,body,headRefOid,baseRefName"])); } catch (error) {
    if (error instanceof SyntaxError) throw new Refusal(`gh pr view ${number} -R ${repo}: the answer is not JSON`);
    throw error;
  }
  const parsed = parsePatch(gh(root, ["pr", "diff", number, "-R", repo, "--color", "never"]));
  const head = typeof view.headRefOid === "string" && /^[0-9a-f]{40,64}$/.test(view.headRefOid) ? view.headRefOid : null;
  const onBranch = head && git(root, ["cat-file", "-e", `${head}^{commit}`]).status === 0 ? (isAncestorOfHead(root, head) ? "yes" : "no") : "unknown";
  const text = [view.title ?? "", view.body ?? ""].map((part) => part.trim()).filter(Boolean).join("\n\n");
  return { what: `PR #${number}`, diff: `gh pr diff ${number} -R ${repo}`, repo, onBranch, worktree: onBranch === "yes" ? null : `../${basename(root)}-review-pr${number}`, requirement: requirement("PR title and body", text), ...parsed };
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
  if (target.diff) out.push(`diff: ${target.diff}`);
  out.push(`on current branch: ${target.onBranch}`);
  if (target.worktree) out.push(`worktree: ${target.worktree}`);
  if (target.special) out.push(`special: ${target.special}`);
  if (target.repo) out.push(`repo: ${target.repo}`);
  if (target.unparsed.length) out.push(`unparsed: ${target.unparsed.length} lines not understood (a combined diff?)`);
  out.push(`requirement (${target.requirement.label}):`, ...target.requirement.rows);
  if (target.files.length) out.push("files:", ...target.files.map(fileRow));
  if (hunks.length) out.push("hunks:", ...hunks);
  return `${out.join("\n")}\n`;
}

function parseCommandLine(argv) {
  let positionals;
  try { ({ positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true })); } catch (error) { throw new Usage(error.message); }
  const [mode, arg, ...extra] = positionals;
  if (!Object.hasOwn(ARGUMENTS_OF, mode) || (arg === undefined ? 0 : 1) + extra.length !== ARGUMENTS_OF[mode]) throw new Usage("expected a mode and its argument");
  if (arg?.startsWith("-")) throw new Usage(`not a ${mode === "pr" ? "pull request number" : "revision"}: ${arg}`);
  if (mode === "pr" && !/^[1-9]\d{0,8}$/.test(arg)) throw new Usage(`not a pull request number: ${arg}`);
  return { mode, arg };
}

/** The report for `argv` (the arguments after the script name), run in `cwd`; throws Usage or Refusal. */
function report(argv, cwd = process.cwd()) {
  const { mode, arg } = parseCommandLine(argv);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Refusal("not inside a git repository");
  const root = top.stdout.trim();
  if (git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).status !== 0) throw new Refusal("the repository has no commit yet");
  const target = { uncommitted: () => uncommitted(root), commit: () => commitTarget(root, arg), pr: () => prTarget(root, arg), ref: () => againstRef(root, arg) }[mode]();
  return render(target);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(report(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof Usage) { console.error(`diff-target: ${error.message}\n${USAGE}`); process.exit(2); }
    if (error instanceof Refusal) { console.error(`diff-target: ${error.message}`); process.exit(3); }
    throw error;
  }
}
