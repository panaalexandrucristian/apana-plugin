// Output of the dependency graph: an indented text tree per direction, a Mermaid
// diagram, or JSON. An edge always points from the user to the used node, and its
// lines are lines of the user's file.
import { basename } from "node:path";

const mark = (edge) => (edge.tier === "likely" ? "~" : "");
const place = (node) => `${node.path}:${node.start}`;

function usedAt(graph, edge, linesShown = 5) {
  const shown = edge.lines.slice(0, linesShown);
  const more = edge.count > shown.length ? ` (+${edge.count - shown.length})` : "";
  return `${basename(graph.nodes.get(edge.from).path)}:${shown.join(", ")}${more}`;
}

function tree(graph, result, roots, direction) {
  const lines = [];
  const children = new Map();
  for (const edge of result.edges) {
    const key = direction === "down" ? edge.from : edge.to;
    children.set(key, [...(children.get(key) ?? []), edge]);
  }
  const shown = new Set(roots);
  const visit = (id, indent) => {
    for (const edge of children.get(id) ?? []) {
      const otherId = direction === "down" ? edge.to : edge.from;
      const node = graph.nodes.get(otherId);
      const again = shown.has(otherId);
      const hub = result.hubs?.get(otherId);
      const note = again ? "  (shown above)" : hub ? `  (hub: ${direction === "down" ? "uses" : "used by"} ${hub}, not expanded)` : "";
      lines.push(`${indent}${mark(edge)}${node.display}  [${node.kind}]${again ? "" : `  ${place(node)}`}  <- ${usedAt(graph, edge)}${note}`);
      if (!again) {
        shown.add(otherId);
        visit(otherId, `${indent}  `);
      }
    }
  };
  for (const root of roots) visit(root, "  ");
  return lines;
}

/**
 * Text report of a walk for the root nodes. `options`: down, up, maxNodes (as
 * given to the walk), maxLines and hub (for the notes at the end).
 */
export function renderGraphText(graph, roots, walked, options) {
  const out = [];
  for (const id of roots) {
    const node = graph.nodes.get(id);
    out.push(`${node.display}  [${node.kind}]  ${place(node)}-${node.end}`);
  }
  const section = (title, result, direction, limit) => {
    const lines = tree(graph, result, roots, direction);
    const shown = result.depth.size - roots.length;
    const count = result.cut ? `${shown} of ${result.cut.total.nodes} nodes shown` : `${shown} nodes`;
    out.push("", `${title} (up to ${limit} levels): ${count}${result.truncated ? `, stopped at ${options.maxNodes} nodes` : ""}`);
    out.push(...(lines.length > 0 ? lines : ["  none"]));
    if (result.cut) out.push(`  ... not shown: ${result.cut.hidden.map((h) => `${h.nodes} nodes on level ${h.level}`).join(", ")}`);
  };
  section("Uses", walked.down, "down", options.down);
  section("Used by", walked.up, "up", options.up);
  out.push("", "<- file:lines of the node that uses the other one, (+n) = more uses; ~ = less sure (same package, wildcard import or several candidates)");
  if (walked.down.cut || walked.up.cut) out.push(`Cut to about ${options.maxLines} lines: --max-lines <n> shows more (0 = all), --out <file> writes the full listing, or start from one of the nodes above.`);
  if (walked.down.hubs?.size > 0 || walked.up.hubs?.size > 0) out.push(`Hub = more than ${options.hub} neighbours in that direction: listed, not expanded. Start from it to open it, or use --hub 0 to expand all.`);
  return out.join("\n");
}

/** Mermaid flowchart of both directions: A --> X --> Y, user to used. */
export function renderGraphMermaid(graph, roots, walked) {
  const edges = new Map();
  for (const edge of [...walked.down.edges, ...walked.up.edges]) edges.set(`${edge.from}>${edge.to}`, edge);
  const ids = new Map();
  const idOf = (id) => {
    if (!ids.has(id)) ids.set(id, `n${ids.size}`);
    return ids.get(id);
  };
  const lines = ["graph LR"];
  for (const root of roots) idOf(root);
  for (const edge of edges.values()) {
    idOf(edge.from);
    idOf(edge.to);
  }
  const hubs = new Set([...walked.down.hubs.keys(), ...walked.up.hubs.keys()]);
  for (const [id, short] of ids) {
    const node = graph.nodes.get(id);
    lines.push(`  ${short}["${node.display.replace(/"/g, "'")}<br/>${node.kind}${hubs.has(id) ? ", hub, not expanded" : ""}"]`);
  }
  for (const edge of edges.values()) {
    const label = `${basename(graph.nodes.get(edge.from).path)}:${edge.lines.slice(0, 3).join(",")}${edge.count > 3 ? "..." : ""}`;
    lines.push(`  ${idOf(edge.from)} ${edge.tier === "likely" ? "-.->" : "-->"}|"${label}"| ${idOf(edge.to)}`);
  }
  lines.push("  classDef root fill:#fde68a,stroke:#b45309,stroke-width:2px;");
  lines.push(`  class ${roots.map(idOf).join(",")} root;`);
  return lines.join("\n");
}

/** JSON-ready object of the walk. */
export function graphToJson(graph, roots, walked) {
  const nodeIds = new Set(roots);
  const edges = new Map();
  for (const edge of [...walked.down.edges, ...walked.up.edges]) {
    nodeIds.add(edge.from);
    nodeIds.add(edge.to);
    edges.set(`${edge.from}>${edge.to}`, edge);
  }
  return {
    roots,
    nodes: [...nodeIds].map((id) => {
      const { name, owner, kind, path, start, end } = graph.nodes.get(id);
      return { id, name, owner, kind, path, start, end };
    }),
    edges: [...edges.values()],
    truncated: { down: walked.down.truncated, up: walked.up.truncated },
    cut: { down: walked.down.cut ?? null, up: walked.up.cut ?? null },
    hubs: { down: Object.fromEntries(walked.down.hubs), up: Object.fromEntries(walked.up.hubs) },
    stats: graph.stats,
  };
}
