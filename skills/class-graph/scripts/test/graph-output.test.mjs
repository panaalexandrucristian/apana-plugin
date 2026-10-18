// Tests for what class-graph prints: hubs listed but not expanded, the line budget
// that cuts the walk at whole levels, and the full listing written with --out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildGraph, fitWalk, walkGraph } from "../graph.mjs";
import { renderGraphMermaid, renderGraphText } from "../graph-render.mjs";

const CLASS_GRAPH = join(dirname(fileURLToPath(import.meta.url)), "..", "class-graph.mjs");
const hasRg = spawnSync("rg", ["--version"]).status === 0;

// Root uses A1 and B1; A1 uses Hub, which uses L1..L6; B1 -> C2 -> D3 -> E4; U1 and U2 use Root.
const leaves = ["L1", "L2", "L3", "L4", "L5", "L6"];
const FILES = {
  Root: "class Root {\n    val a = A1()\n    val b = B1()\n}\n",
  A1: "class A1 {\n    val h = Hub()\n}\n",
  Hub: `class Hub {\n${leaves.map((leaf) => `    val ${leaf.toLowerCase()} = ${leaf}()`).join("\n")}\n}\n`,
  B1: "class B1 {\n    val c = C2()\n}\n",
  C2: "class C2 {\n    val d = D3()\n}\n",
  D3: "class D3 {\n    val e = E4()\n}\n",
  E4: "class E4\n",
  U1: "class U1 {\n    val r = Root()\n}\n",
  U2: "class U2 {\n    val r = Root()\n}\n",
  ...Object.fromEntries(leaves.map((leaf) => [leaf, `class ${leaf}\n`])),
};

describe("what class-graph prints", { skip: !hasRg && "ripgrep not installed" }, () => {
  let root;
  let out;
  let graph;
  const id = (name) => `src/${name}.kt#${name}`;
  const names = (ids) => [...ids].map((node) => graph.nodes.get(node).display).sort();
  const run = (...args) => spawnSync(process.execPath, [CLASS_GRAPH, ...args, "--root", root, "--no-cache"], { encoding: "utf8" });

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "find-usages-output-"));
    out = mkdtempSync(join(tmpdir(), "find-usages-out-"));
    mkdirSync(join(root, "src"));
    for (const [name, body] of Object.entries(FILES)) writeFileSync(join(root, "src", `${name}.kt`), `package p\n\n${body}`);
    graph = await buildGraph(root, { cache: { enabled: false } });
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  describe("hubs", () => {
    it("are listed but not walked through, with the count of their neighbours", () => {
      const { down } = walkGraph(graph, [id("Root")], { down: 5, up: 0, hub: 3 });
      assert.deepEqual([...down.hubs], [[id("Hub"), 6]]);
      assert.ok(down.depth.has(id("Hub")));
      assert.deepEqual(names(down.depth.keys()).filter((n) => n.startsWith("L")), [], "the leaves behind the hub are not reached");
    });

    it("are walked through when the limit is off, and a root is never one", () => {
      const off = walkGraph(graph, [id("Root")], { down: 5, up: 0, hub: 0 }).down;
      assert.equal(off.hubs.size, 0);
      assert.equal(names(off.depth.keys()).filter((n) => n.startsWith("L")).length, 6);
      const root = walkGraph(graph, [id("Hub")], { down: 1, up: 0, hub: 3 }).down;
      assert.equal(root.hubs.size, 0, "starting from a hub opens it");
      assert.equal(names(root.depth.keys()).filter((n) => n.startsWith("L")).length, 6);
    });

    it("show in the text as a note and in the Mermaid label", () => {
      const walked = walkGraph(graph, [id("Root")], { down: 5, up: 5, hub: 3 });
      const text = renderGraphText(graph, [id("Root")], walked, { down: 5, up: 5, hub: 3, maxLines: 150 });
      assert.match(text, /Hub {2}\[class\].*\(hub: uses 6, not expanded\)/);
      assert.match(text, /Hub = more than 3 neighbours/);
      assert.match(renderGraphMermaid(graph, [id("Root")], walked), /Hub<br\/>class, hub, not expanded/);
      const up = walkGraph(graph, [id("A1")], { down: 0, up: 5, hub: 1 });
      assert.match(renderGraphText(graph, [id("A1")], up, { down: 0, up: 5, hub: 1, maxLines: 150 }), /Root {2}\[class\].*\(hub: used by 2, not expanded\)/);
      assert.deepEqual(names(up.up.depth.keys()), ["A1", "Root"], "the users of the hub are not reached");
    });
  });

  describe("the line budget", () => {
    const walkAll = (start, down, up) => walkGraph(graph, [id(start)], { down, up, hub: 0 });

    it("keeps whole levels and counts what it hid", () => {
      const walked = fitWalk(walkAll("Root", 5, 5), 6);
      assert.equal(walked.up.cut, null, "two users fit");
      const cut = walked.down.cut;
      assert.deepEqual([cut.levels, cut.partial, cut.total], [1, false, { nodes: 12, edges: 12 }]);
      assert.deepEqual(cut.hidden.map((h) => [h.level, h.nodes]), [[2, 2], [3, 7], [4, 1]]);
      assert.deepEqual(names(walked.down.depth.keys()), ["A1", "B1", "Root"]);
      assert.deepEqual(walked.down.hops, [1, 1]);
    });

    it("gives the lines one direction does not need to the other", () => {
      const evenly = fitWalk(walkAll("E4", 5, 5), 2);
      assert.equal(evenly.up.cut.levels, 2, "nothing is used below E4, so the whole budget goes up");
      assert.deepEqual(names(evenly.up.depth.keys()), ["C2", "D3", "E4"]);
    });

    it("keeps the first edges of level 1 when even level 1 is too big", () => {
      const walked = fitWalk(walkAll("Hub", 1, 1), 4);
      const cut = walked.down.cut;
      assert.deepEqual([cut.levels, cut.partial, walked.down.edges.length], [0, true, 2]);
      assert.deepEqual(cut.hidden, [{ level: 1, nodes: 4, edges: 4 }]);
      assert.deepEqual(names(walked.down.depth.keys()), ["Hub", "L1", "L2"]);
    });

    it("changes nothing for a budget of 0, Infinity or more than the walk needs", () => {
      const walked = walkAll("Root", 5, 5);
      assert.equal(fitWalk(walked, 0), walked);
      assert.equal(fitWalk(walked, Infinity), walked);
      const roomy = fitWalk(walked, 100);
      assert.deepEqual([roomy.down.cut, roomy.up.cut], [null, null]);
      assert.deepEqual(roomy.down.edges, walked.down.edges);
    });

    it("shows in the header and the notes of the text", () => {
      const walked = fitWalk(walkAll("Root", 5, 5), 6);
      const text = renderGraphText(graph, [id("Root")], walked, { down: 5, up: 5, hub: 0, maxLines: 6 });
      assert.match(text, /Uses \(up to 5 levels\): 2 of 12 nodes shown/);
      assert.match(text, /\.\.\. not shown: 2 nodes on level 2, 7 nodes on level 3, 1 nodes on level 4/);
      assert.match(text, /Used by \(up to 5 levels\): 2 nodes\n/);
      assert.match(text, /Cut to about 6 lines/);
    });
  });

  describe("the command line", () => {
    it("prints the cut listing and writes the full one with --out", () => {
      const file = join(out, "full.txt");
      const done = run("Root", "--down", "5", "--up", "5", "--max-lines", "6", "--hub", "3", "--out", file);
      assert.equal(done.status, 0, done.stderr);
      assert.match(done.stdout, /not shown: /);
      assert.ok(!/L1 {2}\[class\]/.test(done.stdout), "the leaves are not printed");
      assert.match(done.stdout, new RegExp(`full listing: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+ lines\\)`));
      const full = readFileSync(file, "utf8");
      assert.ok(leaves.every((leaf) => full.includes(`${leaf}  [class]`)), "the file has every node, hubs expanded");
      assert.ok(!full.includes("not shown"));
      assert.equal(full, `${run("Root", "--down", "5", "--up", "5", "--max-lines", "0", "--hub", "0").stdout}`, "the file is the output with no budget and no hub limit");
    });

    it("keeps JSON valid and puts the note about the file on stderr", () => {
      const file = join(out, "full.json");
      const done = run("Root", "--format", "json", "--max-lines", "6", "--out", file);
      const json = JSON.parse(done.stdout);
      assert.equal(json.cut.down.levels, 1);
      assert.ok(json.edges.length <= 6 + 2);
      assert.match(done.stderr, /full listing: /);
      assert.ok(JSON.parse(readFileSync(file, "utf8")).edges.length > json.edges.length);
    });

    it("walks 2 levels each way unless told otherwise", () => {
      const standard = run("Root");
      assert.match(standard.stdout, /Uses \(up to 2 levels\)/);
      assert.match(standard.stdout, /Used by \(up to 2 levels\)/);
      assert.match(run("Root", "--down", "4", "--up", "0").stdout, /Uses \(up to 4 levels\)[\s\S]*Used by \(up to 0 levels\)/);
    });

    it("starts from a hub to open it, and rejects a bad --max-lines", () => {
      const open = run("Hub", "--down", "1", "--hub", "3");
      assert.match(open.stdout, /Uses \(up to 1 levels\): 6 nodes/);
      const bad = run("Root", "--max-lines=-1");
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /--max-lines must be a whole number/);
    });
  });
});
