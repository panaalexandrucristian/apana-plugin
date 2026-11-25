// Tests of diff-target.mjs: the pure parsers on synthetic text, then the program itself against throwaway git
// repositories and a fake `gh` (no network). Node stdlib only; the git cases are skipped when git is missing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { capture, changedLines, inHunks, parseHunkHeader, parsePatch, parseRemote, unquotePath } from "../diff-target.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "diff-target.mjs");
const hasGit = spawnSync("git", ["--version"]).status === 0;

const lines = (...rows) => rows.map((row) => `${row}\n`).join("");
const hunkSummary = (file) => file.hunks.map((h) => `${h.kind} ${h.oldStart},${h.oldCount} ${h.newStart},${h.newCount}`);

describe("parseHunkHeader", () => {
  it("reads every shape of header that occurs (a missing count is 1; synthetic text, shapes counted in this repo's history)", () => {
    const forms = [
      ["@@ -3,0 +4,2 @@", [3, 0, 4, 2]],
      ["@@ -3 +3 @@", [3, 1, 3, 1]],
      ["@@ -3 +3,2 @@", [3, 1, 3, 2]],
      ["@@ -3,2 +3,2 @@", [3, 2, 3, 2]],
      ["@@ -3,0 +4 @@", [3, 0, 4, 1]],
      ["@@ -3,2 +2,0 @@", [3, 2, 2, 0]],
      ["@@ -3,2 +3 @@", [3, 2, 3, 1]],
      ["@@ -3 +2,0 @@", [3, 1, 2, 0]],
    ];
    for (const [header, [oldStart, oldCount, newStart, newCount]] of forms) {
      assert.deepEqual(parseHunkHeader(header), { oldStart, oldCount, newStart, newCount }, header);
    }
  });

  it("ignores the section text after the header and refuses what is not a plain header", () => {
    assert.deepEqual(parseHunkHeader("@@ -10,2 +10,3 @@ fun main() {"), { oldStart: 10, oldCount: 2, newStart: 10, newCount: 3 });
    assert.equal(parseHunkHeader("@@@ -1,2 -1,2 +1,3 @@@"), null);
    assert.equal(parseHunkHeader("not a header"), null);
  });
});

describe("unquotePath", () => {
  it("decodes git's quoting and leaves a plain name alone", () => {
    assert.equal(unquotePath("src/a.kt"), "src/a.kt");
    assert.equal(unquotePath('"q\\"uote\\\\x\\ty.txt"'), 'q"uote\\x\ty.txt');
    assert.equal(unquotePath('"caf\\303\\251.txt"'), "café.txt");
  });
});

describe("parseRemote", () => {
  it("reads owner/repo from the GitHub remote shapes; only the first is real (n=1 remote here), the rest are synthetic", () => {
    assert.equal(parseRemote("https://github.com/panaalexandrucristian/apana-plugin.git"), "panaalexandrucristian/apana-plugin");
    assert.equal(parseRemote("https://github.com/o/r"), "o/r");
    assert.equal(parseRemote("git@github.com:o/r.git"), "o/r");
    assert.equal(parseRemote("ssh://git@github.com/o/r.git"), "o/r");
    assert.equal(parseRemote("https://user:secret@github.com/o/r.git\n"), "o/r");
  });

  it("returns null for anything else", () => {
    for (const url of ["https://gitlab.com/o/r.git", "git@bitbucket.org:o/r.git", "/srv/git/r.git", "", "https://github.com/o"]) {
      assert.equal(parseRemote(url), null, url);
    }
  });
});

describe("parsePatch", () => {
  it("splits a hunk with context into its runs of changed lines, so that it counts the same as -U0", () => {
    const patch = lines(
      "diff --git a/dir/my file.txt b/dir/my file.txt",
      "index 111..222 100644",
      "--- a/dir/my file.txt\t",
      "+++ b/dir/my file.txt\t",
      "@@ -1,7 +1,7 @@",
      " a",
      "-b",
      "+B",
      " c",
      " d",
      "+e2",
      " e",
      " f",
      "-g",
    );
    const [file, ...rest] = parsePatch(patch).files;
    assert.equal(rest.length, 0);
    assert.equal(file.path, "dir/my file.txt");
    assert.deepEqual(hunkSummary(file), ["change 2,1 2,1", "add 4,0 5,1", "delete 7,1 7,0"]);
  });

  it("gives the line before the removed lines for a delete, and 0 at the top of the file", () => {
    const patch = lines("diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-x", "-y");
    const [file] = parsePatch(patch).files;
    assert.equal(file.status, "D");
    assert.equal(file.path, "gone.txt");
    assert.deepEqual(file.hunks.map((h) => [h.kind, h.newStart]), [["delete", 0]]);
  });

  it("reads a new file, a pure rename, a rename with an edit, a binary file and a mode change", () => {
    const patch = lines(
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+1",
      "+2",
      "diff --git a/old.txt b/renamed.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to renamed.txt",
      "diff --git a/o2.txt b/n2.txt",
      "similarity index 80%",
      "rename from o2.txt",
      "rename to n2.txt",
      "--- a/o2.txt",
      "+++ b/n2.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/pic.png b/pic.png",
      "index 1..2 100644",
      "Binary files a/pic.png and b/pic.png differ",
      "diff --git a/my mode.sh b/my mode.sh",
      "old mode 100644",
      "new mode 100755",
    );
    const files = parsePatch(patch).files.map((f) => [f.status, f.oldPath, f.path, f.binary, f.hunks.length]);
    assert.deepEqual(files, [
      ["A", null, "new.txt", false, 1],
      ["R", "old.txt", "renamed.txt", false, 0],
      ["R", "o2.txt", "n2.txt", false, 1],
      ["M", null, "pic.png", true, 0],
      ["M", null, "my mode.sh", false, 0],
    ]);
  });

  it("finds the path of quoted names, also when there is no ---/+++ line", () => {
    const patch = lines(
      'diff --git "a/q\\"uote.txt" "b/q\\"uote.txt"',
      '--- "a/q\\"uote.txt"',
      '+++ "b/q\\"uote.txt"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
      'diff --git "a/caf\\303\\251.bin" "b/caf\\303\\251.bin"',
      'Binary files "a/caf\\303\\251.bin" and "b/caf\\303\\251.bin" differ',
    );
    assert.deepEqual(parsePatch(patch).files.map((f) => f.path), ['q"uote.txt', "café.bin"]);
  });

  it("does not take a removed line that looks like a header for a header, and ignores the no-newline marker", () => {
    const patch = lines("diff --git a/t.txt b/t.txt", "--- a/t.txt", "+++ b/t.txt", "@@ -1,2 +1,2 @@", "--- not a header", "+++ not a header either", "\\ No newline at end of file");
    const [file] = parsePatch(patch).files;
    assert.equal(file.path, "t.txt");
    assert.deepEqual(hunkSummary(file), ["change 1,1 1,1"]);
  });

  it("reports what it does not understand instead of dropping it", () => {
    const patch = lines("diff --cc merged.txt", "--- a/merged.txt", "+++ b/merged.txt", "@@@ -1,2 -1,2 +1,3 @@@", " x");
    const parsed = parsePatch(patch);
    assert.equal(parsed.files.length, 0);
    assert.equal(parsed.unparsed.length, 2);
  });

  it("reports a hunk whose body has fewer lines than its header counts (a cut patch) and a line no header counted", () => {
    const cut = parsePatch(lines("diff --git a/t.txt b/t.txt", "--- a/t.txt", "+++ b/t.txt", "@@ -1,3 +1,3 @@", "-a", "+A"));
    assert.deepEqual(cut.unparsed, ["@@ -1,3 +1,3 @@ (cut: 2 old and 2 new lines missing)"]);
    const extra = parsePatch(lines("diff --git a/t.txt b/t.txt", "--- a/t.txt", "+++ b/t.txt", "@@ -1 +1 @@", "-a", "+A", "+B"));
    assert.deepEqual(extra.unparsed, ["+B"]);
  });
});

describe("changedLines and inHunks", () => {
  const text = Buffer.from(lines("l1", "l2", "l3", "l4", "l5"));
  const span = (oldText, newText) => changedLines(text, text.indexOf(oldText), Buffer.from(oldText), Buffer.from(newText));

  it("counts only the lines an edit really changes, not the unchanged context of its anchor", () => {
    assert.deepEqual(span("l2\nl3\nl4\n", "l2\nL3\nl4\n"), { from: 3, to: 3 });
    assert.deepEqual(span("3\nl4", "3\nX\nl4"), { after: 3 });
    assert.deepEqual(span("l1\n", ""), { from: 1, to: 1 });
    assert.deepEqual(span("l5\n", "l5\nl6\n"), { after: 5 });
  });

  it("places an insertion that starts with a blank line right after its anchor, not one line down", () => {
    assert.deepEqual(span("l3", "l3\n\nX"), { after: 3 });
    assert.deepEqual(span("l5", "l5\n\nl6"), { after: 5 });
  });

  it("accepts a span inside the new-side lines of the hunks and an insertion next to them, nothing else", () => {
    const hunks = [{ kind: "change", oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }, { kind: "delete", oldStart: 6, oldCount: 2, newStart: 5, newCount: 0 }];
    assert.equal(inHunks({ from: 3, to: 3 }, hunks), true);
    assert.equal(inHunks({ from: 3, to: 4 }, hunks), false);
    assert.equal(inHunks({ after: 2 }, hunks), true);
    assert.equal(inHunks({ after: 3 }, hunks), true);
    assert.equal(inHunks({ after: 4 }, hunks), false);
    assert.equal(inHunks({ after: 5 }, hunks), true);
    assert.equal(inHunks({ from: 5, to: 5 }, hunks), false);
  });
});

describe("diff-target.mjs", { skip: !hasGit && "git not installed" }, () => {
  let base;
  let ghBin;
  let counter = 0;

  const git = (cwd, ...args) => {
    const done = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    assert.equal(done.status, 0, `git ${args.join(" ")}: ${done.stderr}`);
    return done.stdout.trim();
  };
  const put = (dir, rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  const commit = (dir, message) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  const newRepo = (name) => {
    const dir = join(base, `${name}-${counter++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    return dir;
  };
  const tenLines = (...changes) => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
    for (const [n, value] of changes) text[n - 1] = value;
    return lines(...text);
  };
  const run = (cwd, args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  const ok = (cwd, args, env) => {
    const done = run(cwd, args, env);
    assert.equal(done.status, 0, done.stderr);
    return done.stdout;
  };
  const section = (out, name) => out.slice(out.indexOf(`\n${name}:`) + 1);

  before(() => {
    base = mkdtempSync(join(tmpdir(), "diff-target-"));
    ghBin = join(base, "bin");
    mkdirSync(ghBin);
    writeFileSync(
      join(ghBin, "gh"),
      `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const env = process.env;
if (env.GH_FAKE_LOG) appendFileSync(env.GH_FAKE_LOG, process.argv.slice(2).join(" ") + "\\n");
if (env.GH_FAKE_FAIL) { console.error(env.GH_FAKE_FAIL); process.exit(1); }
const [, , group, sub] = process.argv;
// GH_FAKE_VIEWS: one answer per pr view call, in order (the last one repeats), counted in the file GH_FAKE_COUNTER
const next = () => { const views = JSON.parse(env.GH_FAKE_VIEWS); const n = existsSync(env.GH_FAKE_COUNTER) ? +readFileSync(env.GH_FAKE_COUNTER, "utf8") : 0; writeFileSync(env.GH_FAKE_COUNTER, String(n + 1)); return views[Math.min(n, views.length - 1)]; };
if (group === "pr" && sub === "view") process.stdout.write(env.GH_FAKE_VIEWS ? next() : env.GH_FAKE_VIEW);
else if (group === "pr" && sub === "diff") process.stdout.write(readFileSync(env.GH_FAKE_DIFF, "utf8"));
else { console.error("fake gh: unexpected " + process.argv.slice(2).join(" ")); process.exit(1); }
`,
    );
    chmodSync(join(ghBin, "gh"), 0o755);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  describe("uncommitted", () => {
    let repo;
    let out;
    before(() => {
      repo = newRepo("uncommitted");
      put(repo, "a.txt", tenLines());
      put(repo, "b.txt", "x\n");
      commit(repo, "first");
      put(repo, "a.txt", `${tenLines([3, "L3"])}l11\nl12\n`);
      rmSync(join(repo, "b.txt"));
      put(repo, "new file.txt", "one\ntwo\nthree");
      put(repo, "y.txt", "1\n2\n");
      put(repo, "empty.txt", "");
      writeFileSync(join(repo, "img.bin"), Buffer.from([0, 1, 2, 3]));
      out = ok(repo, ["uncommitted"]);
    });

    it("lists the tracked hunks and the untracked files, one line each", () => {
      assert.match(out, /^diff-target: uncommitted changes: files 6, hunks 5\n/);
      const hunks = section(out, "hunks");
      for (const row of ["a.txt:3 change old 3,1 new 3,1", "a.txt:11 add new 11,2", "b.txt:0 delete old 1,1", "new file.txt:1 add new 1,3", "y.txt:1 add new 1,2"]) {
        assert.ok(hunks.includes(`  ${row}\n`), row);
      }
      const files = section(out, "files");
      for (const row of ["M a.txt", "D b.txt", "A new file.txt (untracked)", "A empty.txt (untracked, no line changes)", "A img.bin (untracked, binary)"]) {
        assert.ok(files.includes(`  ${row}\n`), row);
      }
    });

    it("says the target is on the current branch and names the branch as the requirement", () => {
      assert.match(out, /\non current branch: yes\n/);
      assert.ok(!out.includes("worktree:"));
      assert.match(out, /\nrequirement \(branch name\):\n {2}main\n/);
      assert.match(out, /\ndiff: git diff HEAD, plus untracked files\n/);
    });

    it("works from a subfolder, with paths from the top of the repository", () => {
      mkdirSync(join(repo, "sub"), { recursive: true });
      assert.equal(ok(join(repo, "sub"), ["uncommitted"]), out);
    });

    it("reports an empty diff as zero files", () => {
      const clean = newRepo("clean");
      put(clean, "a.txt", "x\n");
      commit(clean, "first");
      assert.match(ok(clean, ["uncommitted"]), /^diff-target: uncommitted changes: files 0, hunks 0\n/);
    });
  });

  describe("ref", () => {
    let repo;
    let first;
    let out;
    before(() => {
      repo = newRepo("ref");
      put(repo, "a.txt", tenLines());
      first = commit(repo, "first");
      git(repo, "checkout", "-q", "-b", "feature");
      put(repo, "a.txt", tenLines([5, "L5"]));
      commit(repo, "feature work");
      put(repo, "a.txt", tenLines([5, "L5"], [8, "L8"]));
      put(repo, "new.txt", "n\n");
      out = ok(repo, ["ref", "main"]);
    });

    it("takes one diff against the merge base: what is committed, what is not and what is untracked", () => {
      assert.match(out, /^diff-target: ref main: files 2, hunks 3\n/);
      assert.match(out, new RegExp(`\\ndiff: git diff ${first}, plus untracked files\\n`));
      const hunks = section(out, "hunks");
      for (const row of ["a.txt:5 change old 5,1 new 5,1", "a.txt:8 change old 8,1 new 8,1", "new.txt:1 add new 1,1"]) {
        assert.ok(hunks.includes(`  ${row}\n`), row);
      }
      assert.match(out, /\non current branch: yes\n/);
      assert.match(out, /\nrequirement \(branch name\):\n {2}feature\n/);
    });

    it("refuses a ref that is not a commit, and an option in its place", () => {
      const missing = run(repo, ["ref", "nope"]);
      assert.equal(missing.status, 3);
      assert.equal(missing.stdout, "");
      assert.match(missing.stderr, /^diff-target: not a commit: nope\n/);
      assert.equal(run(repo, ["ref", "--evil"]).status, 2);
    });
  });

  describe("commit and pr", () => {
    let repo;
    let c1;
    let c2;
    let side;
    let merge;
    let commitOut;
    before(() => {
      repo = newRepo("history");
      put(repo, "a.txt", tenLines());
      put(repo, "b.txt", "x\n");
      put(repo, "old.txt", lines("r1", "r2", "r3", "r4", "r5"));
      put(repo, "mode.sh", "echo\n");
      writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
      c1 = commit(repo, "first");

      git(repo, "checkout", "-q", "-b", "side");
      put(repo, "s.txt", "side\n");
      side = commit(repo, "side work");
      git(repo, "checkout", "-q", "-b", "other", c1);
      put(repo, "o.txt", "other\n");
      commit(repo, "other work");
      git(repo, "checkout", "-q", "main");

      put(repo, "a.txt", `${tenLines([3, "L3"], [6, "L6"])}l11\n`);
      rmSync(join(repo, "b.txt"));
      rmSync(join(repo, "old.txt"));
      put(repo, "renamed.txt", lines("r1", "r2", "r3", "r4", "r5"));
      writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 4]));
      git(repo, "add", "-A");
      git(repo, "update-index", "--chmod=+x", "mode.sh");
      git(repo, "commit", "-q", "-m", "second\n\nChange a.txt, drop b.txt, rename old.txt.");
      c2 = git(repo, "rev-parse", "HEAD");
      git(repo, "merge", "-q", "--no-ff", "other", "-m", "merge other");
      merge = git(repo, "rev-parse", "HEAD");
      commitOut = ok(repo, ["commit", c2]);
    });

    it("commit: lists the files and the hunks of X^..X, with the commit message as the requirement", () => {
      assert.match(commitOut, new RegExp(`^diff-target: commit ${c2.slice(0, 8)}: files 5, hunks 4\\n`));
      assert.match(commitOut, new RegExp(`\\ndiff: git diff ${c2}\\^\\.\\.${c2}\\n`));
      assert.match(commitOut, /\nrequirement \(commit message\):\n {2}second\n\n {2}Change a\.txt, drop b\.txt, rename old\.txt\.\n/);
      const files = section(commitOut, "files");
      for (const row of ["M a.txt", "D b.txt", "M bin.dat (binary)", "M mode.sh (no line changes)", "R old.txt -> renamed.txt (no line changes)"]) {
        assert.ok(files.includes(`  ${row}\n`), row);
      }
      const hunks = section(commitOut, "hunks");
      for (const row of ["a.txt:3 change old 3,1 new 3,1", "a.txt:6 change old 6,1 new 6,1", "a.txt:11 add new 11,1", "b.txt:0 delete old 1,1"]) {
        assert.ok(hunks.includes(`  ${row}\n`), row);
      }
    });

    it("commit: a commit that is an ancestor of HEAD is on the current branch; one on another branch is not, and gets a worktree path", () => {
      assert.match(commitOut, /\non current branch: yes\n/);
      assert.ok(!commitOut.includes("worktree:"));
      const other = ok(repo, ["commit", side]);
      assert.match(other, /\non current branch: no\n/);
      assert.match(other, new RegExp(`\\nworktree: \\.\\./${basename(repo)}-review-${side.slice(0, 8)}\\n`));
    });

    it("commit: a merge commit and a root commit are not diffed; they are marked special", () => {
      const mergeOut = ok(repo, ["commit", merge]);
      assert.match(mergeOut, /\nspecial: merge\n/);
      assert.ok(!mergeOut.includes("\nfiles:") && !mergeOut.includes("\nhunks:"));
      const rootOut = ok(repo, ["commit", c1]);
      assert.match(rootOut, /\nspecial: root\n/);
      assert.ok(!rootOut.includes("\nhunks:"));
    });

    describe("pr, with a fake gh", () => {
      let patchFile;
      let log;
      const prEnv = (extra = {}) => ({
        PATH: `${ghBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
        GH_FAKE_DIFF: patchFile,
        GH_FAKE_LOG: log,
        GH_FAKE_VIEW: JSON.stringify({ title: "Rename things", body: "Why: because.\nMore.", headRefOid: c2, baseRefName: "main" }),
        ...extra,
      });
      before(() => {
        patchFile = join(base, "pr.patch");
        log = join(base, "gh.log");
        writeFileSync(patchFile, git(repo, "diff", c1, c2).concat("\n"));
        git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
      });

      it("gives the same files and hunks as commit mode, although the PR diff has context lines", () => {
        const out = ok(repo, ["pr", "7"], prEnv());
        assert.match(out, /^diff-target: PR #7: files 5, hunks 4\n/);
        assert.match(out, /\nrepo: o\/r\n/);
        assert.match(out, /\ndiff: gh pr diff 7 -R o\/r\n/);
        assert.match(out, /\nrequirement \(PR title and body\):\n {2}Rename things\n\n {2}Why: because\.\n {2}More\.\n/);
        assert.equal(section(out, "files"), section(commitOut, "files"));
        const calls = readFileSync(log, "utf8");
        assert.ok(calls.includes("pr view 7 -R o/r --json title,body,headRefOid,baseRefName\n"));
        assert.ok(calls.includes("pr diff 7 -R o/r --color never\n"));
      });

      it("says yes, no or unknown for the head of the PR, and gives a worktree path unless it is yes", () => {
        const view = (headRefOid) => JSON.stringify({ title: "t", body: "", headRefOid, baseRefName: "main" });
        const yes = ok(repo, ["pr", "7"], prEnv());
        assert.match(yes, /\non current branch: yes\n/);
        assert.ok(!yes.includes("worktree:"));
        const no = ok(repo, ["pr", "7"], prEnv({ GH_FAKE_VIEW: view(side) }));
        assert.match(no, /\non current branch: no\n/);
        assert.match(no, new RegExp(`\\nworktree: \\.\\./${basename(repo)}-review-pr7\\n`));
        const unknown = ok(repo, ["pr", "7"], prEnv({ GH_FAKE_VIEW: view("0123456789abcdef0123456789abcdef01234567") }));
        assert.match(unknown, /\non current branch: unknown\n/);
        assert.match(unknown, /\nworktree: /);
      });

      it("takes owner/repo from the remote in each shape, and never prints the remote", () => {
        for (const url of ["https://github.com/o/r", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "https://user:secret@github.com/o/r.git"]) {
          git(repo, "remote", "set-url", "origin", url);
          const out = ok(repo, ["pr", "7"], prEnv());
          assert.match(out, /\nrepo: o\/r\n/, url);
          assert.ok(!out.includes("secret"), url);
        }
      });

      it("refuses a remote that is not on GitHub without printing it", () => {
        git(repo, "remote", "set-url", "origin", "https://user:secret@gitlab.com/o/r.git");
        const done = run(repo, ["pr", "7"], prEnv());
        assert.equal(done.status, 3);
        assert.equal(done.stdout, "");
        assert.match(done.stderr, /^diff-target: origin is not a github\.com remote/);
        assert.ok(!done.stderr.includes("secret"));
        git(repo, "remote", "set-url", "origin", "https://github.com/o/r.git");
      });

      it("refuses when gh fails, and when gh is not installed", () => {
        const failed = run(repo, ["pr", "7"], prEnv({ GH_FAKE_FAIL: "no such pull request" }));
        assert.equal(failed.status, 3);
        assert.match(failed.stderr, /^diff-target: gh pr view 7 -R o\/r: no such pull request\n/);
        const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
        const noGh = join(base, "nogh");
        mkdirSync(noGh);
        symlinkSync(gitPath, join(noGh, "git"));
        const missing = run(repo, ["pr", "7"], { PATH: noGh });
        assert.equal(missing.status, 3);
        assert.match(missing.stderr, /^diff-target: gh could not run/);
      });
    });
  });

  describe("snapshot, verify and expect", () => {
    const digestOf = (out) => /^snapshot: (sha256:[0-9a-f]{64})$/m.exec(out)[1];
    const expectedOf = (out) => /^expected: (expected:[0-9a-f]{64})$/m.exec(out)?.[1];
    const snap = (cwd, target) => digestOf(ok(cwd, ["snapshot", ...target]));
    const indexState = (repo) => [readFileSync(join(repo, ".git", "index")).toString("base64"), statSync(join(repo, ".git", "index")).mtimeMs];
    const editsFile = (edits) => {
      const path = join(base, `edits-${counter++}.json`);
      writeFileSync(path, JSON.stringify({ edits }));
      return path;
    };
    // a reviewed state of uncommitted changes: a.txt changed at line 3 and u.txt untracked; b.txt and c.txt unchanged
    const scene = () => {
      const repo = newRepo("snap");
      put(repo, "a.txt", tenLines());
      put(repo, "b.txt", "b\n");
      put(repo, "c.txt", "c\n");
      commit(repo, "first");
      put(repo, "a.txt", tenLines([3, "L3"]));
      put(repo, "u.txt", "u1\nu2\n");
      return repo;
    };
    const mismatch = (repo, digest, target = ["uncommitted"]) => {
      const done = run(repo, ["verify", digest, ...target]);
      assert.equal(done.status, 4, done.stderr);
      assert.equal(done.stderr, "");
      assert.ok(done.stdout.startsWith(`verify: mismatch: ${digest} was given, the checkout gives `), done.stdout);
      return done.stdout;
    };

    it("prints the inventory, the digest and the manifest; the same state gives the same digest and verify matches it", () => {
      const repo = scene();
      const out = ok(repo, ["snapshot", "uncommitted"]);
      assert.match(out, /^diff-target: uncommitted changes: files 2, hunks 2\nsnapshot: sha256:[0-9a-f]{64}\n/);
      for (const row of ["a.txt:3 change old 3,1 new 3,1", "u.txt:1 add new 1,2"]) assert.ok(section(out, "hunks").includes(`  ${row}\n`), row);
      const manifest = section(out, "manifest");
      for (const row of ["format review-diff-snapshot/1", `head ${git(repo, "rev-parse", "HEAD")}`, 'branch "main"', "target uncommitted", "new worktree"]) assert.ok(manifest.includes(`\n  ${row}\n`), row);
      assert.match(manifest, /\n {2}index sha256:[0-9a-f]{64}\n/);
      assert.match(manifest, /\n {2}path "a\.txt" file sha256:[0-9a-f]{64}\n {2}path "u\.txt" file sha256:[0-9a-f]{64}\n$/);
      const digest = digestOf(out);
      assert.equal(snap(repo, ["uncommitted"]), digest);
      assert.equal(ok(repo, ["verify", digest, "uncommitted"]), `verify: match ${digest}\n`);
      assert.equal(snap(base, ["-C", repo, "uncommitted"]), digest, "-C runs it in another folder");
    });

    it("leaves the index as it was, also when a tracked file only needs a refresh, and a stat-only change is not a change", () => {
      const repo = scene();
      const digest = snap(repo, ["uncommitted"]);
      const later = new Date(Date.now() + 5000);
      utimesSync(join(repo, "b.txt"), later, later);
      utimesSync(join(repo, "a.txt"), later, later);
      const index = indexState(repo);
      assert.equal(snap(repo, ["uncommitted"]), digest);
      assert.equal(run(repo, ["verify", digest, "uncommitted"]).status, 0);
      assert.equal(run(repo, ["expect", digest, editsFile([{ path: "a.txt", old: "L3\n", new: "L3!\n" }]), "uncommitted"]).status, 0);
      assert.deepEqual(indexState(repo), index);
    });

    it("gives a mismatch (exit 4), never a match, for each change of the reviewed state", () => {
      const cases = {
        "other bytes at the same coordinates": (repo) => put(repo, "a.txt", tenLines([3, "X3"])),
        "the index (the patch of git diff HEAD is the same)": (repo) => git(repo, "add", "a.txt"),
        "an untracked file changed": (repo) => put(repo, "u.txt", "u1\nU2\n"),
        "a new untracked file": (repo) => put(repo, "v.txt", "v\n"),
        "a tracked file deleted": (repo) => rmSync(join(repo, "c.txt")),
        "a rename": (repo) => renameSync(join(repo, "b.txt"), join(repo, "b2.txt")),
        "a file made executable": (repo) => chmodSync(join(repo, "a.txt"), 0o755),
        "HEAD moved": (repo) => git(repo, "commit", "-q", "--allow-empty", "-m", "later"),
      };
      for (const [name, change] of Object.entries(cases)) {
        const repo = scene();
        const digest = snap(repo, ["uncommitted"]);
        change(repo);
        assert.doesNotThrow(() => mismatch(repo, digest), name);
      }
    });

    it("gives a mismatch in another worktree with the same changes", () => {
      const repo = scene();
      const digest = snap(repo, ["uncommitted"]);
      const other = join(base, `wt-${counter++}`);
      git(repo, "worktree", "add", "-q", "--detach", other);
      put(other, "a.txt", tenLines([3, "L3"]));
      put(other, "u.txt", "u1\nu2\n");
      assert.match(mismatch(other, digest), new RegExp(`\\n {2}checkout ${JSON.stringify(git(other, "rev-parse", "--show-toplevel")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    });

    it("refuses (exit 3) a state it cannot read whole: a file of the diff turned into a folder, a ref that is gone, two reads that disagree", () => {
      const repo = scene();
      rmSync(join(repo, "c.txt"));
      mkdirSync(join(repo, "c.txt"));
      put(repo, "c.txt/inner.txt", "i\n");
      const folder = run(repo, ["snapshot", "uncommitted"]);
      assert.equal(folder.status, 3);
      assert.equal(folder.stdout, "");
      assert.match(folder.stderr, /^diff-target: c\.txt is a directory/);

      const moved = scene();
      git(moved, "branch", "gone");
      const digest = snap(moved, ["ref", "gone"]);
      git(moved, "branch", "-D", "gone");
      const lost = run(moved, ["verify", digest, "ref", "gone"]);
      assert.equal(lost.status, 3);
      assert.match(lost.stderr, /^diff-target: not a commit: gone\n/);

      const racing = scene();
      const root = git(racing, "rev-parse", "--show-toplevel");
      assert.throws(() => capture(root, "uncommitted", undefined, { between: () => put(racing, "a.txt", tenLines([3, "Y3"])) }), /the checkout changed while it was being read/);
      assert.doesNotThrow(() => capture(root, "uncommitted", undefined, { between: () => {} }));
    });

    describe("a commit", () => {
      let repo;
      let c2;
      before(() => {
        repo = newRepo("snap-commit");
        put(repo, "a.txt", tenLines());
        put(repo, "old.txt", lines("r1", "r2", "r3", "r4", "r5"));
        put(repo, "gone.txt", "g\n");
        put(repo, "x.txt", "x\n");
        commit(repo, "first");
        put(repo, "a.txt", tenLines([3, "L3"]));
        renameSync(join(repo, "old.txt"), join(repo, "renamed.txt"));
        rmSync(join(repo, "gone.txt"));
        c2 = commit(repo, "second");
      });

      it("captures a commit with a rename and a deletion: the old paths are absent, the checkout has no local change", () => {
        const out = ok(repo, ["snapshot", "commit", c2]);
        const files = section(out, "files");
        for (const row of ["M a.txt", "R old.txt -> renamed.txt (no line changes)", "D gone.txt"]) assert.ok(files.includes(`  ${row}\n`), row);
        const manifest = section(out, "manifest");
        for (const row of [`target commit ${c2}`, `base ${git(repo, "rev-parse", `${c2}^`)}`, `new ${c2}`, 'path "gone.txt" absent', 'path "old.txt" absent']) assert.ok(manifest.includes(`\n  ${row}\n`), row);
        assert.match(manifest, /\n {2}path "renamed\.txt" file sha256:/);
        assert.match(out, /\nlocal changes: none\n/);
      });

      it("gives a mismatch for a local change outside the commit, whose patch stays the same, and names it under local changes", () => {
        const out = ok(repo, ["snapshot", "commit", c2]);
        const digest = digestOf(out);
        put(repo, "x.txt", "X\n");
        try {
          const now = mismatch(repo, digest, ["commit", c2]);
          const patchLine = (text) => /\n {2}(patch sha256:[0-9a-f]{64})\n/.exec(text)[1];
          assert.equal(patchLine(now), patchLine(out));
          assert.match(ok(repo, ["snapshot", "commit", c2]), /\nlocal changes: 1 \("x\.txt"\)\n/);
        } finally {
          git(repo, "checkout", "-q", "x.txt");
        }
      });

      it("refuses a snapshot of a root commit, and refuses an edit of a file that changed after the reviewed commit", () => {
        const root = run(repo, ["snapshot", "commit", git(repo, "rev-list", "--max-parents=0", "HEAD")]);
        assert.equal(root.status, 3);
        assert.match(root.stderr, /is a root commit, which is not diffed: ask what to compare/);
        const digest = snap(repo, ["commit", c2]);
        assert.equal(run(repo, ["expect", digest, editsFile([{ path: "a.txt", old: "L3\n", new: "L3!\n" }]), "commit", c2]).status, 0);
        put(repo, "a.txt", tenLines([3, "L3"], [9, "L9"]));
        commit(repo, "later");
        const later = snap(repo, ["commit", c2]);
        const done = run(repo, ["expect", later, editsFile([{ path: "a.txt", old: "L3\n", new: "L3!\n" }]), "commit", c2]);
        assert.equal(done.status, 5);
        assert.match(done.stdout, /edit e1 "a\.txt": refused: the checkout's copy differs from the reviewed revision/);
        assert.match(done.stdout, /\napply in this order: none\n$/);
      });
    });

    describe("a pull request, with a fake gh", () => {
      let repo;
      let c1;
      let c2;
      let patchFile;
      const view = (headRefOid, baseRefOid) => JSON.stringify({ title: "t", body: "b", headRefOid, baseRefOid, baseRefName: "main" });
      const prEnv = (extra = {}) => ({ PATH: `${ghBin}:${process.env.PATH}`, GH_FAKE_DIFF: patchFile, GH_FAKE_VIEW: view(c2, c1), ...extra });
      before(() => {
        repo = newRepo("snap-pr");
        put(repo, "a.txt", tenLines());
        c1 = commit(repo, "first");
        git(repo, "checkout", "-q", "-b", "feature");
        put(repo, "a.txt", tenLines([3, "L3"], [8, "L8"]));
        put(repo, "n.txt", "n\n");
        c2 = commit(repo, "feature");
        git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
        patchFile = join(base, `pr-${counter++}.patch`);
        writeFileSync(patchFile, `${git(repo, "diff", c1, c2)}\n`);
      });

      it("binds the PR diff to its head and its merge base: the snapshot names both and matches on verify", () => {
        const out = ok(repo, ["snapshot", "pr", "7"], prEnv());
        assert.match(out, /^diff-target: PR #7: files 2, hunks 3\n/);
        assert.match(out, new RegExp(`\\ndiff: git diff ${c1} ${c2} \\(the PR's merge base and head; gh pr diff 7 -R o/r gives the same files and hunks\\)\\n`));
        const manifest = section(out, "manifest");
        for (const row of ["target pr 7 o/r", `base ${c1}`, `new ${c2}`, `pr-base ${c1}`]) assert.ok(manifest.includes(`\n  ${row}\n`), row);
        assert.equal(run(repo, ["verify", digestOf(out), "pr", "7"], prEnv()).status, 0);
      });

      it("refuses a PR diff that is cut, or that does not match its commits, a PR that moved while it was read and a PR whose commits are not here", () => {
        const text = readFileSync(patchFile, "utf8");
        const cut = join(base, `cut-${counter++}.patch`);
        writeFileSync(cut, text.split("\n").slice(0, -3).join("\n"));
        const other = join(base, `other-${counter++}.patch`);
        writeFileSync(other, `${git(repo, "diff", c1, c2, "--", "a.txt")}\n`);
        const counterFile = join(base, `count-${counter++}`);
        const cases = [
          [prEnv({ GH_FAKE_DIFF: cut }), /does not match git diff .*: the PR diff cannot be bound to its commits/],
          [prEnv({ GH_FAKE_DIFF: other }), /the PR diff cannot be bound to its commits/],
          [prEnv({ GH_FAKE_VIEWS: JSON.stringify([view(c2, c1), view(c1, c1)]), GH_FAKE_COUNTER: counterFile }), /^diff-target: PR #7 moved while it was being read/],
          [prEnv({ GH_FAKE_VIEW: view("0123456789abcdef0123456789abcdef01234567", c1) }), /is not in this repository: git fetch origin pull\/7\/head main, then run the command again/],
        ];
        for (const [env, message] of cases) {
          const done = run(repo, ["snapshot", "pr", "7"], env);
          assert.equal(done.status, 3, done.stderr);
          assert.equal(done.stdout, "");
          assert.match(done.stderr, message);
        }
      });
    });

    describe("expect", () => {
      it("accepts the edits inside the hunks and refuses, with the reason, an edit outside them, outside the diff or with an anchor that is not unique", () => {
        const repo = scene();
        const digest = snap(repo, ["uncommitted"]);
        const index = indexState(repo);
        const edits = editsFile([
          { id: "e1", path: "a.txt", old: "L3\n", new: "L3!\n" },
          { id: "e2", path: "a.txt", old: "l5\n", new: "L5\n" },
          { id: "e3", path: "b.txt", old: "b\n", new: "B\n" },
          { id: "e4", path: "u.txt", old: "u1\n", new: "u0\nu1\n" },
          { id: "e5", path: "a.txt", old: "l1", new: "L1" },
        ]);
        const done = run(repo, ["expect", digest, edits, "uncommitted"]);
        assert.equal(done.status, 5, done.stderr);
        const rows = done.stdout.split("\n");
        assert.equal(rows[0], `expect: the checkout matches ${digest}`);
        for (const row of [
          'edit e1 "a.txt": ok, line 3',
          'edit e2 "a.txt": refused: it changes line 5, outside the hunks of the diff',
          'edit e3 "b.txt": refused: not a file of the reviewed diff',
          'edit e4 "u.txt": ok, an insertion after line 0',
          'edit e5 "a.txt": refused: the old text is found 2 times in the reviewed file',
          "apply in this order: e1, e4",
        ]) assert.ok(rows.includes(row), row);
        assert.equal(run(repo, ["verify", digest, "uncommitted"]).status, 0, "expect wrote nothing");
        assert.deepEqual(indexState(repo), index);

        const expected = expectedOf(done.stdout);
        put(repo, "a.txt", tenLines([3, "L3!"]));
        put(repo, "u.txt", "u0\nu1\nu2\n");
        assert.equal(ok(repo, ["verify", expected, "uncommitted"]), `verify: match ${expected}\n`);
        put(repo, "a.txt", tenLines([3, "L3!"], [5, "L5"]));
        assert.doesNotThrow(() => mismatch(repo, expected), "a refused edit applied as well is not the expected state");
      });

      it("refuses overlapping edits and the edits that depend on a refused one, and gives the expected state of a revert to the base", () => {
        const repo = scene();
        const digest = snap(repo, ["uncommitted"]);
        const done = run(repo, ["expect", digest, editsFile([
          { id: "a", path: "a.txt", old: "L3\n", new: "l3\n" },
          { id: "b", path: "a.txt", old: "L3", new: "L3x" },
          { id: "c", path: "u.txt", old: "u2\n", new: "U2\n", depends: ["b"] },
          { id: "d", path: "u.txt", old: "u1\n", new: "U1\n", depends: ["zz"] },
        ]), "uncommitted"]);
        assert.equal(done.status, 5);
        for (const row of ['edit a "a.txt": refused: it overlaps b', 'edit b "a.txt": refused: it overlaps a', 'edit c "u.txt": refused: it depends on b, which is refused', 'edit d "u.txt": refused: it depends on zz, which is not in the edits file', "apply in this order: none"]) {
          assert.ok(done.stdout.split("\n").includes(row), row);
        }
        assert.equal(expectedOf(done.stdout), undefined, "no expected state when nothing is accepted");

        const revert = run(repo, ["expect", digest, editsFile([{ path: "a.txt", old: "L3\n", new: "l3\n" }]), "uncommitted"]);
        assert.equal(revert.status, 0, revert.stdout);
        put(repo, "a.txt", tenLines());
        assert.equal(run(repo, ["verify", expectedOf(revert.stdout), "uncommitted"]).status, 0, "a.txt left the diff, as expected");
      });

      it("checks the digest first, and refuses an edits file inside the checkout", () => {
        const repo = scene();
        const digest = snap(repo, ["uncommitted"]);
        const wrong = `sha256:${"0".repeat(64)}`;
        const stale = run(repo, ["expect", wrong, editsFile([{ path: "a.txt", old: "L3\n", new: "L3!\n" }]), "uncommitted"]);
        assert.equal(stale.status, 4);
        assert.ok(!stale.stdout.includes("\nedit "), "no verdict on edits against another state");
        writeFileSync(join(repo, "edits.json"), JSON.stringify({ edits: [{ path: "a.txt", old: "L3\n", new: "L3!\n" }] }));
        const inside = run(repo, ["expect", digest, "edits.json", "uncommitted"]);
        assert.equal(inside.status, 2);
        assert.match(inside.stderr, /is inside the checkout, where it changes the reviewed state: write it outside/);
      });
    });
  });

  describe("usage and refusals", () => {
    it("exits 2 with a message on stderr and nothing on stdout when the arguments are wrong", () => {
      const repo = newRepo("usage");
      const digest = `sha256:${"a".repeat(64)}`;
      for (const args of [[], ["bogus"], ["commit"], ["pr", "abc"], ["pr", "-1"], ["uncommitted", "extra"], ["commit", "a", "b"], ["--flag"], ["constructor"], ["snapshot"], ["verify", "uncommitted"], ["verify", "sha256:12", "uncommitted"], ["expect", `expected:${"a".repeat(64)}`, "e.json", "uncommitted"], ["expect", digest, "uncommitted"], ["-C", join(base, "no-such-folder"), "uncommitted"]]) {
        const done = run(repo, args);
        assert.equal(done.status, 2, args.join(" "));
        assert.equal(done.stdout, "", args.join(" "));
        assert.match(done.stderr, /^diff-target: /, args.join(" "));
      }
    });

    it("exits 3 outside a git repository, and in a repository with no commit", () => {
      const plain = mkdtempSync(join(base, "plain-"));
      const outside = run(plain, ["uncommitted"], { GIT_CEILING_DIRECTORIES: base });
      assert.equal(outside.status, 3);
      assert.match(outside.stderr, /^diff-target: not inside a git repository\n/);
      const empty = newRepo("empty");
      const unborn = run(empty, ["uncommitted"]);
      assert.equal(unborn.status, 3);
      assert.equal(unborn.stdout, "");
    });
  });
});
