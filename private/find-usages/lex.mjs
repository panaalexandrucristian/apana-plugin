// Source blanking for the usage scan (Node stdlib only). Comments and string
// literals are replaced by spaces, keeping newlines and every offset, so a word
// found in the blanked text is a word in code. Kotlin string templates are the
// exception: the expression of a `${...}` and a `$name` stay visible because
// they are real uses of a symbol.
//
// The scan jumps from one interesting character to the next and copies the text
// in between as one piece, so a file costs a few regex steps, not one per character.
//
// A string with a `$$` prefix (Kotlin 2.2) starts a template only at a run of that
// many dollars: in `$$"${a} $${b}"` the first is text and the second a template.
//
// With `marks: true` the output is a mask for a reader that needs the extent of
// a literal: the delimiters of a string or character literal are kept as
// STRING_MARK (a raw string opens with RAW_OPEN and closes with RAW_CLOSE), the
// text inside is blank and so is all code inside `${...}` and every `$name`.

const IDENT_START = /[A-Za-z_]/;
const TEMPLATE_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const WIDE = /[^\u0000-\u00ff]/g;
const WIDE_STAND_IN = 0xaa; // ª, a letter: what a character above U+00FF becomes when `exact` is false
const CHAR_LITERAL = /'(?:\\u[0-9a-fA-F]{4}|\\.|[^\\'\n])'/y;

const blankText = (text) => text.replace(/[^\n]/g, " ");

/** Delimiter of a line string or a character literal in a `marks` mask. */
export const STRING_MARK = "\u0001";
/** Start and end of a raw (triple-quoted) string in a `marks` mask. */
export const RAW_OPEN = "\u0003";
export const RAW_CLOSE = "\u0002";

/**
 * Same-length copy of `source` with comments and string contents blanked.
 *
 * One state machine, two ways to write the result. The source is copied once
 * into a Buffer and only the noise is overwritten in place, so the code between
 * two stops is never copied again. A source with mostly non-Latin-1 text builds
 * the result from pieces of text instead. A character above U+00FF is kept
 * exactly, unless `exact` is false: then, where it stays code, it is a letter
 * stand-in ("\u00aa") and the caller reads the real text from `source`.
 */
export function blankNoise(source, { templates = true, marks = false, exact = true } = {}) {
  const n = source.length;
  const resume = []; // string modes interrupted by an open `${`, with the brace depth to return at
  const codeStop = /[/"'{}]/g;
  const blockStop = /\/\*|\*\//g;
  const strStop = templates ? /["\\$\n]/g : /["\\\n]/g;
  const rawStop = templates ? /["$]/g : /"/g;
  // Characters above U+00FF do not fit a byte: note where they are, and put them back where they stay code.
  const wide = [];
  while (wide.length <= n / 8 && WIDE.test(source)) wide.push(WIDE.lastIndex - 1);
  WIDE.lastIndex = 0;
  const buf = wide.length <= n / 8 ? Buffer.from(source, "latin1") : null;
  if (buf && !exact) for (const at of wide) buf[at] = WIDE_STAND_IN;
  const out = buf ? null : [];
  /** Blank [a, b); the newlines in it stay when `keepNewlines`. */
  let blank;
  /** Code in [a, b) stays as it is. */
  let code;
  /** Write `text` (as long as the span it replaces) at a. */
  let write;
  if (buf) {
    blank = (a, b, keepNewlines) => {
      if (b - a < 24) for (let k = a; k < b; k++) buf[k] = 32;
      else buf.fill(32, a, b);
      if (keepNewlines) for (let k = source.indexOf("\n", a); k >= 0 && k < b; k = source.indexOf("\n", k + 1)) buf[k] = 10;
    };
    code = () => {};
    write = (a, text) => {
      for (let k = 0; k < text.length; k++) buf[a + k] = text.charCodeAt(k);
    };
  } else {
    blank = (a, b, keepNewlines) => out.push(keepNewlines ? blankText(source.slice(a, b)) : " ".repeat(b - a));
    code = (a, b) => out.push(source.slice(a, b));
    write = (a, text) => out.push(text);
  }
  let mode = "code"; // code | line | block | str | raw
  let blockDepth = 0;
  let braces = 0;
  let dollars = 1; // dollars that start a template in the current string
  let i = 0;
  /** Code in [a, b), blanked in a mask when it is inside a `${...}`. */
  const put = (a, b) => (marks && resume.length > 0 ? blank(a, b, true) : code(a, b));
  /** A delimiter of length `length` at i in a mask (blank inside a template, where the whole string is noise). */
  const delimiter = (mark, length) => {
    if (marks && resume.length === 0) write(i, mark + " ".repeat(length - 1));
    else blank(i, i + length, false);
  };
  /** At a `$` inside a string: a run shorter than `dollars` is text; otherwise its last `dollars` start a `${...}` or a `$name`. */
  const template = () => {
    let run = 1;
    while (source[i + run] === "$") run += 1;
    const next = source[i + run];
    if (run >= dollars && next === "{") {
      resume.push({ mode, depth: braces, dollars });
      braces += 1;
      mode = "code";
      blank(i, i + run + 1, false);
      i += run + 1;
    } else if (run >= dollars && next !== undefined && IDENT_START.test(next)) {
      const name = TEMPLATE_NAME.exec(source.slice(i + run, i + run + 200))[0];
      if (marks) blank(i, i + run + name.length, false);
      else {
        blank(i, i + run, false);
        code(i + run, i + run + name.length);
      }
      i += run + name.length;
    } else {
      blank(i, i + run, false);
      i += run;
    }
  };
  while (i < n) {
    if (mode === "line") {
      const newline = source.indexOf("\n", i);
      const end = newline < 0 ? n : newline;
      blank(i, end, false);
      i = end;
      mode = "code";
    } else if (mode === "block") {
      blockStop.lastIndex = i;
      if (!blockStop.test(source)) {
        blank(i, n, true);
        break;
      }
      const at = blockStop.lastIndex - 2;
      blank(i, at + 2, true);
      i = at + 2;
      if (source[at] === "/") blockDepth += 1;
      else {
        blockDepth -= 1;
        if (blockDepth === 0) mode = "code";
      }
    } else if (mode === "str" || mode === "raw") {
      const re = mode === "str" ? strStop : rawStop;
      re.lastIndex = i;
      const found = re.test(source);
      const at = found ? re.lastIndex - 1 : n;
      if (at > i) blank(i, at, mode === "raw");
      i = at;
      if (!found) break;
      const c = source[i];
      if (c === "\\") {
        const end = Math.min(i + 2, n);
        blank(i, end, true);
        i = Math.max(end, i + 2);
      } else if (c === "\n") {
        mode = "code"; // unterminated: do not swallow the rest of the file
        code(i, i + 1);
        i += 1;
      } else if (c === "$") {
        template();
      } else if (mode === "str") {
        mode = "code";
        delimiter(STRING_MARK, 1);
        i += 1;
      } else if (source.startsWith('"""', i)) {
        let end = i + 3;
        while (source[end] === '"') end += 1;
        mode = "code";
        delimiter(RAW_CLOSE, end - i);
        i = end;
      } else {
        blank(i, i + 1, false);
        i += 1;
      }
    } else {
      codeStop.lastIndex = i;
      const found = codeStop.test(source);
      const at = found ? codeStop.lastIndex - 1 : n;
      if (at > i) put(i, at);
      i = at;
      if (!found) break;
      const c = source[i];
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        mode = "line";
        blank(i, i + 2, false);
        i += 2;
      } else if (c === "/" && next === "*") {
        mode = "block";
        blockDepth = 1;
        blank(i, i + 2, false);
        i += 2;
      } else if (c === '"') {
        const triple = source.startsWith('"""', i);
        mode = triple ? "raw" : "str";
        let prefix = 0;
        while (source[i - 1 - prefix] === "$") prefix += 1;
        dollars = Math.max(1, prefix);
        delimiter(triple ? RAW_OPEN : STRING_MARK, triple ? 3 : 1);
        i += triple ? 3 : 1;
      } else if (c === "'") {
        CHAR_LITERAL.lastIndex = i;
        const length = CHAR_LITERAL.test(source) ? CHAR_LITERAL.lastIndex - i : 0;
        if (length === 0) put(i, i + 1);
        else if (marks && resume.length === 0) write(i, STRING_MARK + " ".repeat(length - 2) + STRING_MARK);
        else blank(i, i + length, false);
        i += length || 1;
      } else if (c === "}") {
        braces -= 1;
        const back = resume.length > 0 && resume[resume.length - 1].depth === braces ? resume.pop() : null;
        if (back) {
          mode = back.mode;
          dollars = back.dollars;
          blank(i, i + 1, false);
        } else put(i, i + 1);
        i += 1;
      } else {
        if (c === "{") braces += 1;
        put(i, i + 1);
        i += 1;
      }
    }
  }
  if (!out) {
    let text = buf.toString("latin1");
    let kept = null;
    if (exact) for (const at of wide) {
      if (buf[at] === 32) continue; // blanked: noise
      kept ??= [];
      kept.push(at);
    }
    if (kept) {
      const parts = [];
      let from = 0;
      for (const at of kept) {
        parts.push(text.slice(from, at), source[at]);
        from = at + 1;
      }
      parts.push(text.slice(from));
      text = parts.join("");
    }
    return text;
  }
  return out.join("");
}

/** Same-length copy of an XML file with its comments blanked (attribute values are real references). */
export function blankXmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, blankText);
}
