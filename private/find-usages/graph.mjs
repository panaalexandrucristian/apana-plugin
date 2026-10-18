// Dependency graph of a project's classes and top-level functions (Node stdlib
// only). Every Kotlin and Java file is read once: its declarations become nodes
// with a line range, and every name in code that resolves to another node (same
// file, explicit import, same package, wildcard import, qualified name) becomes
// an edge from the node whose range holds the line to the node it uses, with the
// line numbers of the uses. The graph is then walked from a node in both
// directions (what it uses, who uses it) up to a depth limit.
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { cachePath, clearCache, defaultCacheDir, loadCache, saveCache } from "./graph-cache.mjs";
import { parseHeader, parseJavaClasses, parseKotlin } from "./kotlin-symbols.mjs";
import { blankNoise } from "./lex.mjs";
import { candidateFiles, forEachPooled, projectFiles } from "./scan.mjs";

export const GRAPH_LIMITS = Object.freeze({ maxFileBytes: 2 * 1024 * 1024, pool: 8, maxLinesPerEdge: 50, down: 2, up: 2, maxNodes: Infinity, hub: 50, maxLines: 150 });

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
const DOTTED = /\.\s*$/;
const DECLARATION_BEFORE = /\b(?:fun|val|var)\s+(?:<[^>]*>\s*)?(?:[\w.<>?,*]+\.)?$/;
const CALL_AFTER = /^\s*[(<{]/;
const NAMED_ARGUMENT_BEFORE = /[(,]\s*$/;
const NAMED_ARGUMENT_AFTER = /^\s*=(?!=)/;
const RANK = { certain: 2, likely: 1 };

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fqnOf = (node) => (node.pkg ? `${node.pkg}.` : "") + (node.owner ? `${node.owner}.` : "") + node.name;

/** How `file` reaches the top-level `node` by name: "certain" | "likely" | null. */
function reachTop(file, node) {
  if (file.rel === node.path) return "certain";
  const imported = file.simple.get(node.name);
  if (imported !== undefined) return imported === fqnOf(node) ? "certain" : null; // another class with this name is imported
  if (file.pkg === node.pkg || file.stars.has(node.pkg)) return "likely";
  return null;
}

const ownerDotted = new Map();

/** Matcher for "Owner." (or "Owner?.") at the end of the text before a name, cached per owner. */
function afterOwner(owner) {
  if (!ownerDotted.has(owner)) ownerDotted.set(owner, new RegExp(`(?<![\\w$])${escapeRegExp(owner)}[?!]*\\s*\\.\\s*$`));
  return ownerDotted.get(owner);
}

// Whitespace as the regular expression class \s sees it.
const isSpace = (c) => c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
/** The last character before `end` and not before `floor` that is not whitespace (its code), or -1. */
function lastCodeBefore(text, end, floor) {
  let k = end - 1;
  while (k >= floor && isSpace(text.charCodeAt(k))) k -= 1;
  return k >= floor ? text.charCodeAt(k) : -1;
}
/** The index of the first character from `from` that is not whitespace, up to `limit` (the end of the line). */
function firstCodeFrom(text, from, limit) {
  let k = from;
  while (k < limit && isSpace(text.charCodeAt(k))) k += 1;
  return k;
}

const beforeOf = (tok) => (tok.before ??= tok.text.slice(tok.lineStart, tok.start));

/**
 * How a reference to `node` resolves in `file`, or null. The reference is the token
 * `tok` = {text, start, end, before}: `text` is the blanked line, [start, end) the
 * name; the text before it is cut only when a rule needs it (`before` caches it).
 */
function resolve(file, node, tok) {
  const { text, start, end, lineStart, lineEnd } = tok;
  const dotted = lastCodeBefore(text, start, lineStart) === 46;
  const classLike = node.kind === "class" || node.kind === "interface" || node.kind === "object";
  if (node.owner) {
    // Outer.Inner: the file must reach the outermost class, or import the nested class itself
    if (dotted) return afterOwner(node.owner).test(beforeOf(tok)) ? reachTop(file, node.top) : null;
    if (file.rel === node.path) return "certain";
    const imported = file.simple.get(node.name);
    if (imported !== undefined && imported.startsWith(`${node.pkg}.`) && imported.endsWith(`.${node.owner}.${node.name}`)) return "certain";
    return file.stars.has(`${node.pkg}.${node.owner}`) ? "likely" : null;
  }
  if (dotted) {
    if (node.pkg !== "" && text.endsWith(`${node.pkg}.`, start)) return "certain";
    // x.name(...) is a use only of an extension function the file can see
    return classLike || !node.receiver ? null : reachTop(file, node);
  }
  if (classLike) return reachTop(file, node);
  if (DECLARATION_BEFORE.test(beforeOf(tok))) return null;
  const previous = lastCodeBefore(text, start, lineStart);
  if (previous === 40 || previous === 44) {
    const eq = firstCodeFrom(text, end, lineEnd);
    if (text.charCodeAt(eq) === 61 && text.charCodeAt(eq + 1) !== 61) return null;
  }
  if (node.kind === "function") {
    const open = text.charCodeAt(firstCodeFrom(text, end, lineEnd));
    if (!(open === 40 || open === 60 || open === 123) && !(start >= 2 && text.charCodeAt(start - 1) === 58 && text.charCodeAt(start - 2) === 58)) return null;
  }
  if (file.memberNames.has(node.name) && file.rel !== node.path) return null; // a member of this file's classes shadows it
  return reachTop(file, node);
}

const TIER_CODE = { certain: 2, likely: 1 };
const TIER_NAME = { 2: "certain", 1: "likely" };
const MAX_RESCAN_BY_NAME = 3000;

/** Read and parse one file into a record (signature, declarations, imports); edges come later. Null for a file that is too large. */
async function parseRecord(root, rel, sig, options) {
  const abs = join(root, rel);
  const raw = await readFile(abs, "utf8");
  const kotlin = extname(rel) === ".kt";
  const blanked = blankNoise(raw, { templates: kotlin });
  const found = [];
  let shape;
  if (kotlin) {
    shape = parseKotlin(raw, { blanked });
    for (const cls of shape.classes) found.push({ name: cls.name, owner: cls.owner, kind: cls.kind, start: cls.start, end: cls.end, receiver: null });
    for (const item of shape.topLevel) {
      if (item.kind === "property" && !options.properties) continue;
      if (options.classesOnly) continue;
      found.push({ name: item.name, owner: null, kind: item.kind, start: item.start, end: item.end, receiver: item.receiver });
    }
  } else {
    shape = { ...parseHeader(blanked), symbols: [] };
    for (const cls of parseJavaClasses(blanked)) found.push({ name: cls.name, owner: cls.owner, kind: "class", start: cls.start, end: cls.end, receiver: null });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const inside = (outer, node) => outer !== node && outer.name === node.owner && outer.start <= node.start && node.end <= outer.end;
  const nodes = found.map((node) => {
    const container = node.owner ? found.filter((other) => inside(other, node)).sort((a, b) => a.end - a.start - (b.end - b.start))[0] : undefined;
    return { ...node, container: container ? found.indexOf(container) : null };
  });
  // A substring of 13 or more characters is a slice that keeps the whole file text alive; the record is kept for the whole run, so copy what it holds.
  const detach = (text) => (typeof text === "string" ? ` ${text}`.slice(1) : text);
  return {
    rel,
    sig,
    pkg: detach(shape.pkg),
    imports: shape.imports.map((i) => ({ fqn: detach(i.fqn), alias: detach(i.alias), star: i.star })),
    memberNames: [...new Set(shape.symbols.filter((s) => s.owner !== null).map((s) => detach(s.name)))],
    nodes: nodes.map((node) => ({ ...node, name: detach(node.name), owner: detach(node.owner), receiver: detach(node.receiver) })),
    edges: [],
    unresolved: 0,
  };
}

/** Nodes of a record as objects with ids, paths and links to their container and outermost class. */
function hydrate(record) {
  const seen = new Set();
  const nodes = record.nodes.map((node, index) => {
    const display = node.owner ? `${node.owner}.${node.name}` : node.name;
    const base = `${record.rel}#${display}`;
    const id = seen.has(base) ? `${base}@${node.start}` : base;
    seen.add(base);
    return { ...node, display, id, index, path: record.rel, pkg: record.pkg, top: null };
  });
  for (const node of nodes) {
    let top = node;
    for (let step = 0; top.container !== null && step < 20; step++) top = nodes[top.container];
    node.top = top;
  }
  return nodes;
}

/** What the reference pass needs to know about a file besides its nodes. */
function fileFacts(record, nodes) {
  return {
    rel: record.rel,
    pkg: record.pkg,
    own: nodes,
    simple: new Map(record.imports.filter((i) => !i.star && !i.alias).map((i) => [i.fqn.slice(i.fqn.lastIndexOf(".") + 1), i.fqn])),
    stars: new Set(record.imports.filter((i) => i.star).map((i) => i.fqn.replace(/\.?\*$/, ""))),
    memberNames: new Set(record.memberNames),
  };
}

/** The innermost node whose range holds `line`. */
function holder(own, line) {
  let best = null;
  for (const node of own) {
    if (node.start > line || line > node.end) continue;
    if (!best || node.end - node.start < best.end - best.start || (node.end - node.start === best.end - best.start && node.start > best.start)) best = node;
  }
  return best;
}

/** True for an import or package line (the text of [from, to) starts with the keyword and a space). */
function headerLine(text, from, to) {
  const k = firstCodeFrom(text, from, to);
  if (text.startsWith("import", k)) return k + 6 < to && isSpace(text.charCodeAt(k + 6));
  if (text.startsWith("package", k)) return k + 7 < to && isSpace(text.charCodeAt(k + 7));
  return false;
}

/** Edges of one file: [fromIndex, toId, tierCode, count, lines], and how many names found no node. */
async function scanFile(root, facts, byName) {
  const text = blankNoise(await readFile(join(root, facts.rel), "utf8"), { templates: extname(facts.rel) === ".kt" });
  const length = text.length;
  const edges = new Map();
  let unresolved = 0;
  // The text is read in place, line by line, without cutting it into one string per line.
  const tok = { text, start: 0, end: 0, lineStart: 0, lineEnd: 0, before: null };
  let n = 1; // 1-based number of the line that holds the token
  let lineStart = 0;
  let lineEnd = text.indexOf("\n");
  if (lineEnd < 0) lineEnd = length;
  let skip = headerLine(text, lineStart, lineEnd);
  IDENTIFIER.lastIndex = 0;
  for (let match = IDENTIFIER.exec(text); match; match = IDENTIFIER.exec(text)) {
    const start = match.index;
    if (start > lineEnd) {
      do {
        n += 1;
        lineStart = lineEnd + 1;
        lineEnd = text.indexOf("\n", lineStart);
        if (lineEnd < 0) lineEnd = length;
      } while (start > lineEnd);
      skip = headerLine(text, lineStart, lineEnd);
    }
    if (skip) {
      IDENTIFIER.lastIndex = lineEnd + 1;
      continue;
    }
    {
      const candidates = byName.get(match[0]);
      if (!candidates) continue;
      tok.start = start;
      tok.end = start + match[0].length;
      tok.lineStart = lineStart;
      tok.lineEnd = lineEnd;
      tok.before = null;
      let best = [];
      let bestRank = 0;
      for (const node of candidates) {
        const tier = resolve(facts, node, tok);
        if (!tier) continue;
        if (RANK[tier] > bestRank) {
          best = [node];
          bestRank = RANK[tier];
        } else if (RANK[tier] === bestRank) best.push(node);
      }
      if (best.length === 0) {
        unresolved += 1;
        continue;
      }
      const from = holder(facts.own, n);
      if (!from) continue;
      const tier = best.length > 1 ? "likely" : bestRank === 2 ? "certain" : "likely";
      for (const to of best) {
        if (to === from) continue;
        const key = `${from.index}>${to.id}`;
        let edge = edges.get(key);
        if (!edge) {
          edge = [from.index, to.id, TIER_CODE[tier], 0, []];
          edges.set(key, edge);
        }
        edge[3] += 1;
        edge[2] = Math.max(edge[2], TIER_CODE[tier]);
        if (edge[4].length < GRAPH_LIMITS.maxLinesPerEdge && edge[4][edge[4].length - 1] !== n) edge[4].push(n);
      }
    }
  }
  return { edges: [...edges.values()], unresolved };
}

const declarationKeys = (record) => new Map(hydrate(record).map((node) => [`${node.id}|${node.kind}|${node.receiver ?? ""}|${node.pkg}|${node.top.id}`, node.name]));

const graphOptionsOf = (options) => ({ classesOnly: options.classesOnly === true, properties: options.properties === true });

/** Remove the cache file buildGraph would use for these options ({classesOnly, properties, cache: {dir, lock}}): {path, removed}. Waits for reads in progress. */
export async function clearGraphCache(root, options = {}) {
  const { cache = {} } = options;
  const path = cachePath(cache.dir ?? defaultCacheDir(), root, graphOptionsOf(options));
  return { path, removed: await clearCache(path, cache.lock) };
}

/**
 * {nodes, byName, out, inn, stats}: nodes by id; out/inn map a node id to a Map
 * of the other node id to the edge {from, to, lines, count, tier}. Options:
 * classesOnly (no function nodes), properties (top-level properties as nodes
 * too), cache ({dir, enabled, rebuild, lock}: a disk cache that is brought up to
 * date from the files that changed since it was written, never trusted blindly;
 * `lock` overrides the lock timings of cache-lock.mjs).
 */
export async function buildGraph(root, options = {}) {
  const started = performance.now();
  const { cache = {}, ...kept } = options;
  const graphOptions = graphOptionsOf(kept);
  const useCache = cache.enabled !== false;
  const path = cachePath(cache.dir ?? defaultCacheDir(), root, graphOptions);
  let cached = useCache && !cache.rebuild ? await loadCache(path, root, graphOptions, cache.lock) : null;
  const cacheState = !useCache ? "off" : cached ? "update" : "miss";
  if (!cached) cached = new Map();

  // Which files exist now, and which differ from the cache.
  const rels = await projectFiles(root, ["*.kt", "*.java"]);
  const sigs = new Map();
  for (const rel of rels) {
    const info = statSync(join(root, rel));
    if (info.size <= GRAPH_LIMITS.maxFileBytes) sigs.set(rel, `${info.mtimeMs}:${info.size}`);
  }
  const records = new Map();
  const changed = [];
  for (const [rel, sig] of sigs) {
    const old = cached.get(rel);
    if (old && old.sig === sig) records.set(rel, old);
    else changed.push(rel);
  }
  const removed = [...cached.keys()].filter((rel) => !sigs.has(rel));

  // Re-read the changed files and find the names whose declarations differ.
  const affected = new Set();
  await forEachPooled(changed, GRAPH_LIMITS.pool, async (rel) => {
    const record = await parseRecord(root, rel, sigs.get(rel), graphOptions);
    const before = cached.has(rel) ? declarationKeys(cached.get(rel)) : new Map();
    const after = declarationKeys(record);
    for (const [key, name] of before) if (!after.has(key)) affected.add(name);
    for (const [key, name] of after) if (!before.has(key)) affected.add(name);
    records.set(rel, record);
  });
  for (const rel of removed) for (const name of declarationKeys(cached.get(rel)).values()) affected.add(name);

  // Global lookup tables, then the reference pass for every file it can have changed.
  const hydrated = new Map();
  const byName = new Map();
  for (const [rel, record] of records) {
    const nodes = hydrate(record);
    hydrated.set(rel, nodes);
    for (const node of nodes) byName.set(node.name, [...(byName.get(node.name) ?? []), node]);
  }
  const stale = new Set(changed);
  if (affected.size > MAX_RESCAN_BY_NAME) for (const rel of records.keys()) stale.add(rel);
  else if (affected.size > 0) for (const rel of await candidateFiles(root, [...affected], { globs: ["*.kt", "*.java"] })) if (records.has(rel)) stale.add(rel);
  await forEachPooled([...stale], GRAPH_LIMITS.pool, async (rel) => {
    const record = records.get(rel);
    const scanned = await scanFile(root, fileFacts(record, hydrated.get(rel)), byName);
    record.edges = scanned.edges;
    record.unresolved = scanned.unresolved;
  });

  const graph = assemble(records, hydrated, byName);
  if (graph.dangling > 0 && cacheState === "update") return buildGraph(root, { ...options, cache: { ...cache, rebuild: true } }); // the cache disagreed with the files: start over
  if (useCache && (stale.size > 0 || removed.length > 0 || cacheState === "miss")) await saveCache(path, root, graphOptions, records, cache.lock);
  const state = cacheState === "update" && stale.size === 0 && removed.length === 0 ? "hit" : cacheState === "update" ? "updated" : cacheState;
  graph.stats = { ...graph.stats, cache: state, changedFiles: changed.length, removedFiles: removed.length, rescanned: stale.size, ms: Math.round(performance.now() - started) };
  return graph;
}

/**
 * The edges of the graph in flat typed arrays (the node and edge numbers are indexes), with two
 * compressed-sparse-row views of them: by source node (out) and by target node (inn). Edge objects
 * and neighbour maps exist only for the nodes a walk opens.
 */
class EdgeTable {
  constructor(ids, ixOf, from, to, tier, count, lineStart, lineLength, lines) {
    this.ids = ids;
    this.ixOf = ixOf;
    this.from = from;
    this.to = to;
    this.tier = tier;
    this.count = count;
    this.lineStart = lineStart;
    this.lineLength = lineLength;
    this.lines = lines;
    this.out = this.csr(from);
    this.inn = this.csr(to);
  }

  /** {start, edges}: the edge numbers grouped by node (edges of node i are edges[start[i] .. start[i + 1])). */
  csr(by) {
    const start = new Uint32Array(this.ids.length + 1);
    for (let e = 0; e < by.length; e++) start[by[e] + 1] += 1;
    for (let i = 0; i < this.ids.length; i++) start[i + 1] += start[i];
    const cursor = start.slice(0, this.ids.length);
    const edges = new Uint32Array(by.length);
    for (let e = 0; e < by.length; e++) edges[cursor[by[e]]++] = e;
    return { start, edges };
  }

  edge(e) {
    const begin = this.lineStart[e];
    return { from: this.ids[this.from[e]], to: this.ids[this.to[e]], lines: Array.from(this.lines.subarray(begin, begin + this.lineLength[e])), count: this.count[e], tier: TIER_NAME[this.tier[e]] };
  }
}

/** Neighbours of a node in one direction as a Map of the other node id to the edge, built on demand; undefined for a node with none. */
class Neighbours {
  constructor(table, view, otherIsTarget) {
    this.table = table;
    this.view = view;
    this.otherIsTarget = otherIsTarget;
  }

  get(id) {
    const { table, view } = this;
    const i = table.ixOf.get(id);
    if (i === undefined || view.start[i] === view.start[i + 1]) return undefined;
    const around = new Map();
    for (let k = view.start[i]; k < view.start[i + 1]; k++) {
      const edge = table.edge(view.edges[k]);
      around.set(this.otherIsTarget ? edge.to : edge.from, edge);
    }
    return around;
  }

  has(id) {
    const i = this.table.ixOf.get(id);
    return i !== undefined && this.view.start[i] !== this.view.start[i + 1];
  }

  /** Ids of the nodes that have neighbours in this direction. */
  *keys() {
    const { ids } = this.table;
    const { start } = this.view;
    for (let i = 0; i < ids.length; i++) if (start[i] !== start[i + 1]) yield ids[i];
  }

  *entries() {
    for (const id of this.keys()) yield [id, this.get(id)];
  }

  *values() {
    for (const id of this.keys()) yield this.get(id);
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  get size() {
    let n = 0;
    for (const _ of this.keys()) n += 1;
    return n;
  }
}

/** Join the per-file nodes and edges into the graph that walkGraph reads. */
function assemble(records, hydrated, byName) {
  const byId = new Map();
  const ixOf = new Map();
  const ids = [];
  for (const nodes of hydrated.values()) {
    for (const node of nodes) {
      byId.set(node.id, node);
      ixOf.set(node.id, ids.length);
      ids.push(node.id);
    }
  }
  let upper = 0;
  let lineTotal = 0;
  for (const record of records.values()) {
    upper += record.edges.length;
    for (const edge of record.edges) lineTotal += edge[4].length;
  }
  const from = new Uint32Array(upper);
  const to = new Uint32Array(upper);
  const tier = new Uint8Array(upper);
  const count = new Uint32Array(upper);
  const lineStart = new Uint32Array(upper);
  const lineLength = new Uint8Array(upper);
  const lines = new Uint32Array(lineTotal);
  let edgeCount = 0;
  let linesUsed = 0;
  let unresolved = 0;
  let dangling = 0;
  for (const [rel, record] of records) {
    unresolved += record.unresolved;
    const nodes = hydrated.get(rel);
    for (const [fromIndex, toId, edgeTier, edgeCountValue, edgeLines] of record.edges) {
      const target = ixOf.get(toId);
      if (target === undefined) {
        dangling += 1;
        continue;
      }
      from[edgeCount] = ixOf.get(nodes[fromIndex].id);
      to[edgeCount] = target;
      tier[edgeCount] = edgeTier;
      count[edgeCount] = edgeCountValue;
      lineStart[edgeCount] = linesUsed;
      lineLength[edgeCount] = edgeLines.length;
      for (const line of edgeLines) lines[linesUsed++] = line;
      edgeCount += 1;
    }
  }
  const table = new EdgeTable(ids, ixOf, from.subarray(0, edgeCount), to.subarray(0, edgeCount), tier, count, lineStart, lineLength, lines);
  return { nodes: byId, byName, out: new Neighbours(table, table.out, true), inn: new Neighbours(table, table.inn, false), dangling, stats: { files: records.size, nodes: byId.size, edges: edgeCount, unresolved } };
}

/**
 * Walk the graph from `roots` (node ids) down (what they use) and up (who uses
 * them), at most `down`/`up` hops, stopping at `maxNodes` nodes per direction.
 * Returns {down, up}, each {depth, edges, hops, hubs, truncated, otherEnd}:
 * depth maps a node id to its level (roots 0), edges are the edges crossed and
 * hops[i] is the level of edges[i], otherEnd names the end of an edge that is the
 * node reached ("to" going down, "from" going up). A node that is not a root and
 * has more than `hub` neighbours in the direction of the walk is a hub: it is
 * listed but not walked through, and `hubs` maps its id to the neighbour count
 * (0 turns this off).
 */
export function walkGraph(graph, roots, { down = GRAPH_LIMITS.down, up = GRAPH_LIMITS.up, maxNodes = GRAPH_LIMITS.maxNodes, hub = 0 } = {}) {
  const walk = (neighbours, limit, otherEnd) => {
    const depth = new Map(roots.map((id) => [id, 0]));
    const edges = [];
    const hops = [];
    const hubs = new Map();
    let truncated = false;
    let frontier = [...roots];
    for (let hop = 1; hop <= limit && frontier.length > 0; hop++) {
      const next = [];
      for (const id of frontier) {
        const all = neighbours.get(id);
        if (hub > 0 && hop > 1 && all && all.size > hub) {
          hubs.set(id, all.size);
          continue;
        }
        const around = [...(all ?? [])].sort((a, b) => {
          const x = graph.nodes.get(a[0]);
          const y = graph.nodes.get(b[0]);
          return x.display < y.display ? -1 : x.display > y.display ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
        });
        for (const [other, edge] of around) {
          if (!depth.has(other)) {
            if (depth.size >= maxNodes) {
              truncated = true;
              continue;
            }
            depth.set(other, hop);
            next.push(other);
          }
          edges.push(edge);
          hops.push(hop);
        }
      }
      frontier = next;
    }
    return { depth, edges, hops, hubs, truncated, otherEnd };
  };
  return { down: walk(graph.out, down, "to"), up: walk(graph.inn, up, "from") };
}

/**
 * Trim a walk to about `budget` printed lines (one line per edge in the text
 * listing), in whole levels: each direction keeps the deepest level that fits in
 * its half of the budget, and the direction that needs less leaves the rest to the
 * other. When level 1 alone is larger than the room, its first edges are kept.
 * A trimmed direction gets `cut`: {levels, partial, total: {nodes, edges},
 * hidden: [{level, nodes, edges}]}; an untouched one gets `cut: null`. A budget of
 * 0 or Infinity returns the walk as it is.
 */
export function fitWalk(walked, budget) {
  if (!(budget > 0) || budget === Infinity) return walked;
  const count = (values) => {
    const per = [];
    for (const level of values) if (level > 0) per[level] = (per[level] ?? 0) + 1;
    return per;
  };
  const levelsOf = (result) => ({ edges: count(result.hops), nodes: count(result.depth.values()) });
  const fit = (edges, room) => {
    let used = 0;
    let levels = 0;
    for (let level = 1; level < edges.length && used + (edges[level] ?? 0) <= room; level++) {
      used += edges[level] ?? 0;
      levels = level;
    }
    return { levels, used };
  };
  const per = { down: levelsOf(walked.down), up: levelsOf(walked.up) };
  const half = Math.floor(budget / 2);
  const fits = { down: fit(per.down.edges, half), up: fit(per.up.edges, half) };
  const [small, large] = fits.down.used <= fits.up.used ? ["down", "up"] : ["up", "down"];
  const room = { [small]: half, [large]: budget - fits[small].used };
  fits[large] = fit(per[large].edges, room[large]);

  const trim = (direction) => {
    const result = walked[direction];
    const { edges: edgeCount, nodes: nodeCount } = per[direction];
    const { levels } = fits[direction];
    const partial = levels === 0 && (edgeCount[1] ?? 0) > room[direction];
    if (!partial && levels >= edgeCount.length - 1) return { ...result, cut: null };
    const edges = [];
    const hops = [];
    for (let i = 0; i < result.edges.length; i++) {
      if (result.hops[i] <= levels || (partial && result.hops[i] === 1 && edges.length < room[direction])) {
        edges.push(result.edges[i]);
        hops.push(result.hops[i]);
      }
    }
    const reached = new Set(edges.map((edge) => edge[result.otherEnd]));
    const depth = new Map([...result.depth].filter(([id, level]) => level === 0 || reached.has(id)));
    const shownNodes = count(depth.values());
    const shownEdges = count(hops);
    const hidden = [];
    for (let level = 1; level < Math.max(edgeCount.length, nodeCount.length); level++) {
      const nodes = (nodeCount[level] ?? 0) - (shownNodes[level] ?? 0);
      const lost = (edgeCount[level] ?? 0) - (shownEdges[level] ?? 0);
      if (nodes > 0 || lost > 0) hidden.push({ level, nodes, edges: lost });
    }
    const hubs = new Map([...result.hubs].filter(([id]) => depth.has(id)));
    const total = { nodes: nodeCount.reduce((sum, n) => sum + (n ?? 0), 0), edges: result.edges.length };
    return { ...result, depth, edges, hops, hubs, cut: { levels, partial, total, hidden } };
  };
  return { down: trim("down"), up: trim("up") };
}
