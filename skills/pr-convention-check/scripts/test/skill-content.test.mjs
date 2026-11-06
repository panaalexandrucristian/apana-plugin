// Checks of the skill package itself: the frontmatter, the eight steps, the strict read-only rules, the reference threshold, the report and the done criteria. Node stdlib only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillText = readFileSync(join(SKILL, "SKILL.md"), "utf8");
const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillText) ?? [];
const description = /^description: "(.*)"$/m.exec(frontmatter ?? "")?.[1];
const section = (title) => new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(body)?.[1] ?? "";

describe("frontmatter", () => {
  it("has the name, a quoted description under 1024 characters that says what it does and when to use it, and the argument hint", () => {
    assert.match(frontmatter, /^name: pr-convention-check$/m);
    assert.ok(description, "a quoted description line exists");
    assert.ok(description.length < 1024, `description is ${description.length} characters`);
    for (const cue of ["Use when", "/apana:pr-convention-check", "verifică dacă ce am făcut e aliniat cu restul aplicației", "compară cu commiturile recente", "split pe funcționalități și decizii tehnice", "Read-only"]) assert.ok(description.includes(cue), `description mentions ${cue}`);
    assert.match(frontmatter, /^argument-hint: \[ref\]$/m);
    assert.doesNotMatch(skillText, /base-ref/, "the argument is a candidate for <ref>, not for <base>");
  });

  it("lets the model start it: no disable-model-invocation", () => {
    assert.doesNotMatch(frontmatter, /disable-model-invocation/);
  });

  it("is finished: no TODO or DRAFT, no dependency on android-pr-review", () => {
    assert.doesNotMatch(skillText, /TODO|DRAFT/);
    assert.doesNotMatch(skillText, /android-pr-review/);
  });
});

describe("strict rules", () => {
  const rules = section("Strict rules");

  it("forbid every write and fetch, and gradle", () => {
    for (const word of ["checkout", "edit", "stage", "stash", "commit", "push", "fetch", "gradle"]) assert.ok(rules.includes(word), `rules mention ${word}`);
    assert.match(rules, /Read-only/);
  });

  it("read references with git show, git log and git grep and report only verified facts with hash and file:line", () => {
    for (const cmd of ["git show <hash>", "git show <ref>:<path>", "git log", "git grep"]) assert.ok(rules.includes(cmd), `rules mention ${cmd}`);
    assert.match(rules, /only verified facts/);
    assert.match(rules, /`hash` \+ `file:line`/);
  });

  it("give your own code the hash of HEAD and label every number with what it counts", () => {
    assert.match(rules, /For your own code the hash is `HEAD`'s/);
    assert.match(rules, /Label every number with what it counts \(files, occurrences, commits\)/);
  });

  it("read the real line of your own code with git show or git grep, not a hunk position", () => {
    assert.match(rules, /read it with `git show HEAD:<file>` or `git grep -n <text> HEAD -- <file>`/);
    assert.match(rules, /`git diff` has no absolute line numbers/);
    assert.match(rules, /a hunk position such as "old line 134" is not a `file:line`/);
  });

  it("take a reference's quote and line from the revision of its own hash, never from <base>, HEAD or the tip of <ref> under an older hash", () => {
    assert.match(rules, /A quote or line of a reference comes from that reference's own revision/);
    assert.match(rules, /read it with `git show <hash>:<file>`/);
    assert.match(rules, /Never take it from `<base>`, `HEAD` or the tip of `<ref>` and put the commit's hash on it/);
    assert.match(rules, /cite code read at the tip of `<ref>` as `<ref>:<file>:<line>`/);
  });

  it("copy each number from the output of the command that gave it", () => {
    assert.match(rules, /Copy each number from the output of that command: do not add up, count by eye or estimate/);
  });

  it("apply the repository docs over the user's preference and propose deleting or updating the preference", () => {
    assert.match(rules, /apply the docs and propose deleting \(or updating\) the preference/);
    assert.doesNotMatch(skillText, /apply your preference/i);
  });
});

describe("steps", () => {
  const headings = [...body.matchAll(/^### (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]);

  it("are the eight steps, in order", () => {
    assert.deepEqual(headings.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  const stepText = (n) => {
    const start = body.indexOf(`### ${n}. `);
    const next = body.indexOf(`### ${n + 1}. `);
    const end = next === -1 ? body.indexOf("\n## ", start) : next;
    return body.slice(start, end === -1 ? undefined : end);
  };

  it("step 1 asks for <ref> on every run with its date, never picks one, asks the target once, uses three dots and a confirmed base", () => {
    const step = stepText(1);
    assert.match(step, /Ask for `<ref>` on every run/);
    assert.match(step, /git log -1 --format=%cd --date=short <ref>/);
    assert.match(step, /Do not pick `origin\/develop` or `origin\/HEAD` yourself/);
    assert.match(step, /ask once/);
    assert.match(step, /<base>\.\.\.HEAD/);
    assert.doesNotMatch(step, /<base>\.\.[^.]/);
    assert.match(step, /staged, unstaged or both/);
    assert.match(step, /untracked/);
    assert.match(step, /merge-base/);
    assert.match(step, /confirm/);
    assert.match(step, /--numstat -M/);
  });

  it("step 3 keeps the examples illustrative", () => {
    const step = stepText(3);
    assert.match(step, /not exhaustive/);
    assert.match(step, /not a mandatory taxonomy/);
    for (const example of ["experiment", "UiState", "ViewHolder", "reduced motion", "DI"]) assert.ok(step.includes(example), `step 3 mentions ${example}`);
  });

  it("step 4 takes the 3-4 most recent references, newest first, and continues with fewer: 2 is the minimum, 1 is single precedent, 0 is no precedent with verdict (c)", () => {
    const step = stepText(4);
    assert.match(step, /3-4 most recent/);
    assert.match(step, /newest first/);
    assert.match(step, /git log <ref> --no-merges/);
    assert.match(step, /git grep <symbol> <ref>/);
    assert.match(step, /never stop to ask/);
    assert.match(step, /2 or more references meet the criterion/);
    assert.match(step, /"single precedent"/);
    assert.match(step, /"no precedent", verdict \(c\)/);
    assert.match(step, /neighbouring code is the standard/);
  });

  it("step 5 has the element-by-element table and step 6 the three verdicts", () => {
    assert.match(stepText(5), /aspect \| reference does \| I do \| same\? \| `hash` `file:line`/);
    const step = stepText(6);
    for (const verdict of ["(a) justified", "(b) to fix", "(c) unclear"]) assert.ok(step.includes(verdict), `step 6 has ${verdict}`);
  });

  it("step 5 takes the reference does cell and its line from git show <hash>:<file> at that hash", () => {
    assert.match(stepText(5), /"reference does" cell and its line come from `git show <hash>:<file>` at that hash/);
  });

  it("step 5 puts only a verbatim one-line quote in backticks and checks it with git grep -n -F at the hash", () => {
    const step = stepText(5);
    assert.match(step, /A quote in backticks is one line copied verbatim/);
    assert.match(step, /git grep -n -F '<quote>' <hash> -- <file>/);
    assert.match(step, /no output means it is not at that hash/);
  });
  it("step 7 re-verifies every (b) directly in the code", () => {
    assert.match(stepText(7), /Every \(b\) deviation is read again directly in the code/);
  });

  it("step 8 is the report in four parts with the full step-5 tables and the deviations grouped (b), (c), (a)", () => {
    const step = stepText(8);
    assert.deepEqual([...step.matchAll(/^(\d)\. /gm)].map((m) => m[1]), ["1", "2", "3", "4"]);
    assert.match(step, /every step-5 table in full/);
    assert.ok(step.indexOf("(b) to fix") < step.indexOf("(c) to decide") && step.indexOf("(c) to decide") < step.indexOf("(a) justified"), "grouped (b), (c), (a)");
    assert.match(step, /date of its last commit/);
    assert.match(step, /no fetch was run/);
    assert.match(step, /docs found or absent/);
  });

  it("step 8 keeps the four parts in this order, numbered 1 to 4", () => {
    assert.match(stepText(8), /in this order, numbered 1 to 4/);
  });
});

describe("delegation and done criteria", () => {
  it("runs in the main session without subagents by default", () => {
    assert.match(section("Delegation"), /main session/);
    assert.match(section("Delegation"), /Do not start subagents by default/);
  });

  it("wants every file of the diff by its own name, without wildcards, in the pitfall and in criterion 1", () => {
    assert.match(section("Pitfalls"), /each by its own name: no wildcards/);
    assert.match(section("Done criteria"), /by its own file name \(no wildcards such as `Pdp\*Fragment`/);
  });

  it("has the five criteria, each with Verification and Evidence, and the reference check with git merge-base --is-ancestor", () => {
    const done = section("Done criteria");
    const criteria = done.split(/^- (?=Criterion \d)/m).slice(1);
    assert.equal(criteria.length, 5);
    criteria.forEach((text, i) => {
      assert.ok(text.startsWith(`Criterion ${i + 1}`), `criterion ${i + 1} is in order`);
      assert.match(text, /Verification:/);
      assert.match(text, /Evidence:/);
    });
    assert.match(done, /3-4 most recent/);
    assert.match(done, /minimum that counts is 2/);
    assert.match(criteria[1], /git merge-base --is-ancestor <hash> <ref>/);
    assert.match(criteria[2], /for every backticked quote in a "reference does" cell, `git grep -n -F` finds it at its hash/);
    assert.match(criteria[3], /git status --short/);
    assert.match(criteria[3], /git stash list/);
    assert.match(criteria[3], /git rev-parse HEAD/);
  });
});
