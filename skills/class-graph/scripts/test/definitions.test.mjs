// Tests for find-def: the lines where the implementation of a Kotlin function
// starts and ends. Written before the code. The rules come from the Kotlin
// grammar (KotlinParser.g4) and the language documentation: a body is a block
// `{ ... }`, an expression `= ...` or absent (abstract, interface, expect,
// external); a newline may stand before `{`, `.`, `?.`, `?:`, `&&`, `||`, `as`,
// `else`, `catch` and `finally`, but not before `+`, `-`, `*`, `..` or `(`.
//
// A fixture writes its line numbers out ("  3 | code"), and `numbered` throws
// when they are not 1, 2, 3, ... so a test cannot drift from its expected lines.
// Inside the fixtures `$\{` is a Kotlin `${` (a JS template would substitute it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findDefinitions } from "../definitions.mjs";
import { blankNoise } from "../lex.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "find-def.mjs");

/** Source text from rows like "  3 | code"; the numbers must run 1, 2, 3, ... */
function numbered(text) {
  const rows = text.split("\n").filter((row) => row.trim() !== "");
  const lines = rows.map((row, i) => {
    const match = /^\s*(\d+) \|(?: (.*))?$/.exec(row);
    if (!match || Number(match[1]) !== i + 1) throw new Error(`fixture row ${i + 1} is numbered wrongly: ${row}`);
    return match[2] ?? "";
  });
  return `${lines.join("\n")}\n`;
}

/** "Owner.name 3-5 block", plus " in outer" for a local function. */
const summary = (d) =>
  `${d.owner ? `${d.owner}.` : ""}${d.name} ${d.start}-${d.end} ${d.body}${d.local ? ` in ${d.parent}` : ""}`;
const summaries = (source, name) => findDefinitions(source, name).map(summary);

describe("block and expression bodies", () => {
  it("reports where a block body and an expression body start and end", () => {
    const source = numbered(`
      1 | package a
      2 |
      3 | fun greet(name: String) {
      4 |     println("hi $name")
      5 | }
      6 |
      7 | fun one() = 1
    `);
    assert.deepEqual(summaries(source), ["greet 3-5 block", "one 7-7 expression"]);
    assert.deepEqual(findDefinitions(source).map((d) => d.bodyStart), [3, 7]);
  });

  it("accepts the opening brace or the equals sign on a later line", () => {
    const source = numbered(`
       1 | fun empty() {}
       2 | fun allman()
       3 | {
       4 |     println()
       5 | }
       6 |
       7 | fun eqNext() =
       8 |     42
       9 |
      10 | fun arrowNext()
      11 |     = 7
    `);
    assert.deepEqual(summaries(source), ["empty 1-1 block", "allman 2-5 block", "eqNext 7-8 expression", "arrowNext 10-11 expression"]);
    assert.deepEqual(findDefinitions(source).map((d) => d.bodyStart), [1, 3, 7, 11]);
  });

  it("reports a function without a body: abstract, interface, expect and external", () => {
    const source = numbered(`
       1 | interface Shape {
       2 |     fun area(): Double
       3 |     fun describe(): String {
       4 |         return "area=$\{area()}"
       5 |     }
       6 | }
       7 |
       8 | abstract class Base {
       9 |     abstract fun run()
      10 |     open fun stop() = Unit
      11 | }
      12 |
      13 | expect fun platform(): String
      14 | external fun native(x: Int): Int
      15 | actual fun other(): String = "x"
    `);
    assert.deepEqual(summaries(source), [
      "Shape.area 2-2 none",
      "Shape.describe 3-5 block",
      "Base.run 9-9 none",
      "Base.stop 10-10 expression",
      "platform 13-13 none",
      "native 14-14 none",
      "other 15-15 expression",
    ]);
    assert.equal(findDefinitions(source, "area")[0].bodyStart, null);
  });

  it("does not mistake a lambda after the equals sign for a block body", () => {
    const source = numbered(`
      1 | fun brace() = { 1 }
      2 | fun h(): (Int) -> Int = { it + 1 }
      3 | fun k(): Map<String, Int> = emptyMap()
    `);
    assert.deepEqual(summaries(source), ["brace 1-1 expression", "h 2-2 expression", "k 3-3 expression"]);
  });
});

describe("the signature", () => {
  it("skips braces and equals signs inside the parameters", () => {
    const source = numbered(`
      1 | fun run(
      2 |     action: () -> Unit = { println("default {") },
      3 |     n: Int = 1,
      4 | ) {
      5 |     action()
      6 | }
      7 |
      8 | fun f(a: Int = 1, b: String = "=", c: () -> Int = { 2 }): Int = a
      9 | fun g() = 1
    `);
    assert.deepEqual(summaries(source), ["run 1-6 block", "f 8-8 expression", "g 9-9 expression"]);
    assert.equal(findDefinitions(source, "run")[0].bodyStart, 4);
  });

  it("starts at the fun keyword, after annotations and context parameters", () => {
    const source = numbered(`
       1 | @Suppress("UNCHECKED_CAST")
       2 | @Composable
       3 | private fun screen(x: Int) {
       4 | }
       5 |
       6 | context(users: UserService)
       7 | fun outputMessage(message: String) {
       8 |     users.log(message)
       9 | }
      10 |
      11 | context(a: A, b: B) fun both() = 1
    `);
    assert.deepEqual(summaries(source), ["screen 3-4 block", "outputMessage 7-9 block", "both 11-11 expression"]);
  });

  it("reads type parameters, a where clause and the receiver type", () => {
    const source = numbered(`
      1 | fun <T : Comparable<T>> maxOf2(a: T, b: T): T where T : Any {
      2 |     return if (a > b) a else b
      3 | }
      4 |
      5 | fun List<Int>.total(): Int = sum()
      6 | fun <T> Map<String, List<T>>.firstOrNull2(): T? = values.firstOrNull()?.firstOrNull()
      7 | fun String?.orEmpty2() = this ?: ""
    `);
    const defs = findDefinitions(source);
    assert.deepEqual(defs.map(summary), ["maxOf2 1-3 block", "total 5-5 expression", "firstOrNull2 6-6 expression", "orEmpty2 7-7 expression"]);
    assert.deepEqual(defs.map((d) => d.receiver), [null, "List", "Map", "String"]);
  });

  it("knows the modifiers and backtick names", () => {
    const source = numbered(`
       1 | class P(val x: Int) {
       2 |     override fun toString() = "P"
       3 |     operator fun plus(o: P) = P(x + o.x)
       4 |     infix fun shl(n: Int): P { return this }
       5 |     private suspend inline fun go() {}
       6 |     tailrec fun loop(n: Int): Int = if (n == 0) 0 else loop(n - 1)
       7 | }
       8 | operator fun P.unaryMinus() = P(-x)
       9 | fun \`my test\`() {
      10 | }
    `);
    assert.deepEqual(summaries(source), [
      "P.toString 2-2 expression",
      "P.plus 3-3 expression",
      "P.shl 4-4 block",
      "P.go 5-5 block",
      "P.loop 6-6 expression",
      "unaryMinus 8-8 expression",
      "my test 9-10 block",
    ]);
    assert.deepEqual(summaries(source, "my test"), ["my test 9-10 block"]);
  });
});

describe("noise inside a body", () => {
  it("ignores braces in comments, strings, characters and raw strings", () => {
    const source = numbered(`
       1 | fun noisy(): String {
       2 |     // } not a close
       3 |     /* } /* } */ still comment } */
       4 |     val a = "}"
       5 |     val b = '}'
       6 |     val c = "$\{"}"} and $\{ mapOf("k" to 1)["k"] }"
       7 |     val d = """
       8 |         }
       9 |         fun fake() {
      10 |     """
      11 |     return a + b + c + d
      12 | }
      13 |
      14 | fun next() = 1
    `);
    assert.deepEqual(summaries(source), ["noisy 1-12 block", "next 14-14 expression"]);
    assert.deepEqual(findDefinitions(source, "fake"), []);
  });

  it("reads a multi-dollar string whose literal braces are not templates", () => {
    const source = numbered(`
      1 | fun schema() = $$"""
      2 |     { "k": "$\{x", "$id": "$$\{1 + 1}" }
      3 | """
      4 |
      5 | fun after() = 1
    `);
    assert.deepEqual(summaries(source), ["schema 1-3 expression", "after 5-5 expression"]);
  });

  it("ignores the word fun in comments and strings, and what is not a named function", () => {
    const source = numbered(`
       1 | // fun hidden() {}
       2 | /** fun doc() = 1 */
       3 | val text = "fun fake() {}"
       4 | val callback: () -> Unit = {}
       5 | val f = fun(x: Int): Int { return x }
       6 | val g = { y: Int -> y }
       7 | val a: Int get() = 1
       8 | var b: Int
       9 |     get() = 2
      10 |     set(v) { println(v) }
      11 | fun interface Runner { fun run() }
      12 | class K { init { println() } constructor(x: Int) : this() { } }
      13 | fun funny() = 1
      14 | val myfun = 2
    `);
    assert.deepEqual(summaries(source), ["Runner.run 11-11 none", "funny 13-13 expression"]);
  });
});

describe("where an expression body ends", () => {
  it("continues on a line that starts with a dot, ?., ?:, &&, ||, as, or after a trailing operator", () => {
    const source = numbered(`
       1 | fun chain(xs: List<Int>) = xs
       2 |     .filter { it > 0 }
       3 |     ?.let { it }
       4 |
       5 |     // a comment between
       6 |     .size
       7 |
       8 | fun elvis(a: Int?) = a
       9 |     ?: 0
      10 |
      11 | fun both(a: Boolean, b: Boolean) = a
      12 |     && b
      13 |     || a
      14 |
      15 | fun cast(x: Any) = x
      16 |     as String
      17 |
      18 | fun trailing(a: Int) = a +
      19 |     1
      20 |
      21 | fun trailingAnd(a: Boolean) = a &&
      22 |     a
    `);
    assert.deepEqual(summaries(source), [
      "chain 1-6 expression",
      "elvis 8-9 expression",
      "both 11-13 expression",
      "cast 15-16 expression",
      "trailing 18-19 expression",
      "trailingAnd 21-22 expression",
    ]);
  });

  it("stops before a line that starts with + or - (a new statement)", () => {
    const source = numbered(`
      1 | fun host() {
      2 |     fun a() = 1
      3 |         + 2
      4 |     fun b() = 1
      5 |         - 2
      6 |     a()
      7 | }
    `);
    assert.deepEqual(summaries(source), ["host 1-7 block", "a 2-2 expression in host", "b 4-4 expression in host"]);
  });

  it("follows if/else, when, try/catch/finally, argument lists, trailing lambdas and raw strings", () => {
    const source = numbered(`
       1 | fun cond(x: Int) =
       2 |     if (x > 0) "pos"
       3 |     else "neg"
       4 |
       5 | fun pick(x: Int) = when (x) {
       6 |     1 -> "one"
       7 |     else -> "many"
       8 | }
       9 |
      10 | fun safe() = try {
      11 |     risky()
      12 | } catch (e: Exception) {
      13 |     null
      14 | } finally {
      15 |     done()
      16 | }
      17 |
      18 | fun call() = compute(
      19 |     1,
      20 |     2,
      21 | )
      22 |
      23 | fun lambda() = listOf(1).map {
      24 |     it + 1
      25 | }
      26 |
      27 | fun text() = """
      28 |     fun fake() {
      29 | """
      30 |
      31 | fun last() = 1
    `);
    assert.deepEqual(summaries(source), [
      "cond 1-3 expression",
      "pick 5-8 expression",
      "safe 10-16 expression",
      "call 18-21 expression",
      "lambda 23-25 expression",
      "text 27-29 expression",
      "last 31-31 expression",
    ]);
    assert.deepEqual(findDefinitions(source, "fake"), []);
  });

  it("ends before the next member, an annotation line or the closing brace of the class", () => {
    const source = numbered(`
      1 | class C {
      2 |     fun a() = 1
      3 |     @Deprecated("x")
      4 |     fun b() = 2
      5 |     val v = 3
      6 |     fun c() = 4
      7 | }
    `);
    assert.deepEqual(summaries(source), ["C.a 2-2 expression", "C.b 4-4 expression", "C.c 6-6 expression"]);
  });
});

describe("owners, overloads and local functions", () => {
  it("names the owner: nested classes, companion objects (the enclosing class) and objects", () => {
    const source = numbered(`
       1 | class Repo {
       2 |     fun load(): Int {
       3 |         return 1
       4 |     }
       5 |
       6 |     class Inner {
       7 |         fun load() = 2
       8 |     }
       9 |
      10 |     companion object {
      11 |         fun create() = Repo()
      12 |     }
      13 | }
      14 |
      15 | object Singleton {
      16 |     fun go() {}
      17 | }
    `);
    assert.deepEqual(summaries(source), [
      "Repo.load 2-4 block",
      "Repo.Inner.load 7-7 expression",
      "Repo.create 11-11 expression",
      "Singleton.go 16-16 block",
    ]);
  });

  it("keeps the owner when the constructor starts on the line after the class name", () => {
    const source = numbered(`
       1 | class View @JvmOverloads
       2 | constructor(context: Context, attrs: Int = 0) : Base(context) {
       3 |     fun draw() {}
       4 | }
       5 |
       6 | class Injected
       7 | @Inject constructor(val a: A) {
       8 |     fun f() = 1
       9 | }
      10 |
      11 | class Plain
      12 | @Deprecated("x")
      13 | fun after() = 1
    `);
    assert.deepEqual(summaries(source), ["View.draw 3-3 block", "Injected.f 8-8 expression", "after 13-13 expression"]);
  });

  it("finds a function by name inside functions, nested classes and anonymous objects, and skips what cannot hold it", () => {
    const source = numbered(`
       1 | fun other() {
       2 |     fun target() = 1
       3 | }
       4 | class A {
       5 |     fun skip() = 1
       6 |     class B {
       7 |         fun target() {
       8 |         }
       9 |     }
      10 | }
      11 | class C {
      12 |     fun nothing() = "target in a string"
      13 |     // target in a comment
      14 | }
      15 | fun make() = object : Runnable {
      16 |     override fun run() {
      17 |         fun target() = 2
      18 |     }
      19 | }
      20 | fun after() = 3
    `);
    assert.deepEqual(summaries(source, "target"), ["target 2-2 expression in other", "A.B.target 7-8 block", "target 17-17 expression in run"]);
    assert.deepEqual(summaries(source, "skip"), ["A.skip 5-5 expression"]);
    assert.deepEqual(summaries(source, "nothing"), ["C.nothing 12-12 expression"]);
    assert.deepEqual(summaries(source, "after"), ["after 20-20 expression"]);
    for (const def of findDefinitions(source)) {
      assert.deepEqual(findDefinitions(source, def.name), findDefinitions(source).filter((other) => other.name === def.name));
    }
  });

  it("returns every overload and every same-named function, in file order", () => {
    const source = numbered(`
      1 | class A {
      2 |     fun log(m: String) {}
      3 |     fun log(m: Int) = log("$m")
      4 | }
      5 | class B {
      6 |     fun log(m: String) {}
      7 | }
      8 | fun log(m: Any) {}
    `);
    assert.deepEqual(summaries(source, "log"), ["A.log 2-2 block", "A.log 3-3 expression", "B.log 6-6 block", "log 8-8 block"]);
    assert.deepEqual(findDefinitions(source, "nope"), []);
  });

  it("reports local functions with their parent, also when they share a name with a top-level one", () => {
    const source = numbered(`
       1 | fun outer() {
       2 |     val seen = HashSet<Int>()
       3 |     fun visit(n: Int) {
       4 |         if (!seen.add(n)) return
       5 |         visit(n + 1)
       6 |     }
       7 |     fun visit2() = visit(0)
       8 |     visit2()
       9 | }
      10 |
      11 | fun visit(n: Int) = n
    `);
    assert.deepEqual(summaries(source), [
      "outer 1-9 block",
      "visit 3-6 block in outer",
      "visit2 7-7 expression in outer",
      "visit 11-11 expression",
    ]);
    assert.deepEqual(summaries(source, "visit"), ["visit 3-6 block in outer", "visit 11-11 expression"]);
  });

  it("finds functions in enum entries and anonymous objects without disturbing the enclosing ranges", () => {
    const source = numbered(`
       1 | enum class Op {
       2 |     ADD {
       3 |         override fun apply(a: Int, b: Int) = a + b
       4 |     },
       5 |     SUB {
       6 |         override fun apply(a: Int, b: Int): Int {
       7 |             return a - b
       8 |         }
       9 |     };
      10 |
      11 |     abstract fun apply(a: Int, b: Int): Int
      12 | }
      13 |
      14 | fun make(): Runnable {
      15 |     return object : Runnable {
      16 |         override fun run() {
      17 |         }
      18 |     }
      19 | }
    `);
    const span = (name) => findDefinitions(source, name).map((d) => `${d.start}-${d.end} ${d.body}`);
    assert.deepEqual(span("apply"), ["3-3 expression", "6-8 block", "11-11 none"]);
    assert.deepEqual(span("make"), ["14-19 block"]);
    assert.deepEqual(span("run"), ["16-17 block"]);
  });
});

describe("odd input", () => {
  it("gives the same lines for Windows line endings", () => {
    const source = numbered(`
      1 | fun greet(name: String) {
      2 |     println(name)
      3 | }
      4 | fun one() =
      5 |     1
    `);
    assert.deepEqual(summaries(source.replace(/\n/g, "\r\n")), summaries(source));
    assert.deepEqual(summaries(source), ["greet 1-3 block", "one 4-5 expression"]);
  });

  it("reads names made of letters above Latin-1, and text next to them", () => {
    const source = numbered(`
      1 | // комментарий — ’
      2 | fun функция() = 1
      3 | class 名前 {
      4 |     fun \`名 前\`() {
      5 |     }
      6 | }
      7 | val s = "’ — fun fake() {"
      8 | fun after() = 2
    `);
    assert.deepEqual(summaries(source), ["функция 2-2 expression", "名前.名 前 4-5 block", "after 8-8 expression"]);
  });

  it("does not fail on an empty file or a file that ends in the middle of a declaration", () => {
    assert.deepEqual(findDefinitions(""), []);
    assert.doesNotThrow(() => findDefinitions("fun b("));
    const open = findDefinitions("fun a() {\n    println()\n");
    assert.deepEqual(open.map(summary), ["a 1-2 block"]);
    assert.equal(open[0].unclosed, true);
    assert.equal(findDefinitions("fun a() {\n}\n")[0].unclosed, false);
  });

  it("reads a file of 140,000 lines in a few seconds", () => {
    const parts = [];
    for (let i = 0; i < 20000; i++) {
      parts.push(`class C${i} {`, `    fun f${i}(x: Int): Int {`, "        if (x > 0) { return x }", "        return -x", "    }", `    fun g${i}() = f${i}(1)`, "}");
    }
    const source = `${parts.join("\n")}\n`;
    const started = Date.now();
    const all = findDefinitions(source);
    assert.ok(Date.now() - started < 5000, "took too long");
    assert.equal(all.length, 40000);
    assert.deepEqual(findDefinitions(source, "g19999").map(summary), ["C19999.g19999 139999-139999 expression"]); // class i starts at line 7 * i + 1
  });
});

describe("blankNoise with multi-dollar strings", () => {
  it("treats only a run of dollars as long as the prefix as a template", () => {
    const two = blankNoise('val s = $$"""a $\{b} $$\{c}"""');
    assert.ok(two.includes("c"), "$${c} is a template");
    assert.ok(!two.includes("b"), "${b} is literal text");
    const line = blankNoise('val s = $$"a $\{b} $$\{c}"');
    assert.ok(line.includes("c") && !line.includes("b"));
    const three = blankNoise('val s = $$$"""a $$\{b} $$$\{c}"""');
    assert.ok(three.includes("c") && !three.includes("b"));
  });

  it("keeps the rest of the file in code after a literal ${ with no closing brace", () => {
    const out = blankNoise('val s = $$"""{ "${x" }"""\nval y = 1\n');
    assert.ok(out.includes("val y = 1"));
  });
});

describe("blankNoise: letters above Latin-1 and the two ways of writing the result", () => {
  const code = 'val 名 = "é ’ x" // д — \nfun f() {}\n';

  it("keeps a letter above Latin-1 that stays code and blanks the ones in comments and strings", () => {
    const out = blankNoise(code);
    assert.equal(out.length, code.length);
    assert.ok(out.includes("val 名 ="));
    assert.ok(!out.includes("’") && !out.includes("д") && !out.includes("é") && !out.includes("—"));
  });

  it("puts a one-letter stand-in there when exact is false, and changes nothing else", () => {
    assert.equal(blankNoise(code, { exact: false }), blankNoise(code).replace("名", "\u00aa"));
  });

  it("gives the same result when so many characters are wide that the result is built from text", () => {
    const sparse = blankNoise(`${code}// ${"x".repeat(5000)}\n`, { marks: true });
    const dense = blankNoise(`${code}// ${"名".repeat(5000)}\n`, { marks: true });
    assert.equal(dense.slice(0, code.length), sparse.slice(0, code.length));
    assert.ok(dense.includes("val 名 ="));
  });

  it("finds functions in a source that is mostly wide characters", () => {
    const source = `// ${"名".repeat(4000)}\nfun 関数() = 1\nclass 名 {\n    fun メソッド() {\n    }\n}\n`;
    assert.deepEqual(summaries(source), ["関数 2-2 expression", "名.メソッド 4-5 block"]);
  });
});

describe("the find-def command", () => {
  let dir;
  let file;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "find-def-"));
    file = join(dir, "Repo.kt");
    writeFileSync(
      file,
      numbered(`
        1 | package app
        2 |
        3 | class UserRepository {
        4 |     fun getUser(id: Int): String {
        5 |         return "u$id"
        6 |     }
        7 |
        8 |     fun count() = 3
        9 | }
      `),
    );
    writeFileSync(join(dir, "Other.java"), "class Other {}\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("prints owner.name, the file and the line range of the named function", () => {
    const result = run(file, "getUser");
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /UserRepository\.getUser/);
    assert.ok(lines[0].includes(`${file}:4-6`), lines[0]);
    assert.match(lines[0], /block/);
  });

  it("lists every function of the file in file order when no name is given", () => {
    const result = run(file);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes("getUser") && lines[0].includes(":4-6"));
    assert.ok(lines[1].includes("count") && lines[1].includes(":8-8") && /expression/.test(lines[1]));
  });

  it("prints JSON with --json", () => {
    const result = run(file, "count", "--json");
    assert.equal(result.status, 0, result.stderr);
    const [only, ...rest] = JSON.parse(result.stdout);
    assert.equal(rest.length, 0);
    assert.deepEqual(
      { name: only.name, owner: only.owner, start: only.start, end: only.end, body: only.body, bodyStart: only.bodyStart, local: only.local, unclosed: only.unclosed },
      { name: "count", owner: "UserRepository", start: 8, end: 8, body: "expression", bodyStart: 8, local: false, unclosed: false },
    );
  });

  it("exits 1 when the name is not declared in the file", () => {
    const result = run(file, "nope");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no function named "nope"/);
  });

  it("exits 2 for a missing file, a non-Kotlin file and missing arguments", () => {
    const missing = run(join(dir, "Missing.kt"));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /cannot read/);
    const java = run(join(dir, "Other.java"));
    assert.equal(java.status, 2);
    assert.match(java.stderr, /\.kt/);
    const none = run();
    assert.equal(none.status, 2);
    assert.match(none.stdout, /usage/);
    assert.equal(run("--help").status, 0);
  });
});
