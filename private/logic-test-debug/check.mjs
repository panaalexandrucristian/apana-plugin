// logic-test-debug: the local, no-model check that decides whether a prompt is about code, plus the on/off
// switch and the directive text. Pure and in-memory: no I/O, network, subprocess, model call or stored prompt.
// Every rule below (vocabulary, extension list, patterns, bounds) is an engineering INFERENCE, not a study result,
// and a lexical check cannot understand natural language: false matches and misses remain possible.
// Ordinary prose that mentions code words (recipes, CVs, study summaries, quotations) must add nothing.

export const LOGIC_DIRECTIVE =
  "For this code task, load the logic-test-debug skill and apply its relevant rules. " +
  "End your final answer with Approaches: (up to three real approaches, most correct first, the first is the one used) " +
  "and Workarounds: (or none found), then the three-line record Scope:, Method:, Result:. " +
  "When you test combined conditions, state the strength t and why, without waiting. " +
  "Preserve behaviour and report only checks you actually performed.";

// The directives of earlier plugins: 0.10.0 (the live sessions of the first campaigns), 0.10.2 to 0.13.10 of the jev plugin, and apana 0.1.0. The scorer must
// still recognise them when it reads those transcripts again.
export const EARLIER_DIRECTIVES = [
  "For this code task, load the logic-test-debug skill and apply its relevant rules. " +
    "Finish your final answer with the three-line record Scope:, Method:, Result:. " +
    "When you test combined conditions, state the strength t and why, without waiting. " +
    "Preserve behaviour and report only checks you actually performed.",
  "For this code task, load the logic-test-debug skill and apply its relevant rules. " +
    "Use the compact Scope:/Method:/Result: record; state combination-test strength and reason without waiting. " +
    "Preserve behaviour and report checks actually performed.",
];

export const MAX_PROMPT_BYTES = 65536;
export const BUDGET_MS = 25;

/**
 * APANA_LOGIC_TEST_DEBUG (legacy override), else CLAUDE_PLUGIN_OPTION_LOGIC_TEST_DEBUG: absent means ON.
 * A present value is trimmed and lowercased: on, 1 and true mean ON;
 * off, 0, false and every unrecognised value (an empty value included) mean OFF. Unlike the opt-in JEV_FLOW,
 * the default is ON because the user asked for automatic activation.
 */
export function logicEnabled(env, { includePluginOption = true } = {}) {
  const raw = env?.APANA_LOGIC_TEST_DEBUG ?? (includePluginOption ? env?.CLAUDE_PLUGIN_OPTION_LOGIC_TEST_DEBUG : undefined);
  if (raw === undefined) return true;
  return ["on", "1", "true"].includes(String(raw).trim().toLowerCase());
}

const done = (activate, reason) => ({ activate, reason });

// ── Vocabulary (normalised: lower case, no diacritics) ──────────────────────────────────────────────────────────
const STRONG_VERB = new RegExp(
  "\\b(?:writ(?:e|es|ing)|implement(?:s|ing|ed)?|creat(?:e|es|ing)|add(?:s|ing)?|chang(?:e|es|ing)|modif(?:y|ies|ying)|" +
    "refactor(?:s|ing)?|fix(?:es|ing)?|repair(?:s|ing)?|debug(?:s|ging)?|diagnos(?:e|es|ing)|troubleshoot(?:s|ing)?|" +
    "patch(?:es|ing)?|rewrit(?:e|es|ing)|compil(?:e|es|ing)|develop(?:s|ing)?|port(?:s|ing)?|" +
    "scri[aeiu]\\w*|scris\\w*|implementeaz\\w*|creeaz\\w*|adaug\\w*|schimb\\w*|modific\\w*|refactoriz\\w*|repar\\w*|corecteaz\\w*|rezolv\\w*|" +
    "depan\\w*|diagnostic\\w*|dezvolt\\w*)\\b",
);
const READ_VERB = new RegExp(
  "\\b(?:explain(?:s|ing)?|read(?:s|ing)?|understand(?:s|ing)?|review(?:s|ing)?|test(?:s|ing)?|trace|tracing|check(?:s|ing)?|" +
    "verify|design(?:s|ing)? tests?|walk me through|explic\\w*|citeste|intelege|testeaz\\w*|verific\\w*|proiecteaz\\w* teste?)\\b",
);
const DEBUG_WORD = /\b(?:debug(?:s|ging)?|depan\w*)\b/;
// Context words that mean code almost only in a programming prompt, and ones that often mean something else
// (a training program, a payment method, a video script, the fish cod, the snake python). A request about a
// document-like thing (a CV, a recipe, a poem, a video) with only the second kind of word adds nothing.
const UNAMBIGUOUS = new RegExp(
  "(?:\\b(?:code|source code|codebase|codul|codului|coduri|codurile|compiler|compilator|compilation|compilare|stack ?trace|unit tests?|" +
    "test(?:e)? unitar\\w*|integration tests?|boolean (?:conditions?|expressions?)|conditi\\w* booleana|conditional expressions?|" +
    "expresi\\w* logica|api|endpoints?|software bugs?|repo|repository|regex|snippet|algorithm|app|apps|aplicati\\w*|" +
    "javascript|typescript|kotlin|php|sql|bash|node\\.js|nodejs|golang)\\b|(?<![\\w+#])c\\+\\+(?![\\w+])|(?<![\\w#])c#(?![\\w#]))",
);
const AMBIGUOUS = /\b(?:cod|functions?|functi\w*|methods?|metod\w*|program\w*|scripts?|python|java|rust|swift|ruby|cpp)\b/;
const GO_LANGUAGE = /\bgo (?:code|program|function|module|package|service|backend|app)\b/;
const GO_ORIGINAL = /\b(?:in|to|with|using) Go\b|\bGo (?:code|program|function|module|package|service|backend|app)\b/;
const IDENTIFIER = /\b[a-z]{3,}(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b|\b\w+\(\)|\b(?:class|clasa|clasei)\s+[A-Z]\w+/;
const DOC_OBJECT = new RegExp(
  "\\b(?:cv|(?:my|your|a|the) resume|recipes?|poems?|essays?|songs?|speech|videos?|youtube|films?|movies?|podcasts?|workouts?|diet|" +
    "reteta|retete|poezie|eseu|melodie|antrenament|filme?)\\b",
);
// A negator cancels the verb phrase it governs (the next three words, six after "want/need ... you to"), not the whole
// request. "don't hesitate / forget / worry to fix ..." is not a negation of the request.
const NEGATOR = new RegExp(
  "\\b(?:(?:do not|don't|dont|never) (?:want|need|ask|expect|require) you to|no need for you to|nu vreau ca tu sa|nu vreau ca sa|nu am nevoie sa)\\b|" +
    "\\b(?:do not|don't|dont|never|no need to|need not|without|nu trebuie sa|nu vreau sa|nu e nevoie sa|fara|nu)\\b",
  "g",
);
const WIDE_NEGATOR = /^(?:(?:do not|don't|dont|never) (?:want|need|ask|expect|require) you to|no need for you to|nu vreau ca tu sa|nu vreau ca sa|nu am nevoie sa)$/;
const NEGATION_EXEMPT = /^\s*(?:hesitate|forget|worry|ezita|uita)\b/;
// An explicit limit to prose blocks artifacts and the bare "debug"; translating or quoting blocks artifacts, bare
// "debug" and reading requests too. A real coding request in the same prompt still counts.
const PROSE_LIMIT = /\b(?:prose only|only prose|in prose|plain prose|doar proza|in proza)\b/;
const QUOTE_FRAME = /\b(?:translat(?:e|es)|quotations?|citat\w*|traduc\w*|traducere)\b/;
const CODE_FILE = /(?:^|[\s"'`(\[])([\w./\\-]*\w\.(?:js|mjs|cjs|jsx|ts|tsx|py|pyi|java|kt|kts|c|h|cc|cpp|cxx|hpp|cs|go|rs|swift|rb|php|sh|bash|zsh|sql|html|css|scss|vue|svelte|json|yaml|yml|toml))(?![\w])/i;
const HELP = new RegExp(
  "\\b(?:help(?:ing)?|fix|repair|implement|patch|rewrite|write|explain|test|debug|review|check|refactor|update|change|edit|modify|why|what does|" +
    "ajut\\w*|repar\\w*|explic\\w*|verific\\w*|testeaz\\w*|schimb\\w*|modific\\w*)\\b",
);
const EXPRESSION = /[(){}\[\];=<>]|&&|\|\||!\s*\w/;
const CODE_TAGS = new Set([
  "js", "javascript", "jsx", "mjs", "cjs", "ts", "typescript", "tsx", "py", "python", "java", "kt", "kotlin", "c", "cpp", "c++", "cc", "h", "hpp",
  "cs", "csharp", "c#", "go", "golang", "rs", "rust", "rb", "ruby", "php", "swift", "sh", "bash", "zsh", "shell", "sql", "html", "css", "scss",
  "json", "yaml", "yml", "toml", "vue", "svelte",
]);
const PROSE_TAGS = new Set(["text", "txt", "plain", "plaintext", "markdown", "md", "prose", "quote"]);
const SYNTAX = [
  /\b(?:function|def|class)\s+\w+\s*\(/,
  /^\s*(?:const|let|var)\s+\w+\s*=/m,
  /^\s*(?:import\s+\S+|from\s+\S+\s+import\b|#include\b)/m,
  /\b(?:if|for|while)\s*\([^)\n]+\)/,
  /\b(?:select\s+[^;\n]+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table)\b/i,
];
// Stack traces and compiler output. Every pattern is anchored at the start of a line and bounded, so a long unbroken
// run of path characters cannot make a line quadratic; lines over 300 characters are never frames.
const EXT = "c|h|cc|cpp|cxx|hpp|cs|java|kt|go|rs|ts|tsx|js|jsx|mjs|py|swift|rb|php|scala";
const COMPILER_LINE = new RegExp(`^\\s*(?:-->\\s*)?[\\w.\\\\/-]{1,200}\\.(?:${EXT})(?::\\d+(?::\\d+)?|\\(\\d+(?:,\\d+)?\\))(?::\\s|\\s+-\\s|\\s+(?:error|warning)\\b|\\s*$)`, "i");
const JS_FRAME = new RegExp(`^\\s*at\\s+[^\\n]{1,200}\\.(?:${EXT}):\\d+(?::\\d+)?\\)?\\s*$`);
const PY_FRAME = /^\s*file "[^"\n]{1,200}", line \d+/i;
const PY_ERROR = /^\s*[A-Za-z_.]{0,60}(?:Error|Exception)\b[:(]/;

const normalise = (text) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[\u2018\u2019\u02bc]/g, "'");

// ── Spans: fences, inline code and quotations are separated from the prose ──────────────────────────────────────
function splitSpans(text) {
  const fences = [];
  let rest = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("```", i);
    if (open < 0) break;
    const lineEnd = text.indexOf("\n", open);
    const bodyStart = lineEnd < 0 ? -1 : lineEnd + 1;
    const close = bodyStart < 0 ? -1 : text.indexOf("```", bodyStart);
    if (close < 0) {
      rest += text.slice(i, open + 3);
      i = open + 3;
      continue;
    }
    fences.push({ tag: text.slice(open + 3, lineEnd).trim().split(/\s+/)[0]?.toLowerCase() ?? "", body: text.slice(bodyStart, close) });
    rest += text.slice(i, open) + " ";
    i = close + 3;
  }
  rest += text.slice(i);

  const inline = [];
  let prose = "";
  i = 0;
  while (i < rest.length) {
    const a = rest.indexOf("`", i);
    if (a < 0) break;
    const b = rest.indexOf("`", a + 1);
    const nl = rest.indexOf("\n", a);
    if (b < 0 || (nl >= 0 && nl < b)) {
      prose += rest.slice(i, a + 1);
      i = a + 1;
      continue;
    }
    inline.push(rest.slice(a + 1, b));
    prose += rest.slice(i, a) + " ";
    i = b + 1;
  }
  prose += rest.slice(i);

  // Quotations ("..." “...” „...” «...») are blanked: quoted words are not the user's own request.
  const unquoted = prose.replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”|„[^”\n]{0,300}”|«[^»\n]{0,300}»/g, " ");
  return { fences, inline, prose: unquoted };
}

const unambiguous = (clause, original) => UNAMBIGUOUS.test(clause) || GO_LANGUAGE.test(clause) || GO_ORIGINAL.test(original) || IDENTIFIER.test(original) || CODE_FILE.test(original);
const hasContext = (clause, original) => unambiguous(clause, original) || AMBIGUOUS.test(clause);

function maskNegated(clause) {
  const spans = [];
  const negator = new RegExp(NEGATOR.source, "g");
  const word = /\s*\S+/y;
  let match;
  while ((match = negator.exec(clause)) !== null) {
    let end = match.index + match[0].length;
    if (NEGATION_EXEMPT.test(clause.slice(end))) continue;
    const reach = WIDE_NEGATOR.test(match[0]) ? 6 : 3;
    for (let k = 0; k < reach; k += 1) {
      word.lastIndex = end;
      if (!word.exec(clause)) break;
      end = word.lastIndex;
    }
    spans.push([match.index, end]);
  }
  let out = clause;
  for (const [a, b] of spans) out = out.slice(0, a) + " ".repeat(b - a) + out.slice(b);
  return out;
}

function intentOf(prose, { limit, frame }) {
  // Sentences end at ". ", ";", "!" or "?" and paragraphs at a blank line; a single line break is only a wrapped line.
  const originals = prose.split(/\.(?=\s|$)|[;!?]+|\n\s*\n/);
  const clauses = originals.map((clause) => maskNegated(normalise(clause)));
  let read = false;
  for (let k = 0; k < clauses.length; k += 1) {
    if (DOC_OBJECT.test(clauses[k]) && !unambiguous(clauses[k], originals[k])) continue;
    if (STRONG_VERB.test(clauses[k]) && hasContext(clauses[k], originals[k])) return "intent-strong";
    if (!frame && READ_VERB.test(clauses[k]) && hasContext(clauses[k], originals[k])) read = true;
  }
  if (read) return "intent-read";
  if (!limit && !frame && clauses.some((clause) => DEBUG_WORD.test(clause))) return "intent-debug";
  return null;
}

function traceIn(text, expired) {
  const lines = text.split("\n");
  let python = false;
  let frame = false;
  let pyError = false;
  for (let k = 0; k < lines.length; k += 1) {
    if ((k & 255) === 255 && expired()) return false;
    const line = lines[k];
    if (line.length > 300) continue;
    if (/traceback \(most recent call last\)/i.test(line)) python = true;
    else if (PY_FRAME.test(line)) frame = true;
    else if (PY_ERROR.test(line)) pyError = true;
    else if (COMPILER_LINE.test(line)) return true;
    else if (JS_FRAME.test(line) && k > 0 && /(?:error|exception)\b/i.test(lines.slice(Math.max(0, k - 3), k).join("\n"))) return true;
    else if (/\bpanicked at [\w./\\-]{1,200}:\d+/i.test(line) || /^goroutine \d+ \[\w+/.test(line)) return true;
  }
  return (python && frame) || (frame && pyError);
}

const fenceQualifies = (fence) => {
  if (!fence.body.trim()) return false;
  if (CODE_TAGS.has(fence.tag)) return true;
  if (PROSE_TAGS.has(fence.tag)) return false;
  return SYNTAX.some((pattern) => pattern.test(fence.body));
};

/**
 * Decide whether a prompt is about writing, changing, reading, testing or debugging code.
 * Returns {activate, reason}; the reason is a fixed identifier. Oversize or malformed input, an expired
 * 25 ms cooperative budget or any internal error return no activation. The budget is checked between
 * stages; synchronous code cannot be preempted, so no hard wall-clock guarantee is claimed.
 */
export function classifyCodePrompt(text, options = {}) {
  const clock = options.now ?? (() => performance.now());
  const started = clock();
  const expired = () => clock() - started > BUDGET_MS;
  try {
    if (typeof text !== "string") return done(false, "not-string");
    if (text.length > MAX_PROMPT_BYTES || Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) return done(false, "oversize");
    const source = text.replace(/\r\n?/g, "\n");
    const { fences, inline, prose } = splitSpans(source);
    if (expired()) return done(false, "budget");
    const proseNormalised = normalise(prose);
    const limits = { limit: PROSE_LIMIT.test(proseNormalised), frame: QUOTE_FRAME.test(proseNormalised) };

    const intent = intentOf(prose, limits);
    if (expired()) return done(false, "budget");
    if (intent) return done(true, intent);
    if (limits.limit || limits.frame) return done(false, "prose-only");

    if (fences.some(fenceQualifies)) return done(true, "fence");
    if (expired()) return done(false, "budget");
    if (traceIn(source, expired)) return done(true, "trace");
    if (expired()) return done(false, "budget");

    const help = HELP.test(proseNormalised);
    if (help && (CODE_FILE.test(prose) || inline.some((span) => CODE_FILE.test(span)))) return done(true, "filename");
    if (help && inline.some((span) => EXPRESSION.test(span))) return done(true, "inline");
    return done(false, "no-signal");
  } catch {
    return done(false, "error");
  }
}
