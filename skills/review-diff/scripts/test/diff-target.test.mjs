// Tests of diff-target.mjs: the pure parsers on synthetic text, then the program itself against throwaway git
// repositories and a fake `gh` (no network). Node stdlib only; the git cases are skipped when git is missing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHunkHeader, parsePatch, parseRemote, unquotePath } from "../diff-target.mjs";

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
const { appendFileSync, readFileSync } = require("node:fs");
const env = process.env;
if (env.GH_FAKE_LOG) appendFileSync(env.GH_FAKE_LOG, process.argv.slice(2).join(" ") + "\\n");
if (env.GH_FAKE_FAIL) { console.error(env.GH_FAKE_FAIL); process.exit(1); }
const [, , group, sub] = process.argv;
if (group === "pr" && sub === "view") process.stdout.write(env.GH_FAKE_VIEW);
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

  describe("usage and refusals", () => {
    it("exits 2 with a message on stderr and nothing on stdout when the arguments are wrong", () => {
      const repo = newRepo("usage");
      for (const args of [[], ["bogus"], ["commit"], ["pr", "abc"], ["pr", "-1"], ["uncommitted", "extra"], ["commit", "a", "b"], ["--flag"], ["constructor"]]) {
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
