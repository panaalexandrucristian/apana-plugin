// Where does the implementation of a Kotlin function start and end? A scan of the
// source with comments and strings masked (lex.mjs, `marks`), not a parser; the
// rules follow the Kotlin grammar (KotlinParser.g4):
//   - the body is a block `{ ... }`, an expression `= ...`, or absent (abstract,
//     interface, expect, external); a newline may stand before the `{` or `=`;
//   - an expression body goes on over a newline that is followed by `.`, `?.`,
//     `?:`, `&&`, `||`, `as`, `else`, `catch`, `finally` or `{`, or that follows a
//     binary operator, `else`, `try`, `if (...)` and the like; a line that starts
//     with `+`, `-`, `*`, `..` or `(` is a new statement.
// Not reported: anonymous functions, getters and setters, constructors, `init`.
import { RAW_CLOSE, RAW_OPEN, blankNoise } from "./lex.mjs";

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const ASCII_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Is the UTF-16 unit `c` (a charCodeAt result, NaN past the end) a letter, digit or underscore? ASCII is decided without the Unicode regex. */
const isWord = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || (c > 127 && WORD_CHAR.test(String.fromCharCode(c)));
const KEYWORD = /\b(?:fun|class|interface|object)\b/g;
const OPERATOR_AT_END = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "<", ".", ":", ",", "="]);
const WORD_AT_END = new Set(["else", "in", "is", "as", "try", "finally", "do", "throw"]);
const CONTROL_BEFORE_PARENS = new Set(["if", "for", "while"]);
// A primary constructor may start on the line after the class name: `@Inject constructor(`, `private constructor(`.
const CONSTRUCTOR_LINE = /^(?:@[\w.]+(?:\([^)]*\))?\s*|(?:private|internal|protected|public)\s+)*constructor\b/;
const isSpace = (c) => c === " " || c === "\n" || c === "\t" || c === "\r";

/**
 * Every named function of a Kotlin source, in file order: {name, owner, receiver,
 * start, end, bodyStart, body, local, parent, unclosed}. Lines are 1-based and
 * inclusive; `start` is the line of the `fun` keyword; `body` is "block",
 * "expression" or "none" (then `end` is the last line of the signature and
 * `bodyStart` is null); `owner` is the enclosing classes joined by dots (a
 * companion object adds nothing); `local` is true inside another function, whose
 * name is `parent`; `unclosed` is true when a block body never closes (then `end`
 * is the last line). With `name`, only the functions of that name.
 */
export function findDefinitions(source, name = null) {
  if (name !== null && !source.includes(name)) return []; // no occurrence of the name, no such function: skip the scan
  const t = blankNoise(source, { marks: true, exact: false }); // names are read from `source`: same offsets
  const n = t.length;
  // Line numbers are counted from a cursor that moves to the offset asked for, so no table of line starts is built.
  let cursor = 0;
  let cursorLine = 1;
  const lineOf = (offset) => {
    if (offset >= cursor) {
      for (let at = t.indexOf("\n", cursor); at >= 0 && at < offset; at = t.indexOf("\n", at + 1)) cursorLine += 1;
    } else {
      for (let at = t.lastIndexOf("\n", cursor - 1); at >= offset; at = at > 0 ? t.lastIndexOf("\n", at - 1) : -1) cursorLine -= 1;
    }
    cursor = offset;
    return cursorLine;
  };
  const lastLine = () => lineOf(n) - (n > 0 && t.endsWith("\n") ? 1 : 0);
  const skipSpace = (at) => {
    while (at < n && isSpace(t[at])) at += 1;
    return at;
  };
  const wordAt = (at) => {
    let end = at;
    while (end < n && isWord(t.charCodeAt(end))) end += 1;
    return t.slice(at, end);
  };
  /** Index of the `}` that closes the `{` at `open`, or -1. */
  const matchBrace = (open) => {
    let depth = 1;
    let nextOpen = t.indexOf("{", open + 1);
    let nextClose = t.indexOf("}", open + 1);
    while (nextClose >= 0) {
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        nextOpen = t.indexOf("{", nextOpen + 1);
      } else {
        depth -= 1;
        if (depth === 0) return nextClose;
        nextClose = t.indexOf("}", nextClose + 1);
      }
    }
    return -1;
  };
  /** Index after the `)` that closes the `(` at `open`, or -1. */
  const skipParens = (open) => {
    let depth = 0;
    for (let at = open; at < n; at++) {
      if (t[at] === "(") depth += 1;
      else if (t[at] === ")" && (depth -= 1) === 0) return at + 1;
    }
    return -1;
  };
  /** Index after the `>` that closes the `<` at `open` (a `->` does not count), or -1. */
  const skipAngles = (open) => {
    let depth = 0;
    for (let at = open; at < n; at++) {
      const c = t[at];
      if (c === "<") depth += 1;
      else if (c === ">" && t[at - 1] !== "-" && (depth -= 1) === 0) return at + 1;
      else if (c === "{" || c === "}" || c === ";" || c === "=") return -1;
    }
    return -1;
  };

  /** The type name of a receiver: "Map<String, List<T>>?" gives "Map". */
  const receiverName = (text) => {
    let rest = text.replace(/[\s?]+$/, "");
    while (rest.endsWith(">")) {
      let depth = 0;
      let at = rest.length - 1;
      for (; at >= 0; at--) {
        if (rest[at] === ">" && rest[at - 1] !== "-") depth += 1;
        else if (rest[at] === "<" && (depth -= 1) === 0) break;
      }
      if (at < 0) break;
      rest = rest.slice(0, at).replace(/[\s?]+$/, "");
    }
    return rest.slice(rest.lastIndexOf(".") + 1).replace(/`/g, "").trim() || null;
  };

  /** What follows the parameters: {kind, at, signatureEnd}; `at` is the `{` or the `=`. */
  const scanTail = (from) => {
    let depth = 0;
    let angles = 0;
    let signatureEnd = from - 1;
    for (let at = from; at < n; at++) {
      const c = t[at];
      if (c === "\n") {
        if (depth > 0 || angles > 0) continue;
        const next = skipSpace(at);
        const d = t[next];
        const continues =
          d === "{" || (d === "=" && t[next + 1] !== "=") || d === ":" || d === "." || d === "?" || d === "&" || d === "," || (d === "-" && t[next + 1] === ">") || wordAt(next) === "where";
        if (!continues) break;
        at = next - 1;
        continue;
      }
      if (isSpace(c)) continue;
      if (depth === 0 && angles === 0) {
        if (c === "{") return { kind: "block", at };
        if (c === "=") return { kind: "expression", at };
        if (c === "}" || c === ";") break;
      }
      if (c === "(" || c === "[") depth += 1;
      else if (c === ")" || c === "]") depth -= 1;
      else if (c === "<") angles += 1;
      else if (c === ">" && t[at - 1] !== "-" && angles > 0) angles -= 1;
      signatureEnd = at;
    }
    return { kind: "none", at: -1, signatureEnd };
  };

  /** Does the expression go on after the newline at `newline`, its last token being at `last`? */
  const continues = (last, newline) => {
    const c = t[last];
    if (OPERATOR_AT_END.has(c)) return !((c === "+" || c === "-") && t[last - 1] === c);
    if (c === ">" && t[last - 1] === "-") return true;
    if (isWord(t.charCodeAt(last))) {
      let from = last;
      while (from > 0 && isWord(t.charCodeAt(from - 1))) from -= 1;
      if (WORD_AT_END.has(t.slice(from, last + 1))) return true;
    }
    if (c === ")") {
      let depth = 0;
      let open = last;
      for (; open >= 0; open--) {
        if (t[open] === ")") depth += 1;
        else if (t[open] === "(" && (depth -= 1) === 0) break;
      }
      let end = open;
      while (end > 0 && isSpace(t[end - 1])) end -= 1;
      let from = end;
      while (from > 0 && isWord(t.charCodeAt(from - 1))) from -= 1;
      if (CONTROL_BEFORE_PARENS.has(t.slice(from, end))) return true;
    }
    const next = skipSpace(newline);
    if (next >= n) return false;
    const d = t[next];
    if (d === ".") return t[next + 1] !== ".";
    if (d === "?") return t[next + 1] === "." || t[next + 1] === ":";
    if (d === "&") return t[next + 1] === "&";
    if (d === "|") return t[next + 1] === "|";
    if (d === "{") return true;
    const word = wordAt(next);
    return word === "as" || word === "else" || word === "catch" || word === "finally";
  };

  /** Index of the last character of the expression that starts after `from`, or -1. */
  const expressionEnd = (from) => {
    let depth = 0;
    let last = -1;
    let raw = false;
    for (let at = from; at < n; at++) {
      const c = t[at];
      if (raw) {
        if (c === RAW_CLOSE) {
          raw = false;
          last = at;
        }
        continue;
      }
      if (c === "\n") {
        if (depth > 0 || last < 0 || continues(last, at)) continue;
        break;
      }
      if (isSpace(c)) continue;
      if (c === RAW_OPEN) raw = true;
      else if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ";" && depth === 0) break;
      last = at;
    }
    return last;
  };

  let scopeEnd = 0; // where the function just read stops, for the scope stack (set by parseFunction)
  /** A named function whose `fun` keyword is at `keyword`, or null. */
  const parseFunction = (keyword) => {
    let at = skipSpace(keyword + 3);
    if (t[at] === "<") {
      at = skipAngles(at);
      if (at < 0) return null;
      at = skipSpace(at);
    }
    if (t[at] === "(") return null; // an anonymous function, or a receiver of a function type
    const calleeStart = at;
    let angles = 0;
    let lastDot = -1;
    for (; at < n; at++) {
      const c = t[at];
      if (c === "`") {
        at = t.indexOf("`", at + 1);
        if (at < 0) return null;
      } else if (c === "<") angles += 1;
      else if (c === ">") {
        if (t[at - 1] !== "-" && angles > 0) angles -= 1;
      } else if (c === "(" && angles === 0) break;
      else if (c === "." && angles === 0) lastDot = at;
      else if (c === "{" || c === "}" || c === "=" || c === ";" || c === ")") return null;
    }
    if (at >= n) return null;
    let functionName = source.slice(lastDot < 0 ? calleeStart : lastDot + 1, at).trim();
    if (/^`[^`]+`$/.test(functionName)) functionName = functionName.slice(1, -1);
    else if (!ASCII_NAME.test(functionName) && !NAME.test(functionName)) return null;
    const receiver = lastDot < 0 ? null : receiverName(source.slice(calleeStart, lastDot));
    const afterParameters = skipParens(at);
    if (afterParameters < 0) return null;
    const tail = scanTail(afterParameters);
    const def = { name: functionName, receiver, start: lineOf(keyword), unclosed: false, body: "", bodyStart: null, end: 0 };
    if (tail.kind === "block") {
      const close = matchBrace(tail.at);
      def.body = "block";
      def.bodyStart = lineOf(tail.at);
      def.unclosed = close < 0;
      def.end = close < 0 ? lastLine() : lineOf(close);
      scopeEnd = close < 0 ? n : close;
    } else if (tail.kind === "expression") {
      const last = expressionEnd(tail.at + 1);
      const endAt = last < 0 ? tail.at : last;
      def.body = "expression";
      def.bodyStart = lineOf(tail.at);
      def.end = lineOf(endAt);
      scopeEnd = endAt;
    } else {
      def.body = "none";
      def.bodyStart = null;
      def.end = lineOf(tail.signatureEnd);
      scopeEnd = tail.signatureEnd;
    }
    return def;
  };

  /** The extent of a class, interface or object whose keyword ends at `after`: {name, end} or null without a body. */
  const parseClass = (word, keyword, after) => {
    let at = skipSpace(after);
    let className = null;
    if (t[at] === "`") {
      const close = t.indexOf("`", at + 1);
      if (close < 0) return null;
      className = source.slice(at + 1, close);
      at = close + 1;
    } else if (isWord(t.charCodeAt(at))) {
      const length = wordAt(at).length;
      className = source.slice(at, at + length);
      at += length;
    }
    if (word !== "object" && className === null) return null;
    if (word === "object" && /\bcompanion\s+(?:data\s+)?$/.test(t.slice(Math.max(0, keyword - 40), keyword))) className = null;
    let depth = 0;
    let angles = 0;
    for (; at < n; at++) {
      const c = t[at];
      if (c === "\n") {
        if (depth > 0 || angles > 0) continue;
        const next = skipSpace(at);
        const d = t[next];
        if (d === "{" || d === ":" || d === "," || d === "(" || wordAt(next) === "where" || wordAt(next) === "by" || CONSTRUCTOR_LINE.test(t.slice(next, next + 300))) {
          at = next - 1;
          continue;
        }
        return null;
      }
      if (depth === 0 && angles === 0) {
        if (c === "{") {
          const close = matchBrace(at);
          return { name: className, end: close < 0 ? n : close };
        }
        if (c === "}" || c === ";") return null;
      }
      if (c === "(" || c === "[") depth += 1;
      else if (c === ")" || c === "]") depth -= 1;
      else if (c === "<") angles += 1;
      else if (c === ">" && t[at - 1] !== "-" && angles > 0) angles -= 1;
    }
    return null;
  };

  // For a search by name, a function or class whose text has no occurrence of the name cannot hold the function: it is skipped whole, like a preparser skips a body.
  let hit = name === null ? -1 : source.indexOf(name);
  const mentions = (from, to) => {
    if (hit >= 0 && hit < from) hit = source.indexOf(name, from);
    return hit >= 0 && hit <= to;
  };
  const definitions = [];
  const scopes = []; // enclosing classes and functions: {kind, name, end, owner}, owner being the dotted names of the classes so far
  for (let found = KEYWORD.exec(t); found; found = KEYWORD.exec(t)) {
    const at = found.index;
    while (scopes.length > 0 && scopes[scopes.length - 1].end < at) scopes.pop();
    const word = found[0];
    if (word === "fun") {
      if (wordAt(skipSpace(at + 3)) === "interface") continue;
      const def = parseFunction(at);
      if (!def) continue;
      if (name !== null && def.name !== name && !mentions(at, scopeEnd)) {
        KEYWORD.lastIndex = scopeEnd + 1;
        continue;
      }
      const top = scopes[scopes.length - 1];
      def.owner = top?.owner ?? null;
      def.local = top?.kind === "fun";
      def.parent = def.local ? top.name : null;
      scopes.push({ kind: "fun", name: def.name, end: scopeEnd, owner: def.owner });
      if (name === null || def.name === name) definitions.push(def);
    } else if (!(at >= 2 && t.charCodeAt(at - 1) === 58 && t.charCodeAt(at - 2) === 58)) {
      const extent = parseClass(word, at, at + word.length);
      if (extent && name !== null && !mentions(at, extent.end)) KEYWORD.lastIndex = extent.end + 1;
      else if (extent) {
        const top = scopes[scopes.length - 1];
        const outer = top?.owner ?? null;
        scopes.push({ kind: "class", name: extent.name, end: extent.end, owner: extent.name ? (outer ? `${outer}.${extent.name}` : extent.name) : outer });
      }
    }
  }
  return definitions;
}
