import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL = join(ROOT, "skills", "logic-test-debug", "SKILL.md");
const EVIDENCE = join(ROOT, "skills", "logic-test-debug", "reference", "evidence.md");

const DESCRIPTION =
  'Use when writing or changing code, reading Boolean conditions, designing tests for combined conditions, or fixing bugs ("implement", "debug", "fix a bug", "scrie cod", "repară un bug", "depanează"). Do not use for non-code requests.';
const PURPOSE = "Help read conditions clearly, test condition combinations and debug in a fixed sequence, with each rule marked by how strong its evidence is.";
// Section order and line caps (headings and blank lines included); the whole file is at most 90 lines.
const SECTIONS = [
  ["# logic-test-debug", 5],
  ["## Activation and scope", 7],
  ["## Evidence labels", 6],
  ["## Read conditions", 12],
  ["## Test combinations", 12],
  ["## Debug: seven steps", 18],
  ["## Operational adaptations", 8],
  ["## Guardrails", 10],
  ["## Work record", 8],
];
const RULES = ["N1", "N2", "N3", "N4", "N5", "C1", "C2", "C3", "C4", "C5", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "W1", "W2", "W3"];
const EVIDENCE_HEADINGS = [
  "# Evidence for logic-test-debug",
  "## Source inventory and status",
  "## Evidence labels and rule index",
  "## Baron: condition reading",
  "## Kuhn: interaction testing",
  "## Maleti and Nel: seven debugging steps",
  "### Original C++ sub-activities (verbatim)",
  "### Branches and retest loop",
  "### Reasoning, experience and setbacks",
  "## Operational adaptations (INFERENCE)",
  "## Guardrails and applicability exceptions",
  "## Observable behaviours",
];

const source = readFileSync(SKILL, "utf8");
const lines = source.replace(/\n$/, "").split("\n");
const headingIndexes = lines.map((line, index) => (/^#{1,2} /.test(line) ? index : -1)).filter((index) => index >= 0);

describe("logic-test-debug SKILL.md", () => {
  it("exists with the exact frontmatter name and the approved description (at most 600 characters)", () => {
    assert.ok(existsSync(SKILL));
    assert.equal(lines[0], "---");
    assert.equal(lines[1], "name: logic-test-debug");
    assert.equal(lines[2], `description: ${DESCRIPTION}`);
    assert.equal(lines[3], "---");
    assert.ok(DESCRIPTION.length <= 600);
    assert.ok(/scrie cod/.test(DESCRIPTION) && /repară un bug/.test(DESCRIPTION) && /depanează/.test(DESCRIPTION), "Romanian triggers");
    assert.match(DESCRIPTION, /Do not use for non-code requests\.$/);
  });
  it("states the approved purpose and links the reference file", () => {
    assert.ok(source.includes(`\n${PURPOSE}\n`));
    assert.match(source, /\[`reference\/evidence\.md`\]\(reference\/evidence\.md\)/);
  });
  it("has the approved headings in order and every section within its line cap", () => {
    assert.deepEqual(headingIndexes.map((index) => lines[index]), SECTIONS.map(([heading]) => heading));
    headingIndexes.forEach((start, k) => {
      const end = k + 1 < headingIndexes.length ? headingIndexes[k + 1] : lines.length;
      assert.ok(end - start <= SECTIONS[k][1], `${SECTIONS[k][0]} has ${end - start} lines, cap ${SECTIONS[k][1]}`);
    });
    assert.ok(headingIndexes[0] <= 4, "frontmatter within 4 lines");
  });
  it("is at most 90 lines in total", () => {
    assert.ok(lines.length <= 90, `${lines.length} lines`);
  });
  it("has the 22 rules once each, with a label, an applicability and a statement of at most 25 words", () => {
    const found = [];
    for (const line of lines) {
      const match = line.match(/^([NCDW]\d) \[(CLEAR|DESCRIPTIVE|INFERENCE), (both|bug fixing)\] (.+?) Not when: .+\.$/);
      if (!match) continue;
      found.push(match[1]);
      const words = match[4].trim().split(/\s+/).length;
      assert.ok(words <= 25, `${match[1]} statement has ${words} words`);
      assert.ok(match[4].length > 20);
    }
    assert.deepEqual(found, RULES);
  });
  it("labels the rules from their sources: N1-N3 and C1 CLEAR, the debugging steps DESCRIPTIVE, W INFERENCE", () => {
    const label = (id) => lines.find((line) => line.startsWith(`${id} `)).match(/\[(\w+),/)[1];
    for (const id of ["N1", "N2", "N3", "C1"]) assert.equal(label(id), "CLEAR", id);
    for (const id of ["N4", "N5", "C2", "C3", "C4", "C5", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"]) assert.equal(label(id), "DESCRIPTIVE", id);
    for (const id of ["W1", "W2", "W3"]) assert.equal(label(id), "INFERENCE", id);
  });
  it("keeps the three-line work record with the exact labels", () => {
    assert.ok(source.includes("\nScope: [objective; relevant conditions/parameters and values].\n"));
    assert.ok(source.includes("\nMethod: [chosen t and reason, marked INFERENCE; or debugging step/branch; or condition-reading rule].\n"));
    assert.ok(source.includes("\nResult: [checks actually performed, coverage or outcome, and any blocker].\n"));
  });
  it("keeps the 1-way, 2-way and 3-way examples and the 13-versus-1,024 contrast", () => {
    assert.match(source, /1-way `pressure < 10`/);
    assert.match(source, /2-way `pressure < 10 && volume > 300`/);
    assert.match(source, /3-way adds `velocity = 5`/);
    assert.match(source, /1,024 exhaustive tests, 13 cover all triples/);
  });
  it("makes no promise of proof, speed-up or defect reduction and has no process text", () => {
    assert.match(source, /Never say "studies prove"/);
    assert.ok(!/council|member [ABC]\b|consensus/i.test(source));
    assert.ok(!/\b\d+ ?% (faster|fewer|reduction)/i.test(source));
  });
});

describe("logic-test-debug reference/evidence.md", () => {
  const evidence = readFileSync(EVIDENCE, "utf8");
  const headings = evidence.split("\n").filter((line) => /^#{1,3} /.test(line));

  it("has the approved headings in order", () => {
    assert.deepEqual(headings, EVIDENCE_HEADINGS);
  });
  it("indexes every rule of SKILL.md with a label, applicability and exception", () => {
    for (const id of ["N1", "N2", "N3", "N4", "N5", "C1", "C2", "C3", "C4", "C5", "D1-D7", "D8", "D9", "W1-W3"]) {
      assert.ok(new RegExp(`^\\| ${id} \\| (CLEAR|DESCRIPTIVE|INFERENCE)`, "m").test(evidence), `rule index row ${id}`);
    }
  });
  it("transcribes the original sub-activities of Fig. 3 verbatim, C++ wording included", () => {
    for (const text of [
      "Scan through the program",
      "Visualize what the program is trying to achieve",
      "Check fundamental C++ concepts",
      "Check pre-processor directives",
      "Check global and local declarations",
      "Check statements within the main()",
      "Build, compile, and run the program using C++ Debugger",
      "Use break points to reach lines with errors",
      "Check each line by line-locating error",
      "Locate (spot) the program error located by the C++ compiler",
      "Is the syntax correct?",
      "Are the semantics correct?",
      "Is the logic correct?",
      "Read through error logs, descriptions, and suggested solutions from the IDE Debugger",
      "Research on the Internet (e.g., visit Stack Overflow and YouTube to obtain more information about the bug)",
      "Ask someone who had similar problem(s)",
      "Dry-run the code (manually tracing values of variables)",
      "Fix the syntax error and go to Step 7",
      "Fix the semantic error and go to Step 7",
      "Fix the logical error and go to Step 7",
      "Re-test the program until it achieves the intended objective(s)",
      "Rebuild and re-run the program",
      "Repeat Step 3",
    ]) assert.ok(evidence.includes(text), text);
  });
  it("lists the 14 guardrails and the 16 observable behaviours", () => {
    const guard = evidence.slice(evidence.indexOf("## Guardrails and applicability exceptions"), evidence.indexOf("## Observable behaviours"));
    assert.equal([...guard.matchAll(/^\d+\. /gm)].length, 14);
    const behaviours = evidence.slice(evidence.indexOf("## Observable behaviours"));
    assert.equal([...behaviours.matchAll(/^\d+\. /gm)].length, 16);
  });
  it("states the source status honestly: pre-review manuscript, unread 2004 paper, no outcome test", () => {
    assert.match(evidence, /pre-review/i);
    assert.match(evidence, /NOT read/);
    assert.match(evidence, /no outcome test/);
    assert.match(evidence, /same NIST group|same group/);
    assert.ok(!/council|member [ABC]\b|consensus/i.test(evidence));
  });
  it("keeps the Baron numbers as reported", () => {
    for (const value of ["3.173e-13", "0.0001126", "0.07602", "6.205e-07", "7.803e-07", "0.5916", "0.0715", "0.002088", "0.7401"]) assert.ok(evidence.includes(value), value);
  });
});
