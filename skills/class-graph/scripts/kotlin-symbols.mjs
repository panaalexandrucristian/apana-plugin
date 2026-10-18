// Declarations of a Kotlin file (Node stdlib only): its package, its imports, the
// symbols other files can refer to (top-level declarations and members of classes
// and objects), and the shape of its classes (supertypes and line ranges). A line
// scan over the blanked source with brace tracking, not a parser: local
// variables, parameters and enum entries are not reported, and a declaration is
// read from the line that starts it.
import { blankNoise } from "./lex.mjs";

const TYPE = /\b(class|interface|object|typealias)\s+([A-Za-z_]\w*)/;
const COMPANION = /\bcompanion\s+object\b(?:\s+([A-Za-z_]\w*))?/;
const FUN = /\bfun\s+(?:<[^>]*>\s*)?(?:([\w.<>?,*\s]+?)\.)?([A-Za-z_]\w*)\s*\(/;
const PROP = /\b(?:val|var)\s+(?:<[^>]*>\s*)?(?:[\w.<>?,*]+\.)?([A-Za-z_]\w*)\b/;
const CTOR_PROP = /(?:^|[(,\s])(?:(?:private|protected|internal|public|override|open|final|lateinit)\s+)*(?:val|var)\s+([A-Za-z_]\w*)/g;
const IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+\*?)(?:[ \t]+as[ \t]+(\w+))?/;
const PACKAGE = /^[ \t]*package[ \t]+([\w.]+)/m;
const DECLARATION_WORD = /\b(?:class|interface|object|typealias|fun|val|var)\b/;
const MAX_HEADER_LINES = 12;

const parenDelta = (text) => {
  let delta = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 40) delta += 1;
    else if (c === 41) delta -= 1;
  }
  return delta;
};

/** {pkg, imports: [{fqn, alias, star}]} of a blanked Kotlin or Java source. */
export function parseHeader(blanked) {
  const imports = [];
  for (const line of blanked.split("\n")) {
    const match = IMPORT.exec(line);
    if (match) imports.push({ fqn: match[1], alias: match[2] ?? null, star: match[1].endsWith("*") });
  }
  return { pkg: PACKAGE.exec(blanked)?.[1] ?? "", imports };
}

/** Simple names of the supertypes in a class header: "class A(val x: Int) : B(1), C by d" gives [B, C]. */
export function superTypes(header) {
  let text = header;
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(/<[^<>]*>/g, "").replace(/\([^()]*\)/g, "");
  }
  const colon = text.indexOf(":");
  if (colon < 0) return [];
  return text
    .slice(colon + 1)
    .split(",")
    .map((part) => /^\s*(?:[\w.]*\.)?([A-Za-z_]\w*)/.exec(part)?.[1])
    .filter(Boolean);
}

/** {text, lines}: the header of the declaration starting at lines[n].slice(from), up to its "{", and how many lines it spans. */
function headerOf(lines, n, from) {
  let text = lines[n].slice(from);
  let depth = parenDelta(text);
  let span = 1;
  for (let i = n + 1; i < lines.length && i < n + MAX_HEADER_LINES && !text.includes("{"); i++) {
    if (!(depth > 0 || /[:,(]\s*$/.test(text) || /^\s*:/.test(lines[i]))) break;
    text += ` ${lines[i]}`;
    depth += parenDelta(lines[i]);
    span += 1;
  }
  return { text: text.split("{")[0], lines: span };
}

const receiverType = (receiver) => /([A-Za-z_]\w*)(?:<.*>)?\??\s*$/.exec(receiver)?.[1] ?? null;

/**
 * {pkg, imports, symbols, classes, extFuns, topLevel}. A symbol is {name, kind,
 * owner, line, private, override}: kind is class | interface | object |
 * typealias | function | property, owner the enclosing class (null at top
 * level), line 1-based. A class is {name, kind, owner, start, end, supers,
 * header} (lines 1-based, `end` is the closing brace, or the last header line
 * for a class without a body); an extension function {receiver, name, start,
 * end}; topLevel lists the top-level functions and properties as {name, kind,
 * receiver, start, end} (a declaration without braces ends before the next
 * top-level declaration). `blanked` may be given when the source has already
 * been through blankNoise.
 */
export function parseKotlin(source, { blanked = null } = {}) {
  const text = blanked ?? blankNoise(source);
  const lines = text.split("\n");
  const imports = [];
  const symbols = [];
  const classes = [];
  const extFuns = [];
  const topLevel = [];
  const stack = []; // open braces: {kind: "class" | "block", name, rec}
  let ctor = null; // {owner, parens} while the parentheses of a primary constructor are open
  let pending = null; // the scope the next "{" opens, set by a declaration
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const scope = stack[stack.length - 1];
    const declare = (name, kind, owner, modifiers) =>
      symbols.push({ name, kind, owner, line: n + 1, private: /\bprivate\b/.test(modifiers), override: /\boverride\b/.test(modifiers) });
    const imported = line.includes("import") ? IMPORT.exec(line) : null;
    if (imported) {
      imports.push({ fqn: imported[1], alias: imported[2] ?? null, star: imported[1].endsWith("*") });
      continue;
    }
    if (ctor) {
      for (const match of line.matchAll(CTOR_PROP)) declare(match[1], "property", ctor.owner, match[0]);
      ctor.parens += parenDelta(line);
      if (ctor.parens <= 0) ctor = null;
    } else if ((!scope || scope.kind === "class") && DECLARATION_WORD.test(line)) {
      const owner = scope ? scope.name : null;
      const companion = COMPANION.exec(line);
      const type = TYPE.exec(line);
      const fun = FUN.exec(line);
      const prop = PROP.exec(line);
      if (companion) {
        pending = { kind: "class", name: owner }; // its members are reached through the enclosing class
        if (companion[1]) declare(companion[1], "object", owner, line.slice(0, companion.index));
      } else if (type) {
        declare(type[2], type[1], owner, line.slice(0, type.index));
        if (type[1] !== "typealias") {
          const { text: header, lines: span } = headerOf(lines, n, type.index);
          const rec = { name: type[2], kind: type[1], owner, start: n + 1, end: n + span, supers: superTypes(header), header: header.replace(/\s+/g, " ").trim().slice(0, 300) };
          classes.push(rec);
          pending = { kind: "class", name: type[2], rec, keepUntil: n + span - 1 }; // its "{" may sit on the last header line
          const open = line.indexOf("(", type.index + type[0].length);
          if (open >= 0) {
            const rest = line.slice(open);
            for (const match of rest.matchAll(CTOR_PROP)) declare(match[1], "property", type[2], match[0]);
            const parens = parenDelta(rest);
            if (parens > 0) ctor = { owner: type[2], parens };
          }
        }
      } else if (fun) {
        declare(fun[2], "function", owner, line.slice(0, fun.index));
        pending = { kind: "block", name: owner };
        const receiver = fun[1] ? receiverType(fun[1]) : null;
        if (receiver || !scope) {
          pending.rec = { receiver, name: fun[2], kind: "function", start: n + 1, end: n + 1 };
          if (receiver) extFuns.push(pending.rec);
          if (!scope) topLevel.push(pending.rec);
        }
      } else if (prop) {
        declare(prop[1], "property", owner, line.slice(0, prop.index));
        pending = { kind: "block", name: owner };
        if (!scope) {
          pending.rec = { receiver: null, name: prop[1], kind: "property", start: n + 1, end: n + 1 };
          topLevel.push(pending.rec);
        }
      }
    }
    if (line.includes("{") || line.includes("}")) {
      for (let i = 0; i < line.length; i++) {
        const c = line.charCodeAt(i);
        if (c === 123) {
          const entry = pending && !ctor ? pending : { kind: "block", name: null };
          if (entry === pending) pending = null;
          if (entry.rec) entry.rec.braces = true;
          stack.push(entry);
        } else if (c === 125) {
          const closed = stack.pop();
          if (closed?.rec) closed.rec.end = n + 1;
        }
      }
    }
    if (!ctor && !(pending && pending.keepUntil > n)) pending = null;
  }
  // A top-level declaration without braces ends where the next top-level declaration starts.
  const starts = [...topLevel, ...classes.filter((cls) => !cls.owner)].map((item) => item.start).sort((a, b) => a - b);
  for (const item of topLevel) {
    if (item.braces) continue;
    const next = starts.find((start) => start > item.start);
    item.end = next ? next - 1 : lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
  }
  return { pkg: PACKAGE.exec(text)?.[1] ?? "", imports, symbols, classes, extFuns, topLevel };
}

/** Classes of a blanked Java source as {name, kind, owner, start, end, supers, header}; nested classes have their own range. */
export function parseJavaClasses(blanked) {
  const re = /\b(?:class|interface|enum)\s+([A-Za-z_]\w*)\s*(?:<[^{]*?>)?\s*(extends\s+[^{]*?)?\s*(implements\s+[^{]*?)?\s*\{/g;
  const lineStarts = [0];
  for (let i = blanked.indexOf("\n"); i >= 0; i = blanked.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const classes = [];
  for (const match of blanked.matchAll(re)) {
    const supers = [match[2], match[3]]
      .filter(Boolean)
      .flatMap((part) => part.replace(/<[^<>]*>/g, "").replace(/^(?:extends|implements)\s+/, "").split(","))
      .map((part) => /([A-Za-z_]\w*)\s*$/.exec(part.trim())?.[1])
      .filter(Boolean);
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = blanked.length - 1;
    for (let i = open; i < blanked.length; i++) {
      if (blanked[i] === "{") depth += 1;
      else if (blanked[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    classes.push({ name: match[1], kind: "class", owner: null, start: lineOf(match.index), end: lineOf(close), supers, header: match[0].replace(/\s+/g, " ").slice(0, 300) });
  }
  for (const cls of classes) {
    const outer = classes.filter((other) => other !== cls && other.start <= cls.start && cls.end <= other.end && other.end - other.start > cls.end - cls.start);
    cls.owner = outer.sort((a, b) => a.end - a.start - (b.end - b.start))[0]?.name ?? null;
  }
  return classes;
}
