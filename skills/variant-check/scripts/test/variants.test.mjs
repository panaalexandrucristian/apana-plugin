import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(SKILL, "scripts", "variants.mjs");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("variants.mjs", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "variant-check-"));
    writeFileSync(join(dir, "a.txt"), "[tool_result] ok\n[tool_result] ok\nplain\n[tool_result ERROR] boom\n");
    writeFileSync(join(dir, "b.txt"), "x\t y\n[tool_result] again\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "skipped.txt"), "[tool_result SKIPPED]\n");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "skipped.txt"), "[tool_result SKIPPED]\n");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x5b, 0x74, 0x00, 0x5d, 0x0a]));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("lists each distinct match once, most frequent first, with its count and first location", () => {
    const result = run("\\[tool_result[^\\]]*\\]", dir);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split("\n");
    assert.match(lines[0], /^4 matches, 2 distinct variants, 2 files read \(1 files skipped/);
    assert.match(lines[1], /^ +3  "\[tool_result\]"  first: .*a\.txt:1$/);
    assert.match(lines[2], /^ +1  "\[tool_result ERROR\]"  first: .*a\.txt:4$/);
    assert.equal(lines.length, 3);
  });

  it("skips .git, node_modules and files with a NUL byte", () => {
    const result = run("SKIPPED|\\[t\\0", dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^0 matches, 0 distinct variants, 2 files read \(1 files skipped/);
  });

  it("shows tabs and odd spaces escaped so two look-alike variants stay apart", () => {
    const result = run("x\\s+y", dir);
    assert.match(result.stdout, /"x\\t y"/);
  });

  it("keeps the case of each variant even with --ignore-case", () => {
    writeFileSync(join(dir, "case.log"), "Error\nERROR\nerror\nError\n");
    const result = run("--ignore-case", "error", join(dir, "case.log"));
    assert.match(result.stdout, /^4 matches, 3 distinct variants/);
    assert.match(result.stdout, /2  "Error"/);
    assert.match(result.stdout, /1  "ERROR"/);
    assert.match(result.stdout, /1  "error"/);
  });

  it("--top cuts the list and says how many variants are hidden", () => {
    writeFileSync(join(dir, "many.txt"), "v1\nv2\nv3\nv4\nv5\n");
    const result = run("--top", "2", "v\\d", join(dir, "many.txt"));
    const lines = result.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[3], /… 3 more variants \(raise --top\)/);
  });

  it("cuts a very long variant and ignores empty matches, reporting how many", () => {
    writeFileSync(join(dir, "long.txt"), `${"a".repeat(500)}\nb\n`);
    const result = run("a*", join(dir, "long.txt"));
    assert.match(result.stdout, /\(\d+ empty matches ignored\)/);
    const row = result.stdout.split("\n")[1];
    assert.ok(row.includes("…"), "long variant cut");
    assert.ok(row.length < 260, `row is ${row.length} chars`);
  });

  it("exits 2 with a usage line on an invalid pattern, a missing argument, a bad --top or an unreadable path", () => {
    for (const args of [["(", dir], ["only-a-pattern"], ["--top", "0", "x", dir], ["--top", "x", dir], ["x", join(dir, "nope")]]) {
      const result = run(...args);
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.ok(result.stderr.length > 0, args.join(" "));
    }
  });

  it("reads a file larger than one line buffer and a final line without a newline", () => {
    writeFileSync(join(dir, "tail.txt"), `${"x ".repeat(100000)}\n[last]`);
    const result = run("\\[last\\]", join(dir, "tail.txt"));
    assert.match(result.stdout, /^1 matches, 1 distinct variants/);
    assert.match(result.stdout, /tail\.txt:2$/m);
  });
});

describe("variant-check SKILL.md", () => {
  const source = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const lines = source.replace(/\n$/, "").split("\n");

  it("has the name of its folder, a description within 1,000 characters and the script in allowed-tools", () => {
    assert.equal(lines[0], "---");
    assert.equal(lines[1], "name: variant-check");
    const description = lines[2].replace(/^description: "/, "").replace(/"$/, "");
    assert.ok(lines[2].startsWith('description: "') && description.length <= 1000, `description is ${description.length} chars`);
    assert.ok(/scrie un regex/.test(description), "Romanian trigger");
    assert.equal(lines[3], "allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/variants.mjs *)");
    assert.equal(lines[4], "---");
  });

  it("states the rule word for word, the three steps and the no-data limit, in at most 50 lines", () => {
    assert.ok(lines.length <= 50, `${lines.length} lines`);
    assert.ok(
      source.includes(
        "Before writing any matcher or filter over text records, list every distinct variant of the matched token that actually occurs in the real data and handle each one; after the change, diff your output against the old output on real data and explain every difference.",
      ),
    );
    for (const heading of ["## Steps", "## Limits", "## Evidence"]) assert.ok(lines.includes(heading), heading);
    assert.ok(/No real data/.test(source) && /do not invent variants/.test(source));
  });

  it("carries the same rule as the claude-auto wrapper appends to the system prompt", () => {
    const wrapper = readFileSync(join(SKILL, "..", "install-claude-auto", "assets", "claude-auto"), "utf8");
    const literal = wrapper.match(/^VARIANT_RULE = \(([\s\S]*?)\)$/m);
    assert.ok(literal, "VARIANT_RULE not found");
    const rule = [...literal[1].matchAll(/"([^"]*)"/g)].map((part) => part[1]).join("");
    assert.ok(rule.length > 100, rule);
    assert.ok(source.includes(`> ${rule}`), rule);
  });

  it("labels its numbers and names its sample size", () => {
    assert.ok(/MEASURED, one task/.test(source) && /n = 2/.test(source) && /Too few runs to call it proven/.test(source));
    assert.ok(!/council|member [ABC]\b|consensus/i.test(source));
  });
});
