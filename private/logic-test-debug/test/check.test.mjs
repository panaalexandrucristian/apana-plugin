import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUDGET_MS, EARLIER_DIRECTIVES, LOGIC_DIRECTIVE, MAX_PROMPT_BYTES, classifyCodePrompt } from "../check.mjs";

// The 16 positive and 16 negative example prompts of the activation design, with the expected outcome of each.
const POSITIVE = [
  "Write a Python function that validates an email address.",
  "Implement an API endpoint for creating accounts.",
  "Scrie cod JavaScript pentru validarea formularului.",
  "Repară bugul din funcția de calcul al totalului.",
  "Depanează programul care se blochează la pornire.",
  "Explain this Boolean condition: `a && !b`.",
  "Design tests for combined conditions in this function.",
  "Explică această condiție booleană: `a || !b`.",
  "Help with src/parser.ts.",
  "Ajută-mă cu validator.py.",
  "```python\ndef square(x):\n    return x * x\n```",
  'Traceback (most recent call last):\n  File "app.py", line 4, in <module>\n    print(total)\nNameError: name total is not defined',
  "TypeError: cannot read properties of undefined\n    at render (/work/view.js:8:3)",
  "Explain this function without changing the code: `parse(input)`.",
  "Fix the invalid setting in config.yaml.",
  "Debug.",
];
const NEGATIVE = [
  "If I double this recipe, how much flour should I use?",
  "Explain the Baron study in plain prose; do not write code.",
  "Fix my CV.",
  "Repară formularea din CV-ul meu.",
  'Translate the quotation "write Python code" into Romanian.',
  "What does the word `if` mean in this recipe?",
  "Summarise this article about software debugging; prose only.",
  "Do not implement anything; improve this paragraph.",
  "Nu scrie cod; explică studiul pe înțelesul meu.",
  "Explain why my oven displays error E5.",
  "The report mentions parser.ts; summarise the report in prose.",
  "```text\nIf the dough is sticky, add flour.\n```",
  "Fix the formatting in application.docx.",
  "Implement the new hiring policy.",
  'Translate this quotation only: ```python\nprint("hello")\n```',
  "Explain what an error budget is in project management.",
];

describe("classifyCodePrompt: the specified examples", () => {
  POSITIVE.forEach((prompt, index) => {
    it(`positive ${index + 1} activates: ${prompt.slice(0, 50).replace(/\n/g, " ")}`, () => {
      const result = classifyCodePrompt(prompt);
      assert.equal(result.activate, true, `reason ${result.reason}`);
      assert.match(result.reason, /^[a-z-]+$/);
    });
  });
  NEGATIVE.forEach((prompt, index) => {
    it(`negative ${index + 1} adds nothing: ${prompt.slice(0, 50).replace(/\n/g, " ")}`, () => {
      const result = classifyCodePrompt(prompt);
      assert.equal(result.activate, false, `reason ${result.reason}`);
    });
  });
});

describe("classifyCodePrompt: normalisation and boundaries", () => {
  it("ignores case, Romanian diacritics and CRLF", () => {
    assert.equal(classifyCodePrompt("REPARĂ BUGUL DIN FUNCȚIA DE LOGIN").activate, true);
    assert.equal(classifyCodePrompt("repara bugul din functia de login").activate, true);
    assert.equal(classifyCodePrompt("Explain this function\r\nand fix the code\r\n").activate, true);
    assert.equal(classifyCodePrompt("Depanează\r\n").activate, true);
  });
  it("matches whole words, not substrings", () => {
    assert.equal(classifyCodePrompt("Please add the encoded message to the paragraph.").activate, false);
    assert.equal(classifyCodePrompt("Write about the coding bootcamp experience.").activate, false);
  });
  it("lets a local negation cancel the affected request only", () => {
    assert.equal(classifyCodePrompt("Please don't write any code, just give me career advice.").activate, false);
    assert.equal(classifyCodePrompt("Explain this function without changing it.").activate, true);
    assert.equal(classifyCodePrompt("Nu scrie cod, doar explică funcția asta.").activate, true);
  });
  it("keeps a real coding request inside a mixed prompt", () => {
    assert.equal(classifyCodePrompt("Summarise the study, then fix the bug in the parseConfig function.").activate, true);
  });
  it("does not treat quoted words as the user's request", () => {
    assert.equal(classifyCodePrompt('He said "the build failed" in his speech; what did the quote mean?').activate, false);
    assert.equal(classifyCodePrompt('Translate "write a Python function" into French.').activate, false);
  });
  it("needs recognisable syntax in an untagged or unknown fence", () => {
    assert.equal(classifyCodePrompt("```\nfunction add(a, b) { return a + b; }\n```").activate, true);
    assert.equal(classifyCodePrompt("```\njust some words in a block\n```").activate, false);
    assert.equal(classifyCodePrompt("```markdown\n# Title\nText\n```").activate, false);
    assert.equal(classifyCodePrompt("```js\n```").activate, false);
    assert.equal(classifyCodePrompt("```python\nprint(1)").activate, false, "an unclosed fence is not a fence");
  });
  it("needs a request word with a file name or an inline expression", () => {
    assert.equal(classifyCodePrompt("See main.go for details.").activate, false);
    assert.equal(classifyCodePrompt("Explain main.go please").activate, true);
    assert.equal(classifyCodePrompt("Why does `if (!a && !(b || c))` return false?").activate, true);
    assert.equal(classifyCodePrompt("What does `hello world` mean here?").activate, false);
    assert.equal(classifyCodePrompt("Fix notes.txt and report.pdf").activate, false);
  });
  it("accepts every allowed code extension and rejects document extensions", () => {
    for (const ext of ["js", "mjs", "ts", "tsx", "py", "java", "kt", "c", "h", "cpp", "cs", "go", "rs", "swift", "rb", "php", "sh", "sql", "html", "css", "json", "yaml", "yml", "toml"]) {
      assert.equal(classifyCodePrompt(`Help with file.${ext}`).activate, true, ext);
    }
    for (const ext of ["md", "txt", "pdf", "docx", "png", "csv"]) {
      assert.equal(classifyCodePrompt(`Help with file.${ext}`).activate, false, ext);
    }
  });
  it("needs frames, not just the word error, for a trace", () => {
    assert.equal(classifyCodePrompt("Why do I get HTTP 404 on my site?").activate, false);
    assert.equal(classifyCodePrompt("src/app.ts:12:5 error TS2304: Cannot find name 'x'").activate, true);
    assert.equal(classifyCodePrompt('Traceback (most recent call last):\nValueError: bad').activate, false);
  });
  it("accepts 65,536 UTF-8 bytes and rejects 65,537", () => {
    const base = "Write a Python function. ";
    const at = base + "a".repeat(MAX_PROMPT_BYTES - base.length);
    assert.equal(Buffer.byteLength(at, "utf8"), MAX_PROMPT_BYTES);
    assert.equal(classifyCodePrompt(at).activate, true);
    const over = at + "a";
    assert.deepEqual(classifyCodePrompt(over), { activate: false, reason: "oversize" });
  });
  it("counts bytes, not characters, for multibyte text", () => {
    const text = "ă".repeat(MAX_PROMPT_BYTES / 2 + 1);
    assert.ok(text.length <= MAX_PROMPT_BYTES);
    assert.deepEqual(classifyCodePrompt(text), { activate: false, reason: "oversize" });
  });
  it("returns no activation for malformed input", () => {
    for (const value of [undefined, null, 42, {}, [], Symbol("x")]) {
      assert.deepEqual(classifyCodePrompt(value), { activate: false, reason: "not-string" });
    }
    assert.equal(classifyCodePrompt("").activate, false);
  });
  it("returns no activation when the 25 ms budget has expired (injected clock)", () => {
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : BUDGET_MS + 1);
    assert.deepEqual(classifyCodePrompt("Write a Python function.", { now }), { activate: false, reason: "budget" });
  });
  it("keeps the directive under 400 characters", () => {
    assert.equal(typeof LOGIC_DIRECTIVE, "string");
    assert.ok(LOGIC_DIRECTIVE.length <= 400);
  });
  it("asks for the record at the end of the answer, names the skill and keeps the earlier text apart", () => {
    for (const part of ["load the logic-test-debug skill", "Scope:, Method:, Result:", "without waiting", "report only checks you actually performed"]) {
      assert.ok(LOGIC_DIRECTIVE.includes(part), part);
    }
    assert.ok(EARLIER_DIRECTIVES.length >= 1);
    for (const earlier of EARLIER_DIRECTIVES) {
      assert.notEqual(earlier, LOGIC_DIRECTIVE);
      assert.ok(earlier.length <= 400);
    }
  });
});

describe("classifyCodePrompt: a code file name is programming context for a request verb", () => {
  it("activates on a repair or implement request that names a source file", () => {
    assert.equal(classifyCodePrompt("Repair the incorrect approval logic in src/shipping.js for expedited, signed, insured shipments. Preserve scheduling behaviour and the public API.").activate, true);
    assert.equal(classifyCodePrompt("Implement canAccess in src/access.js as described in SPEC.md. Leave normalizeToken as it is.").activate, true);
    assert.equal(classifyCodePrompt("Please repair main.go").activate, true);
  });
  it("still adds nothing for a document or prose file with the same verbs", () => {
    assert.equal(classifyCodePrompt("Repair the formatting in report.docx.").activate, false);
    assert.equal(classifyCodePrompt("Implement the new policy described in notes.txt.").activate, false);
    assert.equal(classifyCodePrompt("Repair my CV, the file is cv.pdf.").activate, false);
  });
});

// Cases found by an independent review of the classifier. Each row is a prompt and the expected outcome.
const REVIEW_ACTIVATE = [
  "Explain this Boolean condition in plain English: `a && !b`.",
  "Review src/recipe.js",
  "Debug the translation module",
  "Review the recipe service code",
  "Why does my translation function throw?\n```js\nfoo()\n```",
  "In plain English, what does this do?\n```js\nconst x = 1;\n```",
  "Repară codul",
  "Scrie codul pentru login",
  "Corectează codul din fișier",
  "Explică-mi codul acesta",
  "Adaugă teste pentru clasa User",
  "Rezolvă bugul din aplicație",
  "Rewrite this in C++.",
  "Rewrite this in C#.",
  "Port this to C#",
  "Rewrite this in Go.",
  "Fix the bug\nin the checkout function",
  "Please implement\nthe validateEmail function",
  "Fix the bug in my app",
  "Don't hesitate to fix my function",
  "Please don't forget to fix the function",
  "Write a Python function that sends a welcome email",
  "src/index.ts:12:5 - error TS2304: Cannot find name 'x'.",
  "src/index.ts(12,5): error TS2304: Cannot find name 'x'.",
  "error[E0308]: mismatched types\n --> src/main.rs:4:9",
  "./main.go:5:2: undefined: x",
  'File "x.py", line 3\n    foo(\n       ^\nSyntaxError: invalid syntax',
  "thread 'main' panicked at src/main.rs:4:9:\nindex out of bounds",
];
const REVIEW_QUIET = [
  "I don't want you to write code, just explain the idea.",
  "I do not want you to write any code.",
  "I don't need you to write a function; describe the approach in words.",
  "Please don\u2019t write any code, just give me career advice.",
  "Nu vreau ca tu s\u0103 scrii cod, doar explic\u0103.",
  "Create a 12-week workout program for a beginner",
  "Write a script for my YouTube video",
  "Write a poem about Taylor Swift",
  "Write a CV for a Python developer",
  "Write a recipe for cod with lemon butter",
  "Creeaz\u0103 un program de antrenament",
  "Scrie un script pentru un film",
  "I have an error from the bank.\nMy appointment is\nat 10:30",
  "The meeting is at 10:30\nerror in the invoice\n  at 10:30",
];

describe("classifyCodePrompt: cases from an independent review", () => {
  REVIEW_ACTIVATE.forEach((prompt) => {
    it(`activates: ${prompt.slice(0, 55).replace(/\n/g, " / ")}`, () => {
      const result = classifyCodePrompt(prompt);
      assert.equal(result.activate, true, result.reason);
    });
  });
  REVIEW_QUIET.forEach((prompt) => {
    it(`adds nothing: ${prompt.slice(0, 55).replace(/\n/g, " / ")}`, () => {
      const result = classifyCodePrompt(prompt);
      assert.equal(result.activate, false, result.reason);
    });
  });
});

describe("classifyCodePrompt: long adversarial input stays fast", () => {
  // Quadratic patterns made these cost 0.2 s to 5 s; linear ones cost a few milliseconds. The threshold is loose on
  // purpose (machine noise), far below the old cost and far above the new one.
  const shapes = {
    "one long word": "a".repeat(64000),
    "dotted run": "a.".repeat(32000),
    "frame-like run": `at ${"a/".repeat(32000)}`,
    "colon run": "x:".repeat(32000),
    "dash run": "a-".repeat(32000),
    "path-like words": "src/a.ts ".repeat(7000),
    "blank lines": "\n".repeat(60000),
    "many short lines": "error\n  at a.js:1\n".repeat(3000),
    "backticks and parentheses": ("`" + "(".repeat(50) + " ").repeat(500) + "x".repeat(30000),
    "unclosed fence": `\`\`\`py\n${"print(1)\n".repeat(6000)}`,
  };
  for (const [name, text] of Object.entries(shapes)) {
    it(`${name} (${text.length} characters) classifies in under 400 ms`, () => {
      assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PROMPT_BYTES, "input within the bound");
      const started = performance.now();
      const result = classifyCodePrompt(text);
      const elapsed = performance.now() - started;
      assert.equal(typeof result.activate, "boolean");
      assert.ok(elapsed < 400, `${elapsed.toFixed(0)} ms`);
    });
  }
  it("a 64 KiB prompt without any intent still runs every stage within the bound", () => {
    const started = performance.now();
    const result = classifyCodePrompt(`${"lorem ipsum dolor sit amet, ".repeat(2300)}`);
    assert.equal(result.activate, false);
    assert.ok(performance.now() - started < 400);
  });
});
