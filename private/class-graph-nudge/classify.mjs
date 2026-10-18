// class-graph nudge: the local, no-model check that finds, in one Bash command, a plain text search for a project
// class or member name ("who uses X"), the lookup the class-graph skill answers with file:line evidence. Pure and
// in-memory: no I/O, network, subprocess or model call. The rules (identifier shapes, stop list, bounds) are an
// engineering INFERENCE checked against recorded sessions, not a study result; a lexical check cannot know the
// intent, so the hook only suggests and the suggestion names its own exceptions.

export const MAX_COMMAND_CHARS = 4000;
export const MAX_ALTERNATIVES = 10;
export const MAX_GUESSED = 3;
const MIN_NAME = 4;
const MIN_LIST_FOR_PLAIN = 4;
const MAX_PLAIN = 2;

/** A bare `/apana:class-graph` (or `/class-graph`) with nothing after the command switches the session mode on. */
const BARE_COMMAND = /^\s*\/(?:apana:)?class-graph\s*$/i;
export const isBareCommand = (prompt) => typeof prompt === "string" && BARE_COMMAND.test(prompt);

// Library and platform names that nobody asks "who uses" about in a project: the lookup would only find library calls.
const STOP = new Set(
  (
    "String Int Long Short Byte Char Boolean Double Float Number Unit Any Nothing Array List Map Set Pair Triple Result " +
    "Context View Bundle Intent Activity Fragment ViewModel LiveData Flow StateFlow Log Timber Exception Throwable Error " +
    "Test Override Composable Preview Inject Companion Modifier Color Text Row Column Box Button Image Icon Spacer Surface " +
    "TextView ImageView Dispatchers Object Class Void Date Math Regex Json Gson Retrofit Room Dao Entity"
  ).split(" "),
);

const RG_SHORT_WITH_ARG = new Set(["A", "B", "C", "g", "t", "T", "m", "e", "f", "j", "d", "M", "E", "r"]);
const RG_LONG_WITH_ARG = new Set([
  "--glob", "--iglob", "--type", "--type-not", "--after-context", "--before-context", "--context", "--max-count", "--regexp",
  "--file", "--threads", "--max-depth", "--maxdepth", "--max-filesize", "--max-columns", "--encoding", "--sort", "--sortr",
  "--type-add", "--type-clear", "--colors", "--pre", "--pre-glob", "--replace", "--path-separator", "--context-separator",
]);
const GREP_SHORT_WITH_ARG = new Set(["A", "B", "C", "e", "f", "m", "d", "D"]);
const GREP_LONG_WITH_ARG = new Set([
  "--regexp", "--file", "--max-count", "--include", "--exclude", "--exclude-dir", "--include-dir", "--label",
  "--directories", "--devices", "--context", "--after-context", "--before-context",
]);

/**
 * Shell-like split of a command into segments {words, piped} of unquoted words; operators `| || && ; &` and newlines end a
 * segment, and `piped` is true when the segment reads the output of the one before it (a single `|`).
 */
export function splitSegments(command) {
  const segments = [];
  let words = [];
  let word = "";
  let started = false;
  let quote = null;
  let piped = false;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endSegment = (nextPiped = false) => {
    endWord();
    if (words.length) segments.push({ words, piped });
    words = [];
    piped = nextPiped;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      started = true;
    } else if (ch === " " || ch === "\t") endWord();
    else if (ch === "|") {
      const double = command[i + 1] === "|";
      if (double) i += 1;
      endSegment(!double);
    } else if (ch === "&" && command[i + 1] === ">") {
      word += ch;
      started = true;
    } else if (ch === "&" || ch === ";" || ch === "\n") {
      if (ch === "&" && command[i + 1] === "&") i += 1;
      endSegment();
    } else {
      word += ch;
      started = true;
    }
  }
  endSegment();
  return segments;
}

const dropRedirects = (words) => {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (/^\d*[<>]/.test(w)) {
      if (/^\d*[<>]+&?$/.test(w)) i += 1;
      continue;
    }
    out.push(w);
  }
  return out;
};

/** The search a segment performs: {tool, pattern(s), globs, paths} or null when the segment is not a text search. */
function parseSearch(segment) {
  let words = dropRedirects(segment);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
  if (words[0]?.startsWith("(")) words = [words[0].replace(/^\(+/, ""), ...words.slice(1)];
  while (words.length && ["command", "time", "nice", "builtin"].includes(words[0])) words = words.slice(1);
  if (!words.length) return null;
  const base = words[0].split("/").pop();
  let tool = null;
  let gitGrep = false;
  let rest = words.slice(1);
  if (["rg", "ag", "ack"].includes(base)) tool = "rg";
  else if (["grep", "egrep", "fgrep"].includes(base)) tool = "grep";
  else if (base === "git") {
    const at = rest.indexOf("grep");
    if (at < 0) return null;
    tool = "grep";
    rest = rest.slice(at + 1);
    gitGrep = true;
  }
  if (!tool) return null;
  const shortWith = tool === "rg" ? RG_SHORT_WITH_ARG : GREP_SHORT_WITH_ARG;
  const longWith = tool === "rg" ? RG_LONG_WITH_ARG : GREP_LONG_WITH_ARG;
  const positionals = [];
  const patterns = [];
  const globs = [];
  let files = false;
  let ignoreCase = false;
  let dashAt = null;
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i];
    if (w === "--") {
      dashAt = positionals.length;
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      if (name === "--files") files = true;
      if (name === "--ignore-case") ignoreCase = true;
      let value = eq < 0 ? null : w.slice(eq + 1);
      if (value === null && longWith.has(name)) value = rest[++i] ?? "";
      if (name === "--regexp" && value !== null) patterns.push(value);
      if (["--glob", "--iglob", "--include", "--type"].includes(name) && value !== null) globs.push(name === "--type" ? `type:${value}` : value);
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      for (let k = 1; k < w.length; k += 1) {
        const letter = w[k];
        if (letter === "i") ignoreCase = true;
        if (shortWith.has(letter)) {
          const attached = w.slice(k + 1);
          const value = attached || rest[++i] || "";
          if (letter === "e") patterns.push(value);
          if (letter === "g") globs.push(value);
          if (letter === "t") globs.push(`type:${value}`);
          break;
        }
      }
      continue;
    }
    positionals.push(w);
  }
  if (files) return null;
  const pattern = patterns.length ? patterns : positionals.length ? [positionals[0]] : [];
  const paths = patterns.length ? positionals : positionals.slice(1);
  if (!pattern.length) return null;
  // `git grep PATTERN <revision> -- path`: a word between the pattern and `--` is a revision, another tree than the one class-graph reads.
  if (gitGrep) {
    const beforeDashes = positionals.slice(patterns.length ? 0 : 1, dashAt ?? positionals.length);
    if (beforeDashes.length) return null;
  }
  return { tool, patterns: pattern, globs, paths, ignoreCase };
}

const NON_CODE_EXT = /\.(?:xml|json|md|txt|gradle|kts|properties|ya?ml|toml|html?|css|csv|log|png|jpe?g|svg|pdf|lock|tsx?|jsx?|[cm]js|py|sh)\*?$/i;
const CODE_EXT = /\.(?:kt|java)$/i;
const CODE_GLOB = /(?:\*\*?\/?\*?\.(?:kt|java)\b|^\*\.\{[^}]*(?:kt|java)[^}]*\}$|\.kt\b|\.java\b|^type:(?:kotlin|kt|java)$)/i;

/** True when the search can reach Kotlin/Java sources: an explicit glob or type for them, or no restriction to other files. */
function reachesCode(search) {
  if (search.globs.length) return search.globs.some((g) => CODE_GLOB.test(g));
  const files = search.paths.filter((p) => NON_CODE_EXT.test(p) || CODE_EXT.test(p));
  if (files.length) return files.some((p) => CODE_EXT.test(p));
  return !search.paths.some((p) => /(?:^|\/)(?:\.claude|\.git|node_modules|build|res)(?:\/|$)/.test(p));
}

const ID = /^[A-Za-z][A-Za-z0-9]*$/;

function nameKind(name) {
  if (name.length < MIN_NAME || STOP.has(name)) return null;
  if (/^[A-Z][a-z0-9]/.test(name) && /[a-z]/.test(name)) return "class";
  if (/^[a-z][a-z0-9]*[A-Z]/.test(name)) return "member";
  return null;
}

function altName(alt) {
  let s = alt.trim().replace(/^\(\?[a-z]+\)/, "");
  s = s.replace(/^\^/, "").replace(/\$$/, "");
  s = s.replace(/^(?:\\b|\\<)/, "").replace(/(?:\\b|\\>)$/, "");
  s = s.replace(/^(?:\\\.|\.)/, "").replace(/(?:\\\(|\()$/, "");
  s = s.replace(/^(?:\\b|\\<)/, "").replace(/(?:\\b|\\>)$/, "");
  return ID.test(s) ? s : null;
}

const DECL = /^(?:data |sealed |enum |abstract |open |private |internal )*(?:class|object|interface|typealias) ([A-Za-z][A-Za-z0-9]*)(?:\\b|\\>)?$/;

/** {kind, names} for a pattern that is up to MAX_ALTERNATIVES class/member identifiers (flat words allowed in a longer list) or one `class X` declaration, else null. */
export function analysePattern(pattern, { ignoreCase = false } = {}) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 300) return null;
  let p = pattern.trim().replace(/\\s[+*]?/g, " ").replace(/ +/g, " ");
  const decl = DECL.exec(p);
  if (decl && nameKind(decl[1]) === "class") return { kind: "decl", names: [decl[1]] };
  p = p.replace(/^\(\?[a-z]+\)/, "").replace(/^(?:\\b|\\<)/, "").replace(/(?:\\b|\\>)$/, "");
  p = p.replace(/^\(\?:/, "(").replace(/^\((.*)\)$/, "$1");
  const alts = p.split("|");
  // More than three alternatives count only as a case-sensitive list of declared names: -i / (?i) variants are guessed names.
  const guessing = ignoreCase || /^\(\?[a-z]*i[a-z]*\)/.test(pattern.trim());
  if (alts.length > (guessing ? MAX_GUESSED : MAX_ALTERNATIVES)) return null;
  const names = [];
  let plain = 0;
  for (const alt of alts) {
    const name = altName(alt);
    if (!name) return null;
    if (!nameKind(name)) plain += 1;
    else if (!names.includes(name)) names.push(name);
  }
  if (!names.length) return null;
  // A flat word (price, TAG) rides along only in a longer list of class/member names (a list of declarations).
  if (plain && !(alts.length >= MIN_LIST_FOR_PLAIN && names.length >= 3 && plain <= MAX_PLAIN)) return null;
  return { kind: nameKind(names[0]), names };
}

/**
 * The lookup a Bash command makes, or null: {kind: "class"|"member"|"decl", names, paths, cd} for a text search whose
 * pattern is a few class/member identifiers and which can reach Kotlin/Java sources. Snake_case resource ids, upper-case
 * constants, quoted strings, multi-word text, alternations of more than ten names and searches limited to other file
 * types are not lookups of this kind.
 */
export function classifyCommand(command) {
  if (typeof command !== "string" || !command || command.length > MAX_COMMAND_CHARS) return null;
  if (command.includes("<<")) return null;
  let cd = null;
  for (const segment of splitSegments(command)) {
    const words = dropRedirects(segment.words);
    if (words[0] === "cd" && words[1]) {
      cd = words[1];
      continue;
    }
    const search = parseSearch(segment.words);
    if (!search) continue;
    const found = judge(search, segment.piped, cd);
    if (found) return found;
  }
  return null;
}

/** The lookup a parsed search makes, or null: the shared checks of the Bash and the Grep-tool entry. */
function judge(search, piped, cd) {
  if (piped && !search.paths.length) return null; // filters the output of the previous command
  if (search.paths.length === 1 && CODE_EXT.test(search.paths[0]) && !/[*?[]/.test(search.paths[0])) return null; // searches inside one known file
  if (!reachesCode(search)) return null;
  const opts = { ignoreCase: search.ignoreCase === true };
  const analysed = search.patterns.length === 1 ? analysePattern(search.patterns[0], opts) : mergeAnalyses(search.patterns.map((x) => analysePattern(x, opts)), opts);
  return analysed ? { ...analysed, paths: search.paths, cd, patterns: search.patterns, globs: search.globs } : null;
}

/** The same check for the input of the Grep tool ({pattern, glob, type, path}): {kind, names, paths, cd, patterns, globs} or null. */
export function classifyGrepInput(toolInput) {
  const pattern = toolInput?.pattern;
  if (typeof pattern !== "string") return null;
  const globs = [];
  if (typeof toolInput.glob === "string" && toolInput.glob) globs.push(toolInput.glob);
  if (typeof toolInput.type === "string" && toolInput.type) globs.push(`type:${toolInput.type}`);
  const paths = typeof toolInput.path === "string" && toolInput.path ? [toolInput.path] : [];
  return judge({ tool: "rg", patterns: [pattern], globs, paths, ignoreCase: toolInput["-i"] === true }, false, null);
}

function mergeAnalyses(list, { ignoreCase = false } = {}) {
  if (!list.length || list.some((a) => !a || a.kind === "decl")) return null;
  const names = [...new Set(list.flatMap((a) => a.names))];
  return names.length <= (ignoreCase ? MAX_GUESSED : MAX_ALTERNATIVES) ? { kind: nameKind(names[0]), names } : null;
}
