// Tests for the usage scan: the blanking lexer, the declaration reader, and the
// whole scan on a small fixture project written to a temp directory. The scan
// tests need ripgrep and are skipped without it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../graph.mjs";
import { parseKotlin } from "../kotlin-symbols.mjs";
import { blankNoise, blankXmlComments } from "../lex.mjs";
import { renderText } from "../render.mjs";
import { findUsages, UsageError } from "../usages.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "find-usages.mjs");
const hasRg = spawnSync("rg", ["--version"]).status === 0;

const USER_REPOSITORY = `package com.x.data

import com.x.model.User

/** UserRepository talks to the API. */
class UserRepository(private val api: Api, val cache: Cache) {
    companion object {
        const val TAG = "UserRepository"
        fun create(): UserRepository = UserRepository(Api(), Cache())
    }

    fun getUser(id: Int): User {
        val local = cache.find(id)
        return local ?: api.fetch(id)
    }

    private fun hidden() = 1

    override fun toString() = "UserRepository"
}

fun helper() = 42
`;

const FILES = {
  "app/data/UserRepository.kt": USER_REPOSITORY,
  "app/ui/LoginViewModel.kt": `package com.x.ui

import com.x.data.UserRepository

class LoginViewModel(private val repo: UserRepository) {
    fun load() = repo.getUser(1)
}
`,
  "app/data/Same.kt": `package com.x.data

class Same {
    val repo = UserRepository(Api(), Cache())
    val text = "value \${helper()} for $repo"
}
`,
  "app/other/Other.kt": `package com.y

import com.y.UserRepository

class Other(val r: UserRepository)
`,
  "app/ui/Screen.kt": `package com.x.ui

class Screen(val vm: Holder) {
    fun show() = vm.current.getUser(2)
    // UserRepository in a comment
}
`,
  "app/ui/CouponCard.kt": `package com.x.ui

class CouponCard
`,
  "app/res/layout/card.xml": `<LinearLayout>
    <!-- CouponCard in a comment -->
    <com.x.ui.CouponCard android:onClick="getUser" android:id="@+id/getUser" />
    <fragment android:name=".CouponCard" />
</LinearLayout>
`,
};

describe("blankNoise", () => {
  it("blanks comments and strings, keeps offsets and template expressions", () => {
    const source = 'val a = "TEXT $name ${expr + 1}" // NOISE1\n/* NOISE2 /* nested */ NOISE3 */ val c = \'x\'\n';
    const out = blankNoise(source);
    assert.equal(out.length, source.length);
    assert.equal([...out].filter((ch) => ch === "\n").length, 2);
    for (const gone of ["TEXT", "NOISE1", "NOISE2", "NOISE3", "'x'"]) assert.ok(!out.includes(gone), gone);
    for (const kept of ["val a", "name", "expr", "val c"]) assert.ok(out.includes(kept), kept);
  });

  it("does not let an unterminated string swallow the next lines", () => {
    assert.ok(blankNoise('val a = "oops\nval b = 1').includes("val b"));
  });

  it("blanks XML comments only", () => {
    const out = blankXmlComments('<a x="v"><!-- gone\nhere --></a>');
    assert.ok(out.includes('x="v"') && !out.includes("gone") && out.includes("\n"));
  });
});

describe("parseKotlin", () => {
  it("reads package, imports and declared symbols with owners", () => {
    const parsed = parseKotlin(USER_REPOSITORY);
    assert.equal(parsed.pkg, "com.x.data");
    assert.deepEqual(parsed.imports.map((i) => i.fqn), ["com.x.model.User"]);
    const by = Object.fromEntries(parsed.symbols.map((s) => [s.name, s]));
    assert.deepEqual([by.UserRepository.kind, by.UserRepository.owner], ["class", null]);
    for (const member of ["api", "cache", "TAG", "create", "getUser", "hidden", "toString"]) assert.equal(by[member].owner, "UserRepository", member);
    assert.equal(by.helper.owner, null);
    assert.ok(by.api.private && by.hidden.private && !by.getUser.private);
    assert.ok(by.toString.override);
    assert.equal(by.local, undefined, "locals are not symbols");
  });

  it("reads a primary constructor split over several lines", () => {
    const { symbols } = parseKotlin("class A(\n    val x: Int,\n    private var y: String = \"\",\n) : Base() {\n    fun f() { val z = 1 }\n}\n");
    assert.deepEqual(symbols.map((s) => `${s.owner}.${s.name}`), ["null.A", "A.x", "A.y", "A.f"]);
  });
});

describe("class headers", () => {
  it("reads supertypes over several lines and the line range of a class", () => {
    const { classes } = parseKotlin("class Leaf(\n    val x: Int,\n) : Mid(),\n    Runnable {\n    fun f() {}\n}\nobject O : Base<String>()\ninterface I : A, B by c\n");
    assert.deepEqual(classes.map((c) => [c.name, c.supers, c.start, c.end]), [
      ["Leaf", ["Mid", "Runnable"], 1, 6],
      ["O", ["Base"], 7, 7],
      ["I", ["A", "B"], 8, 8],
    ]);
  });

  it("reads the receiver of an extension function", () => {
    const { extFuns } = parseKotlin("fun List<String>.shout() {\n    println(this)\n}\nfun Base.ext() = 1\n");
    assert.deepEqual(extFuns.map((f) => [f.receiver, f.name, f.start, f.end]), [["List", "shout", 1, 3], ["Base", "ext", 4, 4]]);
  });
});

const HIERARCHY = {
  "app/Base.kt": `package com.h

open class Base {
    fun ping() {}
    open val flag = true
}
`,
  "app/Mid.kt": `package com.h

open class Mid : Base(), Marker
interface Marker
`,
  "app/Leaf.kt": `package com.h

class Leaf(
    val x: Int,
) : Mid(),
    Runnable {
    override fun run() {
        ping()
        this.ping()
        val s = "\${ping()}"
        build(ping = 2)
    }
    override val flag = false
}
`,
  "app/Act.kt": `package com.h

class Act : Other() {
    val leaf: Leaf = Leaf(1)
    fun ping() {}
    fun go(thing: Any) {
        ping()
        leaf.ping()
    }
}
`,
  "app/JLeaf.java": `package com.h;

public class JLeaf extends Base {
    void f() { ping(); }
}
`,
  "app/Free.kt": `package com.h

fun Base.ext() {
    ping()
}
`,
  "app/Lone.kt": `package com.h

class Lone {
    fun a(b: Any) = b.ping()
}
`,
};

describe("members and the class family", { skip: !hasRg && "ripgrep not installed" }, () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "find-usages-family-"));
    for (const [rel, text] of Object.entries(HIERARCHY)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const tiers = async (name) => {
    const group = (await findUsages({ file: join(root, "app/Base.kt"), name, root })).groups[0];
    const rows = {};
    for (const tier of ["certain", "likely", "ambiguous"]) for (const hit of group.hits[tier]) rows[`${hit.path.replace("app/", "")}:${hit.line}`] = tier;
    return { rows, group };
  };

  it("finds the classes below a class, through Kotlin and Java", async () => {
    const result = await findUsages({ file: join(root, "app/Base.kt"), name: "ping", root });
    assert.deepEqual(result.stats.families, { Base: 4 }); // Base, Mid, Leaf and the Java JLeaf; Act extends Other
  });

  it("settles calls without a receiver by the enclosing class", async () => {
    const { rows, group } = await tiers("ping");
    assert.equal(rows["Leaf.kt:8"], "certain", "implicit call in a subclass");
    assert.equal(rows["Leaf.kt:9"], "certain", "this.ping()");
    assert.equal(rows["Leaf.kt:10"], "certain", "inside a string template");
    assert.equal(rows["JLeaf.java:4"], "certain", "Java subclass");
    assert.equal(rows["Free.kt:4"], "certain", "inside an extension function of Base");
    assert.equal(rows["Act.kt:7"], undefined, "implicit call in a class that does not extend Base");
    assert.equal(rows["Act.kt:5"], undefined, "another declaration of ping");
    assert.equal(rows["Leaf.kt:11"], undefined, "named argument");
    assert.ok(group.counts.other >= 3);
  });

  it("keeps explicit receivers as likely or ambiguous by what the file mentions", async () => {
    const { rows } = await tiers("ping");
    assert.equal(rows["Act.kt:8"], "likely", "the file mentions Leaf, a subclass");
    assert.equal(rows["Lone.kt:4"], "ambiguous", "nothing in the file points to Base");
  });

  it("treats a redeclaration in a subclass as likely", async () => {
    const { rows } = await tiers("flag");
    assert.equal(rows["Leaf.kt:13"], "likely");
  });
});

describe("findUsages", { skip: !hasRg && "ripgrep not installed" }, () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "find-usages-"));
    for (const [rel, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const groupOf = (result, name) => result.groups.find((g) => g.name === name);
  const paths = (hits) => hits.map((h) => h.path);

  it("sorts the uses of a class into tiers and counts what it hides", async () => {
    const result = await findUsages({ file: join(root, "app/data/UserRepository.kt"), root });
    const group = groupOf(result, "UserRepository");
    assert.deepEqual(
      group.hits.certain.map((h) => `${h.path}|${h.why}`),
      ["app/data/UserRepository.kt|same file", "app/data/UserRepository.kt|same file", "app/ui/LoginViewModel.kt|import", "app/ui/LoginViewModel.kt|imported"],
    );
    assert.deepEqual(group.hits.likely.map((h) => `${h.path}|${h.why}`), ["app/data/Same.kt|same package"]);
    assert.ok(group.counts.other >= 2, "the class of package com.y is another symbol");
    assert.ok(!paths([...group.hits.certain, ...group.hits.likely, ...group.hits.ambiguous]).includes("app/other/Other.kt"));
    assert.ok(group.counts.noise >= 4, `noise ${group.counts.noise}`);
    assert.ok(group.counts.decl >= 1);
  });

  it("leaves private and overriding declarations out unless asked", async () => {
    const file = join(root, "app/data/UserRepository.kt");
    const names = (result) => result.groups.map((g) => g.name);
    assert.ok(!names(await findUsages({ file, root })).some((n) => n === "hidden" || n === "toString" || n === "api"));
    const all = names(await findUsages({ file, root, includePrivate: true, includeOverride: true }));
    for (const n of ["hidden", "toString", "api"]) assert.ok(all.includes(n), n);
  });

  it("marks a member call with an invisible receiver as ambiguous and reads XML references", async () => {
    const result = await findUsages({ file: join(root, "app/data/UserRepository.kt"), name: "getUser", root });
    assert.equal(result.groups.length, 1);
    const group = result.groups[0];
    assert.deepEqual(paths(group.hits.ambiguous), ["app/ui/Screen.kt"]);
    assert.ok(paths(group.hits.likely).includes("app/ui/LoginViewModel.kt"), "the file mentions and imports the owner");
    assert.ok(group.hits.likely.some((h) => h.path === "app/res/layout/card.xml" && h.why === "onClick handler"));
    assert.ok(group.counts.other >= 1, "@+id/getUser is a resource name");
  });

  it("keeps the expression of a string template", async () => {
    const result = await findUsages({ file: join(root, "app/data/UserRepository.kt"), name: "helper", root });
    assert.ok(result.groups[0].hits.likely.some((h) => h.path === "app/data/Same.kt" && h.text.includes("helper()")));
  });

  it("finds qualified and relative references of a custom view in XML", async () => {
    const result = await findUsages({ file: join(root, "app/ui/CouponCard.kt"), root });
    const group = groupOf(result, "CouponCard");
    assert.ok(group.hits.certain.some((h) => h.why === "qualified name"));
    assert.ok(group.hits.likely.some((h) => h.why === "relative to the manifest package"));
    assert.ok(group.counts.noise >= 1, "the XML comment");
  });

  it("rejects an unknown name and a non-Kotlin start file", async () => {
    await assert.rejects(findUsages({ file: join(root, "app/data/UserRepository.kt"), name: "nope", root }), (e) => e instanceof UsageError && /declared here: .*getUser/.test(e.message));
    await assert.rejects(findUsages({ file: join(root, "app/res/layout/card.xml"), root }), UsageError);
  });

  it("runs from the command line", () => {
    const run = (...args) => spawnSync(process.execPath, [CLI, join(root, "app/data/UserRepository.kt"), ...args, "--root", root], { encoding: "utf8" });
    const text = run("getUser");
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /ambiguous \(1\)[\s\S]*Screen\.kt:4/);
    const json = run("getUser", "--json", "--stats");
    assert.equal(JSON.parse(json.stdout).groups[0].name, "getUser");
    assert.match(json.stderr, /scanned \d+ files/);
    assert.equal(run("nope").status, 2);
    const jev = run("getUser", "--jev");
    assert.equal(jev.status, 1, "the --jev option is gone");
    assert.match(jev.stderr, /--jev/);
    assert.equal(jev.stdout, "");
  });
});

const GRAPH_FILES = {
  "app/x/X.kt": `package com.g.x

import com.g.y.Y
import com.g.z.Z
import com.g.z.helper

class X(val y: Y) {
    fun f() = Z().g()
    fun h() = helper(1)
}
`,
  "app/a/A.kt": `package com.g.a

import com.g.x.X
import com.g.x.Outer
import com.g.z.shout

class A {
    val x = X(null!!)
    val i = Outer.Inner()
    fun s() = "x".shout()
}
`,
  "app/a/B.kt": `package com.g.a

import com.g.x.X

class B { fun f(x: X) = x }
`,
  "app/a/C.kt": `package com.g.a

class C { val x = com.g.x.X(null!!) }
`,
  "app/a/Noise.kt": `package com.g.a

import com.g.x.X

// X in a comment
class Noise { val s = "X" }
`,
  "app/y/Y.kt": `package com.g.y

import com.g.k.K

class Y { val k = K() }
`,
  "app/k/K.kt": `package com.g.k

class K
`,
  "app/z/Z.kt": `package com.g.z

class Z { fun g() = 1 }
fun helper(n: Int) = n
`,
  "app/z/Ext.kt": `package com.g.z

fun String.shout() = this
`,
  "app/z/Q.kt": `package com.g.z

class Q {
    fun helper() = 2
    fun u() = helper()
}
`,
  "app/x/Outer.kt": `package com.g.x

class Outer {
    class Inner
}
`,
  "app/p/Dup.kt": `package com.g.p

class Dup
`,
  "app/q/Dup.kt": `package com.g.q

class Dup
`,
  "app/x/UsesDup.kt": `package com.g.x

import com.g.q.Dup

class UsesDup(val d: Dup)
`,
  "app/r1/Result.kt": `package com.g.r1

class Result {
    class Success
}
`,
  "app/r2/Result.kt": `package com.g.r2

class Result {
    class Success
}
`,
  "app/x/UsesResult.kt": `package com.g.x

import com.g.r1.Result

class UsesResult {
    val s = Result.Success()
}
`,
  "app/m/M.kt": `package com.g.m

class M { fun n() = N() }
`,
  "app/m/N.kt": `package com.g.m

class N { fun m() = M() }
`,
};

describe("the dependency graph", { skip: !hasRg && "ripgrep not installed" }, () => {
  const GRAPH = join(dirname(fileURLToPath(import.meta.url)), "..", "graph.mjs");
  const CLASS_GRAPH = join(dirname(fileURLToPath(import.meta.url)), "..", "class-graph.mjs");
  let root;
  let graph;
  let walkGraph;
  let renderGraphMermaid;
  let renderGraphText;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "find-usages-graph-"));
    for (const [rel, text] of Object.entries(GRAPH_FILES)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const module = await import(GRAPH);
    ({ walkGraph } = module);
    ({ renderGraphMermaid, renderGraphText } = await import("../graph-render.mjs"));
    graph = await module.buildGraph(root, { cache: { enabled: false } });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const idOf = (path, display) => `${path}#${display}`;
  const name = (id) => graph.nodes.get(id).display;
  const names = (ids) => [...ids].map(name).sort();
  const edge = (from, to) => graph.out.get(from)?.get(to);

  it("makes nodes of classes, nested classes and top-level functions", () => {
    const all = names(graph.nodes.keys());
    for (const expected of ["A", "B", "C", "X", "Y", "Z", "K", "Outer", "Outer.Inner", "helper", "shout", "Dup", "Q"]) assert.ok(all.includes(expected), expected);
  });

  it("walks down from X to the end of the chain, with the lines of every use", () => {
    const x = idOf("app/x/X.kt", "X");
    const { down } = walkGraph(graph, [x], { down: 5, up: 0 });
    assert.deepEqual(names(down.depth.keys()), ["K", "X", "Y", "Z", "helper"]);
    assert.deepEqual([edge(x, idOf("app/y/Y.kt", "Y")).lines, edge(x, idOf("app/z/Z.kt", "Z")).lines, edge(x, idOf("app/z/Z.kt", "helper")).lines], [[7], [8], [9]]);
    assert.deepEqual(edge(idOf("app/y/Y.kt", "Y"), idOf("app/k/K.kt", "K")).lines, [5]);
    assert.equal(down.depth.get(idOf("app/k/K.kt", "K")), 2);
  });

  it("stops at the depth limit and at the node cap", () => {
    const x = idOf("app/x/X.kt", "X");
    assert.deepEqual(names(walkGraph(graph, [x], { down: 1, up: 0 }).down.depth.keys()), ["X", "Y", "Z", "helper"]);
    const capped = walkGraph(graph, [x], { down: 5, up: 0, maxNodes: 3 }).down;
    assert.ok(capped.truncated && capped.depth.size === 3);
  });

  it("walks up to the users of X, whatever the way it is named", () => {
    const x = idOf("app/x/X.kt", "X");
    const { up } = walkGraph(graph, [x], { down: 0, up: 5 });
    assert.deepEqual(names(up.depth.keys()), ["A", "B", "C", "X"]);
    assert.deepEqual([edge(idOf("app/a/A.kt", "A"), x).lines, edge(idOf("app/a/B.kt", "B"), x).lines, edge(idOf("app/a/C.kt", "C"), x).lines], [[8], [5], [3]]);
    assert.equal(edge(idOf("app/a/C.kt", "C"), x).tier, "certain", "a fully qualified name");
  });

  it("leaves out comments, strings, shadowed names and classes of the same name from another package", () => {
    const x = idOf("app/x/X.kt", "X");
    assert.equal(edge(idOf("app/a/Noise.kt", "Noise"), x), undefined);
    assert.equal(edge(idOf("app/z/Q.kt", "Q"), idOf("app/z/Z.kt", "helper")), undefined, "Q has its own helper()");
    const usesDup = idOf("app/x/UsesDup.kt", "UsesDup");
    assert.deepEqual([...graph.out.get(usesDup).keys()], [idOf("app/q/Dup.kt", "Dup")]);
  });

  it("keeps same-named nested classes of two packages apart", () => {
    const uses = idOf("app/x/UsesResult.kt", "UsesResult");
    assert.deepEqual(names(graph.out.get(uses).keys()), ["Result", "Result.Success"]);
    assert.ok([...graph.out.get(uses).keys()].every((id) => id.startsWith("app/r1/")));
  });

  it("maps nested classes and extension functions", () => {
    const a = idOf("app/a/A.kt", "A");
    assert.deepEqual(edge(a, idOf("app/x/Outer.kt", "Outer.Inner")).lines, [9]);
    assert.deepEqual(edge(a, idOf("app/z/Ext.kt", "shout")).lines, [10]);
  });

  it("handles a cycle and prints each node once in full", () => {
    const m = idOf("app/m/M.kt", "M");
    const walked = walkGraph(graph, [m], { down: 5, up: 0 });
    assert.deepEqual(names(walked.down.depth.keys()), ["M", "N"]);
    const text = renderGraphText(graph, [m], walked, { down: 5, up: 0, maxNodes: 300, maxLines: 400 });
    assert.match(text, /N {2}\[class\].*\n.*M {2}\[class\].*\(shown above\)/);
  });

  it("draws the same graph as Mermaid and as JSON from the command line", () => {
    const x = idOf("app/x/X.kt", "X");
    const mermaid = renderGraphMermaid(graph, [x], walkGraph(graph, [x], { down: 2, up: 1 }));
    assert.match(mermaid, /^graph LR/);
    assert.match(mermaid, /n\d+ -->\|"A\.kt:8"\| n\d+/);
    const run = (...args) => spawnSync(process.execPath, [CLASS_GRAPH, ...args, "--root", root, "--no-cache"], { encoding: "utf8" });
    const text = run(join(root, "app/x/X.kt"), "--down", "1", "--up", "1", "--stats");
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Uses \(up to 1 levels\): 3 nodes[\s\S]*Used by \(up to 1 levels\): 3 nodes/);
    assert.match(text.stderr, /graph: 19 files/);
    const json = JSON.parse(run("X", "--format", "json").stdout);
    assert.deepEqual(json.roots, [x]);
    assert.ok(json.edges.some((e) => e.from === idOf("app/a/B.kt", "B") && e.to === x));
    assert.equal(run("Dup").status, 2, "a name declared twice asks for the file");
    assert.match(run("Dup").stderr, /declared in 2 places/);
  });
});


describe("the graph cache", { skip: !hasRg && "ripgrep not installed" }, () => {
  let root;
  let cacheDir;
  let clock = 0;
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    const when = new Date(Date.now() + ++clock * 5000); // a distinct mtime for every write
    utimesSync(join(root, rel), when, when);
  };
  const snapshot = (graph) => ({
    nodes: [...graph.nodes.values()].map((n) => `${n.id}|${n.kind}|${n.start}-${n.end}`).sort(),
    edges: [...graph.out.values()].flatMap((m) => [...m.values()]).map((e) => `${e.from}>${e.to}|${e.tier}|${e.count}|${e.lines.join(",")}`).sort(),
  });
  const cached = () => buildGraph(root, { cache: { dir: cacheDir } });
  const fresh = () => buildGraph(root, { cache: { enabled: false } });
  const sameAsFresh = async (graph) => assert.deepEqual(snapshot(graph), snapshot(await fresh()));

  before(() => {
    root = mkdtempSync(join(tmpdir(), "find-usages-cache-"));
    cacheDir = mkdtempSync(join(tmpdir(), "find-usages-cachedir-"));
    for (const [rel, text] of Object.entries(GRAPH_FILES)) write(rel, text);
    write("app/a/Uses.kt", "package com.g.a\n\nclass Uses { val l = Later() }\n");
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("writes the cache on the first run and uses it untouched on the second", async () => {
    const first = await cached();
    assert.equal(first.stats.cache, "miss");
    assert.equal(readdirSync(cacheDir).filter((name) => name.endsWith(".json")).length, 1);
    await sameAsFresh(first);
    const second = await cached();
    assert.deepEqual([second.stats.cache, second.stats.changedFiles, second.stats.rescanned], ["hit", 0, 0]);
    await sameAsFresh(second);
  });

  it("scans only the file that was edited", async () => {
    write("app/x/X.kt", GRAPH_FILES["app/x/X.kt"].replace("fun h() = helper(1)", "fun h() = helper(1)\n    fun k() = com.g.k.K()"));
    const graph = await cached();
    assert.deepEqual([graph.stats.cache, graph.stats.changedFiles, graph.stats.rescanned], ["updated", 1, 1]);
    assert.ok(graph.out.get("app/x/X.kt#X").has("app/k/K.kt#K"));
    await sameAsFresh(graph);
  });

  it("resolves a name in an unchanged file when a class with that name appears, and again when it goes", async () => {
    write("app/a/Later.kt", "package com.g.a\n\nclass Later\n");
    const added = await cached();
    assert.deepEqual([added.stats.changedFiles, added.stats.rescanned], [1, 2]);
    assert.ok(added.out.get("app/a/Uses.kt#Uses").has("app/a/Later.kt#Later"));
    await sameAsFresh(added);
    unlinkSync(join(root, "app/a/Later.kt"));
    const gone = await cached();
    assert.deepEqual([gone.stats.removedFiles, gone.stats.rescanned], [1, 1]);
    assert.equal(gone.out.get("app/a/Uses.kt#Uses"), undefined);
    await sameAsFresh(gone);
  });

  it("follows a package change into the files that import from it", async () => {
    write("app/z/Z.kt", GRAPH_FILES["app/z/Z.kt"].replace("package com.g.z", "package com.g.zz"));
    const graph = await cached();
    assert.equal(graph.out.get("app/x/X.kt#X").has("app/z/Z.kt#Z"), false, "X still imports com.g.z.Z");
    await sameAsFresh(graph);
  });

  it("treats a branch switch (many files rewritten, some back to old content) like any other change", async () => {
    for (const [rel, text] of Object.entries(GRAPH_FILES)) write(rel, text);
    write("app/a/Uses.kt", "package com.g.a\n\nclass Uses { val l = Later() }\n");
    const graph = await cached();
    assert.equal(graph.stats.cache, "updated");
    await sameAsFresh(graph);
  });

  it("only rescans the touched file when its declarations did not change", async () => {
    write("app/y/Y.kt", readFileSync(join(root, "app/y/Y.kt"), "utf8"));
    const graph = await cached();
    assert.deepEqual([graph.stats.changedFiles, graph.stats.rescanned], [1, 1]);
  });

  it("starts over when the cache is damaged, belongs to other code or to other options", async () => {
    const file = join(cacheDir, readdirSync(cacheDir).find((name) => name.endsWith(".json")));
    writeFileSync(file, "{ not json");
    assert.equal((await cached()).stats.cache, "miss");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n{ not json either`);
    assert.equal((await cached()).stats.cache, "miss", "a damaged record anywhere retires the cache");
    const [header, ...rest] = readFileSync(file, "utf8").split("\n");
    writeFileSync(file, [JSON.stringify({ ...JSON.parse(header), tool: "other" }), ...rest].join("\n"));
    assert.equal((await cached()).stats.cache, "miss");
    assert.equal((await buildGraph(root, { classesOnly: true, cache: { dir: cacheDir } })).stats.cache, "miss", "other options use their own cache file");
    assert.equal((await buildGraph(root, { cache: { dir: cacheDir, rebuild: true } })).stats.cache, "miss");
  });

  it("does not touch the disk with the cache off", async () => {
    const empty = mkdtempSync(join(tmpdir(), "find-usages-nocache-"));
    const graph = await buildGraph(root, { cache: { enabled: false, dir: empty } });
    assert.equal(graph.stats.cache, "off");
    assert.equal(existsSync(join(empty, "x")) || readdirSync(empty).length > 0, false);
    rmSync(empty, { recursive: true, force: true });
  });
});

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("the graph cache with git", { skip: (!hasRg || !hasGit) && "ripgrep or git not installed" }, () => {
  let base;
  const git = (cwd, ...args) => {
    const done = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    assert.equal(done.status, 0, `git ${args.join(" ")}: ${done.stderr}`);
    return done.stdout;
  };
  const put = (dir, rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const snapshot = (graph) => ({
    nodes: [...graph.nodes.values()].map((n) => `${n.id}|${n.kind}|${n.start}-${n.end}`).sort(),
    edges: [...graph.out.values()].flatMap((m) => [...m.values()]).map((e) => `${e.from}>${e.to}|${e.tier}|${e.count}|${e.lines.join(",")}`).sort(),
  });
  let cacheDir;
  const cachedIn = (dir) => buildGraph(dir, { cache: { dir: cacheDir } });
  const check = async (dir, expectedState) => {
    const graph = await cachedIn(dir);
    if (expectedState) assert.equal(graph.stats.cache, expectedState);
    assert.deepEqual(snapshot(graph), snapshot(await buildGraph(dir, { cache: { enabled: false } })));
    return graph;
  };

  before(() => {
    base = mkdtempSync(join(tmpdir(), "find-usages-git-"));
    cacheDir = join(base, "cache");
    git(base, "init", "-q", "--bare", "-b", "main", "remote.git");
    git(base, "clone", "-q", "remote.git", "work");
    git(base, "clone", "-q", "remote.git", "other");
    const work = join(base, "work");
    for (const [rel, text] of Object.entries(GRAPH_FILES)) put(work, rel, text);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "start");
    git(work, "push", "-q", "origin", "HEAD:main");
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it("follows a branch switch there and back, and a git pull", async () => {
    const work = join(base, "work");
    const main = snapshot(await check(work, "miss"));
    git(work, "switch", "-q", "-c", "feature");
    put(work, "app/x/X.kt", GRAPH_FILES["app/x/X.kt"].replace("fun h() = helper(1)", "fun h() = helper(1)\n    fun k() = com.g.k.K()"));
    put(work, "app/a/Added.kt", "package com.g.a\n\nclass Added { val x = com.g.x.X(null!!) }\n");
    git(work, "rm", "-q", "app/a/Noise.kt");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "feature work");
    const feature = await check(work, "updated");
    assert.ok(feature.out.get("app/a/Added.kt#Added").has("app/x/X.kt#X"));
    assert.equal(feature.nodes.has("app/a/Noise.kt#Noise"), false);
    git(work, "switch", "-q", "main");
    assert.deepEqual(snapshot(await check(work, "updated")), main, "back on main the graph is the one from before");

    const other = join(base, "other");
    git(other, "pull", "-q", "origin", "main");
    put(other, "app/k/K.kt", "package com.g.k\n\nclass K { val m = com.g.m.M() }\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "K uses M");
    git(other, "push", "-q", "origin", "HEAD:main");
    git(work, "pull", "-q", "origin", "main");
    const pulled = await check(work, "updated");
    assert.ok(pulled.out.get("app/k/K.kt#K").has("app/m/M.kt#M"));
  });
});
