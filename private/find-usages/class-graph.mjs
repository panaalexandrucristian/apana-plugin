#!/usr/bin/env node
// class-graph: the dependency graph around one class or function of a project.
// What it uses (down), who uses it (up), each to a depth limit, with the file and
// lines of every use. Reads all .kt and .java files under the project root.
//
//   node private/find-usages/class-graph.mjs <File.kt | Name> [name] [options]
//
// A file path starts from its classes (or, with a name, from the declarations of
// that name in the file); anything else is a class or function name looked up in
// the whole project.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildGraph, clearGraphCache, fitWalk, GRAPH_LIMITS, walkGraph } from "./graph.mjs";
import { graphToJson, renderGraphMermaid, renderGraphText } from "./graph-render.mjs";

const USAGE = `usage: class-graph.mjs <File.kt | Name> [name] [options]
  --root <dir>      project root (default: nearest parent with .git, else the file's folder)
  --down <n>        levels of what it uses (default ${GRAPH_LIMITS.down})
  --up <n>          levels of who uses it (default ${GRAPH_LIMITS.up})
  --max-nodes <n>   stop a direction after n nodes (default: no limit)
  --max-lines <n>   print about n lines, whole levels only, nearest levels first (default ${GRAPH_LIMITS.maxLines}; 0 = all)
  --hub <n>         a node with more than n neighbours in the walk direction is listed but not
                    expanded (default ${GRAPH_LIMITS.hub}; 0 = expand all); start from it to open it
  --out <file>      also write the full listing (no cut, hubs expanded) to <file>, in --format
  --format <f>      text (default) | mermaid | json
  --no-cache        do not read or write the disk cache
  --rebuild         ignore the existing cache and write a fresh one
  --clear-cache     delete the cache of this project and options, then stop (waits for reads in progress)
  --cache-dir <dir> where the cache lives (default: $FIND_USAGES_CACHE_DIR, else ~/.cache/find-usages)
  --classes-only    leave top-level functions out of the graph
  --properties      add top-level properties as nodes
  --stats           print graph size and build time to stderr`;

class UsageError extends Error {}

function projectRoot(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

function rootsFor(graph, root, target, name) {
  const asPath = resolve(target);
  if (existsSync(asPath) && !existsSync(asPath + "/")) {
    const rel = relative(root, asPath);
    const inFile = [...graph.nodes.values()].filter((node) => node.path === rel);
    if (inFile.length === 0) throw new UsageError(`no class or function of ${rel} is in the graph (is the file under ${root}?)`);
    if (name) {
      const named = inFile.filter((node) => node.name === name);
      if (named.length === 0) throw new UsageError(`no declaration named "${name}" in ${rel}; declared here: ${[...new Set(inFile.map((n) => n.display))].slice(0, 40).join(", ")} (functions inside a class are not nodes: start from the class)`);
      return named.map((node) => node.id);
    }
    const classes = inFile.filter((node) => !node.owner && node.kind !== "function" && node.kind !== "property");
    return (classes.length > 0 ? classes : inFile.filter((node) => !node.owner)).map((node) => node.id);
  }
  const found = graph.byName.get(target) ?? [];
  if (found.length === 0) throw new UsageError(`"${target}" is neither a file nor a class or function name in the project`);
  if (found.length > 1) {
    throw new UsageError(`"${target}" is declared in ${found.length} places; pass the file instead:\n${found.map((node) => `  ${node.path}:${node.start}  [${node.kind}]`).join("\n")}`);
  }
  return [found[0].id];
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      down: { type: "string" },
      up: { type: "string" },
      "max-nodes": { type: "string" },
      "max-lines": { type: "string" },
      hub: { type: "string" },
      out: { type: "string" },
      format: { type: "string" },
      "no-cache": { type: "boolean" },
      rebuild: { type: "boolean" },
      "clear-cache": { type: "boolean" },
      "cache-dir": { type: "string" },
      "classes-only": { type: "boolean" },
      properties: { type: "boolean" },
      stats: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || (positionals.length < 1 && !values["clear-cache"]) || positionals.length > 2) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const number = (flag, fallback, min) => {
    if (values[flag] === undefined) return fallback;
    const value = Number(values[flag]);
    if (!Number.isInteger(value) || value < min) throw new UsageError(`--${flag} must be a whole number of at least ${min}`);
    return value;
  };
  const options = {
    down: number("down", GRAPH_LIMITS.down, 0),
    up: number("up", GRAPH_LIMITS.up, 0),
    maxNodes: number("max-nodes", Infinity, 1),
    maxLines: number("max-lines", GRAPH_LIMITS.maxLines, 0),
    hub: number("hub", GRAPH_LIMITS.hub, 0),
  };
  const format = values.format ?? "text";
  if (!["text", "mermaid", "json"].includes(format)) throw new UsageError("--format must be text, mermaid or json");
  const [target, name] = positionals;
  const root = resolve(values.root ?? projectRoot(target !== undefined && existsSync(target) ? dirname(resolve(target)) : process.cwd()));
  if (values["clear-cache"]) {
    const { path, removed } = await clearGraphCache(root, { classesOnly: values["classes-only"] === true, properties: values.properties === true, cache: { dir: values["cache-dir"] } });
    console.log(removed ? `cache cleared: ${path}` : `no cache to clear for ${root}`);
    return 0;
  }
  const graph = await buildGraph(root, {
    classesOnly: values["classes-only"] === true,
    properties: values.properties === true,
    cache: { enabled: values["no-cache"] !== true, rebuild: values.rebuild === true, dir: values["cache-dir"] },
  });
  const roots = rootsFor(graph, root, target, name);
  const render = (walked) => {
    if (format === "json") return JSON.stringify(graphToJson(graph, roots, walked));
    return format === "mermaid" ? renderGraphMermaid(graph, roots, walked) : renderGraphText(graph, roots, walked, options);
  };
  const walked = fitWalk(walkGraph(graph, roots, options), options.maxLines);
  console.log(render(walked));
  if (values.out) {
    const full = render(walkGraph(graph, roots, { ...options, hub: 0 }));
    try {
      writeFileSync(values.out, `${full}\n`);
    } catch (error) {
      throw new UsageError(`cannot write ${values.out}: ${error.message}`);
    }
    const note = `full listing: ${values.out} (${full.split("\n").length} lines)`;
    if (format === "text") console.log(note);
    else console.error(note);
  }
  if (values.stats) {
    const { files, nodes, edges, unresolved, ms, cache, changedFiles, removedFiles, rescanned } = graph.stats;
    console.error(`graph: ${files} files, ${nodes} nodes, ${edges} edges, ${unresolved} names left unresolved, ready in ${ms} ms, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
    console.error(`cache: ${cache} (${changedFiles} files changed, ${removedFiles} removed, ${rescanned} scanned again)`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof UsageError ? `class-graph: ${error.message}` : `class-graph failed: ${error?.stack ?? error}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
