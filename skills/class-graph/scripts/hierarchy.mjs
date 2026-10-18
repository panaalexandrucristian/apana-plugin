// The family of a class: its own name and every class in the project's Kotlin and
// Java files that extends or implements it, directly or through other classes.
// Found level by level: ripgrep lists the files that mention the names found so
// far, and the supertypes declared in those files give the next names. Names are
// simple names, so two classes with one name share a family (a safe over-match).
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseJavaClasses, parseKotlin } from "./kotlin-symbols.mjs";
import { blankNoise } from "./lex.mjs";
import { candidateFiles, forEachPooled } from "./scan.mjs";

export const FAMILY_LIMITS = Object.freeze({ maxDepth: 8, maxNames: 3000, pool: 8, maxFileBytes: 2 * 1024 * 1024 });

/** Memoised reader of the classes declared in a file (Kotlin or Java), by path relative to `root`. */
export function createClassIndex(root) {
  const memo = new Map();
  const read = async (rel) => {
    try {
      const abs = join(root, rel);
      if ((await stat(abs)).size > FAMILY_LIMITS.maxFileBytes) return [];
      const raw = await readFile(abs, "utf8");
      return extname(rel) === ".java" ? parseJavaClasses(blankNoise(raw, { templates: false })) : parseKotlin(raw).classes;
    } catch {
      return [];
    }
  };
  return (rel) => {
    if (!memo.has(rel)) memo.set(rel, read(rel));
    return memo.get(rel);
  };
}

/** Set of class names: `owner` and everything below it. `classesOf` comes from createClassIndex. */
export async function classFamily(root, owner, classesOf) {
  const family = new Set([owner]);
  let frontier = [owner];
  for (let depth = 0; frontier.length > 0 && depth < FAMILY_LIMITS.maxDepth && family.size < FAMILY_LIMITS.maxNames; depth++) {
    const files = await candidateFiles(root, frontier, { globs: ["*.kt", "*.java"] });
    const found = [];
    await forEachPooled(files, FAMILY_LIMITS.pool, async (rel) => {
      for (const cls of await classesOf(rel)) {
        if (family.has(cls.name) || !cls.supers.some((name) => family.has(name))) continue;
        family.add(cls.name);
        found.push(cls.name);
      }
    });
    frontier = found;
  }
  return family;
}
