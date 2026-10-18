// Output of the usage scan: a grouped text listing (one block per declared
// symbol, tiers in order) or the raw result as JSON.

// Listing order: the tiers from the surest to the least sure.
const SHOWN = Object.freeze(["certain", "likely", "ambiguous"]);

const plural = (count, word) => `${count} ${word}`;

function hidden(counts) {
  const parts = [];
  if (counts.decl > 0) parts.push(plural(counts.decl, "declaration"));
  if (counts.other > 0) parts.push(`${counts.other} of other symbols with the same name`);
  if (counts.noise > 0) parts.push(`${counts.noise} in comments or strings`);
  return parts;
}

/** Text listing of a findUsages() result. */
export function renderText(result) {
  const lines = [];
  const unused = [];
  for (const group of result.groups) {
    const shown = SHOWN.reduce((sum, tier) => sum + group.hits[tier].length, 0);
    if (shown === 0) {
      unused.push(group.owner ? `${group.owner}.${group.name}` : group.name);
      continue;
    }
    const owner = group.owner ? ` of ${group.owner}` : "";
    lines.push(`${group.name}  (${group.kind}${owner})  ${group.declPath}:${group.line}`);
    for (const tier of SHOWN) {
      const hits = group.hits[tier];
      if (hits.length === 0) continue;
      lines.push(`  ${tier} (${group.counts[tier]})`);
      for (const hit of hits) lines.push(`    ${hit.path}:${hit.line}:${hit.col}  [${hit.why}]  ${hit.text}`);
    }
    if (group.counts.truncated > 0) lines.push(`  ${group.counts.truncated} more hits not listed; raise --max-hits`);
    const skipped = hidden(group.counts);
    if (skipped.length > 0) lines.push(`  not listed: ${skipped.join(", ")}`);
    lines.push("");
  }
  if (unused.length > 0) lines.push(`no usages found: ${unused.join(", ")}`);
  return lines.join("\n");
}

/** One line with the size of the scan, for --stats. */
export function renderStats(result) {
  const { candidates, skipped, ms, rssMb } = result.stats;
  return `scanned ${candidates} files with a match (${skipped} too large, skipped) in ${ms} ms, rss ${rssMb} MB`;
}
