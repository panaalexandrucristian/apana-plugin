// Decides, from text alone, how likely a word match is a use of a declared
// symbol. Tiers: certain (an import, a qualified name or the declaring file),
// likely (same package, a wildcard import, an XML onClick), ambiguous (a member
// name whose receiver type is not visible: the cases the rules cannot settle) and other (a
// different symbol with the same name, such as one imported from another
// package). `decl` marks the declaration itself.
//
// Members of a class are judged with its family (the class and every project
// class that extends or implements it, directly or not): a call without a
// receiver belongs to the enclosing class, so it is this member only inside a
// class of the family.

export const TIERS = Object.freeze(["certain", "likely", "ambiguous"]);

const IMPORT_LINE = /^\s*import\s+(?:static\s+)?([\w.]+)/;
const PACKAGE_LINE = /^\s*package\s/;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Word-boundary matcher for an identifier (`$` and `_` count as word characters). */
export const wordRegExp = (name) => new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);

const ownerCalls = new WeakMap();

/** Matcher for `Owner.name`, `Owner?.name` and `Owner.Companion.name` (cached per symbol). */
function ownerCall(group) {
  if (!ownerCalls.has(group)) {
    ownerCalls.set(group, new RegExp(`(?<![\\w$])${escapeRegExp(group.owner)}[?!]*\\.(?:Companion\\.)?${escapeRegExp(group.name)}(?![\\w$])`));
  }
  return ownerCalls.get(group);
}

const DECLARATION_BEFORE = /\b(?:fun|val|var)\s+(?:<[^>]*>\s*)?(?:[\w.<>?,*]+\.)?$/;
const NAMED_ARGUMENT_BEFORE = /[(,]\s*$/;
const NAMED_ARGUMENT_AFTER = /^\s*=(?!=)/;
const EXPLICIT_RECEIVER = /(?:\.|::)\s*$/;
const SELF_RECEIVER = /\b(?:this|super)(?:<[^>]*>)?\.\s*$/;

/** A verdict for a member hit that the family settles, or null when the receiver has to be guessed. */
function classifyInFamily(group, file, hit, family) {
  const before = hit.lineText.slice(0, hit.col);
  const after = hit.lineText.slice(hit.col + group.name.length);
  const inside = file.insideFamily(family, hit.line);
  if (DECLARATION_BEFORE.test(before)) {
    if (!inside) return { tier: "other", why: `declares another ${group.name}` };
    return { tier: "likely", why: /\boverride\b/.test(before) ? `overrides in a subclass of ${group.owner}` : `redeclared in a subclass of ${group.owner}` };
  }
  if (NAMED_ARGUMENT_BEFORE.test(before) && NAMED_ARGUMENT_AFTER.test(after)) return { tier: "other", why: "named argument" };
  if (EXPLICIT_RECEIVER.test(before) && !SELF_RECEIVER.test(before)) return null;
  return inside
    ? { tier: "certain", why: `no receiver, inside a subclass of ${group.owner}` }
    : { tier: "other", why: `no receiver, but the enclosing class is not a subclass of ${group.owner}` };
}

/** Does `fqn` name `name` declared in package `pkg`, directly or inside a class of it? */
function namesSymbol(fqn, pkg, name) {
  if (fqn === (pkg ? `${pkg}.${name}` : name)) return true;
  return pkg !== "" && fqn.startsWith(`${pkg}.`) && fqn.endsWith(`.${name}`);
}

/** How a file reaches the top-level name `name` declared in package `pkg`, or null. */
function reach(file, pkg, name) {
  const explicit = file.imports.find((i) => !i.star && (i.alias ?? i.fqn.slice(i.fqn.lastIndexOf(".") + 1)) === name);
  if (explicit) {
    return namesSymbol(explicit.fqn, pkg, name) ? { tier: "certain", why: "imported" } : { tier: "other", why: `imports ${explicit.fqn}` };
  }
  if (file.pkg === pkg) return { tier: "likely", why: "same package" };
  if (file.imports.some((i) => i.star && i.fqn === `${pkg}.*`)) return { tier: "likely", why: "wildcard import" };
  return null;
}

function classifyXml(group, hit) {
  const before = hit.lineText.slice(0, hit.col);
  const after = hit.lineText.slice(hit.col + group.name.length);
  const qualified = group.declPkg ? `${group.declPkg}.` : "";
  const classLike = ["class", "interface", "object", "typealias"].includes(group.kind);
  if (before.lastIndexOf("@{") > before.lastIndexOf("}")) return { tier: "ambiguous", why: "data binding expression" };
  if (before.endsWith("/")) return { tier: "other", why: "resource name" };
  if (before.endsWith(":")) return { tier: "other", why: "attribute name" };
  if (classLike) {
    if (qualified && before.endsWith(qualified)) return { tier: "certain", why: "qualified name" };
    if (!group.owner && before.endsWith('".')) return { tier: "likely", why: "relative to the manifest package" };
    if (/(?:<|=\s*["'])$/.test(before) && /^["'\s/>]/.test(after)) return { tier: "ambiguous", why: "tag or attribute value" };
    return { tier: "other", why: "not a reference" };
  }
  if (group.owner && /onClick\s*=\s*["']$/.test(before)) return { tier: "likely", why: "onClick handler" };
  return { tier: "other", why: "not a reference" };
}

/**
 * {tier, why} for one match. `group` describes the declared symbol (name, kind,
 * owner, declPkg, declPath, declLines, private), `file` the file with the match
 * (path, ext, pkg, imports, mentions(name), mentionsFamily(family), insideFamily(family, line))
 * and `hit` the match (line, col, lineText). `group.family`, when set, is the Set of class names
 * of the owner's family.
 */
export function classify(group, file, hit) {
  const { name, owner, declPkg } = group;
  if (file.ext === "xml") return classifyXml(group, hit);
  if (PACKAGE_LINE.test(hit.lineText)) return { tier: "skip", why: "package line" };
  const sameFile = file.path === group.declPath;
  if (sameFile && group.declLines.has(hit.line)) return { tier: "decl", why: "declaration" };
  const imported = IMPORT_LINE.exec(hit.lineText);
  if (imported) {
    return namesSymbol(imported[1], declPkg, name)
      ? { tier: "certain", why: "import" }
      : { tier: "other", why: "import of another symbol" };
  }
  if (sameFile && !owner) return { tier: "certain", why: "same file" };
  if (sameFile) {
    const settled = group.family ? classifyInFamily(group, file, hit, group.family) : null;
    return settled ?? (group.family ? { tier: "ambiguous", why: "receiver type not visible" } : { tier: "likely", why: "same file" });
  }
  if (group.private) return { tier: "other", why: "private to its file" };
  if (declPkg && hit.lineText.includes(`${declPkg}.${name}`)) return { tier: "certain", why: "qualified name" };
  if (!owner) return reach(file, declPkg, name) ?? { tier: "other", why: "not imported" };
  const member = file.imports.find((i) => !i.star && namesSymbol(i.fqn, declPkg, `${owner}.${name}`));
  if (member) return { tier: "certain", why: "imported member" };
  const family = group.family;
  const settled = family ? classifyInFamily(group, file, hit, family) : null;
  if (settled) return settled;
  const ownerReach = reach(file, declPkg, owner);
  if (ownerReach?.tier === "other") return { tier: "other", why: ownerReach.why };
  if (ownerReach && ownerCall(group).test(hit.lineText)) return { tier: "certain", why: `${owner}.${name}` };
  if (family ? file.mentionsFamily(family) : ownerReach && file.mentions(owner)) return { tier: "likely", why: family ? `${owner} or a subclass in file` : `${owner} in file` };
  return { tier: "ambiguous", why: "receiver type not visible" };
}
