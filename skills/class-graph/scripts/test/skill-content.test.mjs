// Checks of the skill package itself: the frontmatter, the rules for what SKILL.md may
// contain, the activation fixtures, and that the bundled programs need nothing outside
// the skill folder. Node stdlib only.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = resolve(SCRIPTS, "..");
const skillText = readFileSync(join(SKILL, "SKILL.md"), "utf8");
const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillText) ?? [];
const description = /^description: "(.*)"$/m.exec(frontmatter ?? "")?.[1];
const fixtures = JSON.parse(readFileSync(join(SCRIPTS, "test", "activation-prompts.json"), "utf8"));

describe("SKILL.md", () => {
  it("has the name and a description of at most 800 characters", () => {
    assert.match(frontmatter, /^name: class-graph$/m);
    assert.ok(description, "a quoted description line exists");
    assert.ok(description.length <= 800, `description is ${description.length} characters`);
    for (const cue of ["cine folosește", "cine apelează", "unde este folosit", "/apana:class-graph", "Not for", "instead of grep", "function body lines", "în ce linii este funcția"]) assert.ok(description.includes(cue), cue);
  });

  it("lets the bundled scripts run without a permission prompt, by their own directory", () => {
    assert.match(frontmatter, /^allowed-tools: Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/\*\.mjs \*\)$/m);
    assert.equal(skillText.includes("<skill-dir>"), false, "the placeholder was replaced by the variable");
  });

  it("stays short enough to be read in every use", () => {
    assert.ok(body.split("\n").length <= 130, `${body.split("\n").length} lines`);
  });

  it("holds none of the content the skill must not carry", () => {
    for (const [pattern, why] of [
      [/council|consiliu/i, "production-process attribution"],
      [/\/Users\//, "a personal absolute path"],
      [/private\/find-usages/, "a dependency on the private folder"],
    ]) assert.equal(pattern.test(skillText), false, why);
  });

  it("bounds the find-usages output and says how the answer is formed", () => {
    assert.match(skillText, /find-usages[\s\S]*?always append `\| head -n 80`/);
    assert.match(skillText, /never presented as classes/);
    assert.match(skillText, /the NAME of the class, function or member used \(never true\/false\)/);
  });

  it("routes the three tools and bounds the find-def output", () => {
    for (const row of ["class-graph.mjs (sections 1-2)", "find-usages.mjs (section 3)", "find-def.mjs on one .kt file (section 4)", "Read/Grep/Glob outside the skill"]) assert.ok(skillText.includes(row), row);
    assert.match(skillText, /## 4\. find-def\.mjs/);
    assert.match(skillText, /find-def\.mjs <File\.kt> <name>/);
    assert.match(skillText, /find-def\.mjs <File\.kt> \| head -n 80/);
    assert.match(skillText, /ONE `\.kt` file; no Java, `\.kts` or project-wide mode/);
    assert.match(skillText, /Pass the SIMPLE name/);
    assert.match(skillText, /Read\(file_path=<absolute path>, offset=S, limit=E-S\+1\)/);
    assert.match(skillText, /rg -n -g '\*\.kt' 'fun \.\*\\b<name>\\\(' <project> \| head -n 80/);
    assert.match(skillText, /`\| tail -n \+81 \| head -n 80` and `\| tail -n \+161 \| head -n 80` \(3 pages at most/);
    assert.match(skillText, /A bare name needs no search first: run class-graph with it straight away/);
    assert.match(skillText, /A bare `\/apana:class-graph` \(nothing after the command\) switches the skill on for the session/);
    assert.match(skillText, /An explicit `\/apana:class-graph` request outside this scope: run nothing and ask/);
    for (const rule of ["- Exit 1:", "- Exit 2:", "label the range provisional", "Named functions only", "A scan, not a Kotlin parser"]) assert.ok(skillText.includes(rule), rule);
  });

  it("names only scripts that exist", () => {
    const named = new Set([...skillText.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/scripts\/([\w.-]+)/g)].map((m) => m[1]));
    assert.ok(named.has("class-graph.mjs") && named.has("find-usages.mjs") && named.has("find-def.mjs"));
    for (const name of named) assert.ok(existsSync(join(SCRIPTS, name)), name);
  });
});

describe("activation fixtures", () => {
  it("have unique ids, both languages and the expected sizes", () => {
    const all = [...fixtures.positive, ...fixtures.negative, ...fixtures.explicit];
    assert.equal(new Set(all.map((f) => f.id)).size, all.length);
    assert.ok(fixtures.positive.length >= 8 && fixtures.negative.length >= 6);
    assert.ok(fixtures.positive.some((f) => f.language === "ro"));
    for (const f of all) assert.ok(f.prompt && f.expected, f.id);
  });
});

describe("the bundle", () => {
  const entries = ["class-graph.mjs", "find-usages.mjs", "find-def.mjs"];
  /** Local files reached from the entry points by static imports, dynamic imports and new URL(...) references. */
  function closure() {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      const refs = [...source.matchAll(/from "(\.{1,2}\/[^"]+)"/g), ...source.matchAll(/import\("(\.{1,2}\/[^"]+)"\)/g), ...source.matchAll(/new URL\(`\.\/([^`$]+)`/g), ...source.matchAll(/new URL\("(\.{1,2}\/[^"]+)"/g)].map((m) => m[1]);
      for (const ref of refs) visit(resolve(dirname(file), ref.startsWith(".") ? ref : `./${ref}`));
    };
    for (const entry of entries) visit(join(SCRIPTS, entry));
    return seen;
  }

  it("reaches only files inside scripts/, and they all exist", () => {
    for (const file of closure()) {
      assert.ok(file.startsWith(SCRIPTS + sep), `${file} is outside scripts/`);
      assert.ok(existsSync(file), `${file} is missing`);
    }
  });

  it("never reads the private folder at run time", () => {
    for (const file of closure()) assert.equal(/private\/find-usages/.test(readFileSync(file, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "")), false, file);
  });
});

describe("synchronisation with the development copy", () => {
  const REPO = resolve(SKILL, "..", "..");
  const source = join(REPO, "private", "find-usages");
  const available = existsSync(join(source, "graph.mjs"));

  it("shows no difference", { skip: !available && "the development copy (private/) is not present in this package" }, () => {
    const compare = (bundled, original, normalise = (text) => text) => assert.equal(readFileSync(bundled, "utf8"), normalise(readFileSync(original, "utf8")), `${bundled} differs from ${original}`);
    for (const name of ["class-graph", "find-usages", "find-def", "definitions", "graph", "graph-cache", "cache-lock", "graph-render", "hierarchy", "kotlin-symbols", "lex", "render", "rules", "scan", "usages"]) compare(join(SCRIPTS, `${name}.mjs`), join(source, `${name}.mjs`));
  });
});
