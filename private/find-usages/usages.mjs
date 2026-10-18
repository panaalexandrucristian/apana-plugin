// Find usages of the symbols a Kotlin file declares (Node stdlib only). One
// ripgrep pass lists the files that mention any of the names; each such file is
// then read once, blanked of comments and strings, and every whole-word match is
// classified by rules.mjs. Memory stays bounded: one pool of files in flight and
// a capped list of hits per symbol and tier.
import { readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { classFamily, createClassIndex } from "./hierarchy.mjs";
import { parseHeader, parseJavaClasses, parseKotlin } from "./kotlin-symbols.mjs";
import { blankNoise, blankXmlComments } from "./lex.mjs";
import { classify, TIERS, wordRegExp } from "./rules.mjs";
import { candidateFiles, forEachPooled } from "./scan.mjs";

export const LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  pool: 8,
  maxHits: 200, // per symbol and tier
  snippetChars: 160,
});

export class UsageError extends Error {}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function symbolGroups(parsed, relFile, { name, includePrivate, includeOverride }) {
  let symbols = parsed.symbols;
  if (name) {
    symbols = symbols.filter((s) => s.name === name);
    if (symbols.length === 0) {
      const known = [...new Set(parsed.symbols.map((s) => s.name))].sort();
      throw new UsageError(`no declaration named "${name}" in ${relFile}; declared here: ${known.slice(0, 40).join(", ") || "nothing found"}`);
    }
  } else {
    symbols = symbols.filter((s) => (includePrivate || !s.private) && (includeOverride || !s.override));
  }
  const groups = new Map();
  for (const s of symbols) {
    const key = `${s.owner ?? ""}\0${s.name}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        name: s.name,
        kind: s.kind,
        owner: s.owner,
        declPkg: parsed.pkg,
        declPath: relFile,
        line: s.line,
        declLines: new Set(),
        private: true,
        decls: 0,
        hits: { certain: [], likely: [], ambiguous: [] },
        counts: { certain: 0, likely: 0, ambiguous: 0, other: 0, decl: 0, noise: 0, truncated: 0 },
      };
      groups.set(key, group);
    }
    group.declLines.add(s.line);
    group.decls += 1;
    group.private &&= s.private;
  }
  return [...groups.values()];
}

/** Count of whole-word matches per name over a whole text (`re` must be global). */
function wordCounts(text, re) {
  const counts = new Map();
  for (const match of text.matchAll(re)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  return counts;
}

const familyPatterns = new WeakMap();

/** One matcher for all names of a family, built once per family. */
function familyPattern(family) {
  if (!familyPatterns.has(family)) familyPatterns.set(family, new RegExp(`(?<![\\w$])(?:${[...family].map(escapeRegExp).join("|")})(?![\\w$])`));
  return familyPatterns.get(family);
}

async function scanOne(root, rel, byName, matcher, options) {
  const abs = join(root, rel);
  if ((await stat(abs)).size > LIMITS.maxFileBytes) return false;
  const raw = await readFile(abs, "utf8");
  const ext = extname(rel).slice(1);
  const blanked = ext === "xml" ? blankXmlComments(raw) : blankNoise(raw, { templates: ext === "kt" });
  const shape = ext === "kt" ? parseKotlin(raw, { blanked }) : { ...parseHeader(blanked), classes: ext === "java" ? parseJavaClasses(blanked) : [], extFuns: [] };
  const mentioned = new Map();
  const mentionedFamily = new Map();
  const inRange = (item, line) => item.start <= line && line <= item.end;
  const file = {
    path: rel,
    ext,
    pkg: shape.pkg,
    imports: shape.imports,
    mentions(name) {
      if (!mentioned.has(name)) mentioned.set(name, wordRegExp(name).test(blanked));
      return mentioned.get(name);
    },
    mentionsFamily(family) {
      if (!mentionedFamily.has(family)) mentionedFamily.set(family, familyPattern(family).test(blanked));
      return mentionedFamily.get(family);
    },
    insideFamily: (family, line) =>
      shape.classes.some((cls) => family.has(cls.name) && inRange(cls, line)) || shape.extFuns.some((fun) => family.has(fun.receiver) && inRange(fun, line)),
  };
  const rawLines = raw.split("\n");
  const lines = blanked.split("\n");
  const inCode = new Map();
  for (let n = 0; n < lines.length; n++) {
    const lineText = lines[n];
    matcher.lastIndex = 0;
    for (let match = matcher.exec(lineText); match; match = matcher.exec(lineText)) {
      inCode.set(match[0], (inCode.get(match[0]) ?? 0) + 1);
      for (const group of byName.get(match[0])) {
        const { tier, why } = classify(group, file, { line: n + 1, col: match.index, lineText });
        if (tier === "skip") continue;
        group.counts[tier] += 1;
        if (!TIERS.includes(tier)) continue;
        if (group.hits[tier].length >= options.maxHits) {
          group.counts.truncated += 1;
          continue;
        }
        group.hits[tier].push({ path: rel, line: n + 1, col: match.index + 1, why, text: rawLines[n].trim().slice(0, LIMITS.snippetChars) });
      }
    }
  }
  for (const [name, count] of wordCounts(raw, matcher)) {
    const noise = count - (inCode.get(name) ?? 0);
    if (noise > 0) for (const group of byName.get(name)) group.counts.noise += noise;
  }
  return true;
}

/**
 * {file, root, pkg, groups, stats}. `file` is the Kotlin file whose declarations
 * are searched for; `name` limits the search to one declared name.
 */
export async function findUsages({ file, name = null, root = null, maxHits = LIMITS.maxHits, includePrivate = false, includeOverride = false }) {
  const started = performance.now();
  const abs = resolve(file);
  if (extname(abs) !== ".kt") throw new UsageError("only Kotlin (.kt) files are supported as the starting point for now");
  const base = root ? resolve(root) : resolve(abs, "..");
  const relFile = relative(base, abs);
  if (relFile.startsWith("..")) throw new UsageError(`${file} is outside the search root ${base}`);
  const parsed = parseKotlin(await readFile(abs, "utf8"));
  const groups = symbolGroups(parsed, relFile, { name, includePrivate, includeOverride });
  const byName = new Map();
  for (const group of groups) byName.set(group.name, [...(byName.get(group.name) ?? []), group]);
  const names = [...byName.keys()];
  const files = names.length ? await candidateFiles(base, names) : [];
  const matcher = new RegExp(`(?<![\\w$])(?:${names.map(escapeRegExp).join("|")})(?![\\w$])`, "g");
  const families = new Map();
  const classesOf = createClassIndex(base);
  const owners = [...new Set(groups.filter((g) => g.owner && !g.private).map((g) => g.owner))];
  await forEachPooled(owners, 4, async (owner) => families.set(owner, await classFamily(base, owner, classesOf)));
  for (const group of groups) {
    if (families.has(group.owner)) Object.defineProperty(group, "family", { value: families.get(group.owner), enumerable: false });
  }
  let skipped = 0;
  await forEachPooled(files, LIMITS.pool, async (rel) => {
    if (!(await scanOne(base, rel, byName, matcher, { maxHits }))) skipped += 1;
  });
  for (const group of groups) {
    for (const tier of TIERS) group.hits[tier].sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
    group.declLines = [...group.declLines];
  }
  return {
    file: relFile,
    root: base,
    pkg: parsed.pkg,
    groups,
    stats: { candidates: files.length, skipped, families: Object.fromEntries([...families].map(([owner, set]) => [owner, set.size])), ms: Math.round(performance.now() - started), rssMb: Math.round(process.memoryUsage().rss / 1048576) },
  };
}
