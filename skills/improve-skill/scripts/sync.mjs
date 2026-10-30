// Merges the digests of all laptops into a summary; with --publish also pushes this laptop's digest to the private repo (opt-in).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, machineFile } from './extract.mjs';
import { scanRedaction } from './report.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Local digests plus the ones other laptops published into the clone of the private repo.
export function loadDigests(out) {
  const dirs = [out, join(out, 'repo', 'machines')];
  const recs = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/^machine-.*\.jsonl$/.test(f)) for (const r of readJsonl(join(d, f))) recs.push({ ...r, laptop: f.slice(8, -6) });
  }
  const byId = new Map();
  for (const r of recs) byId.set(r.id, r);
  return [...byId.values()];
}

export function summarize(recs) {
  const skills = {};
  let unknown = 0;
  for (const r of recs) {
    const s = (skills[r.skill] ??= { invocations: 0, laptops: new Set(), triggers: {}, signals: {}, plugin_versions: new Set(), skill_hashes: new Set() });
    s.invocations++;
    s.laptops.add(r.laptop);
    s.triggers[r.trigger] = (s.triggers[r.trigger] ?? 0) + 1;
    for (const g of r.signals ?? []) s.signals[g] = (s.signals[g] ?? 0) + 1;
    s.plugin_versions.add(r.plugin_version);
    s.skill_hashes.add(r.skill_hash);
    if (Object.values(r).some((v) => typeof v === 'string' && v.startsWith('unknown'))) unknown++;
  }
  const flat = Object.fromEntries(Object.entries(skills).map(([k, s]) => [k, { ...s, laptops: s.laptops.size, plugin_versions: [...s.plugin_versions], skill_hashes: [...s.skill_hashes] }]));
  return { label: 'measured', n: recs.length, records_with_unknown_fields: unknown, skills: flat };
}

export function publish({ out, cfg }) {
  if (cfg.publish !== true || !cfg.repo) throw new Error('publishing is off on this laptop: set "publish": true and "repo" in config.json yourself');
  const file = join(out, machineFile(cfg));
  if (!existsSync(file)) throw new Error('no digest to publish; run extract.mjs first');
  const text = readFileSync(file, 'utf8');
  const findings = scanRedaction(text, { managed: cfg.laptop_class === 'gestionat' });
  if (findings.length) throw new Error(`redaction scan refused the digest: ${findings.map((f) => f.kind).join(', ')}`);
  const clone = join(out, 'repo');
  if (!existsSync(join(clone, '.git'))) git(out, 'clone', '--quiet', cfg.repo, 'repo');
  else { try { git(clone, 'pull', '--quiet', '--rebase'); } catch { /* a push below reports the real problem */ } }
  mkdirSync(join(clone, 'machines'), { recursive: true });
  copyFileSync(file, join(clone, 'machines', machineFile(cfg)));
  git(clone, 'add', 'machines');
  if (!git(clone, 'status', '--porcelain').trim()) return 'nothing new to publish';
  git(clone, 'commit', '--quiet', '-m', 'digest: update laptop digest');
  git(clone, 'push', '--quiet');
  return 'published';
}

function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, publish: { type: 'boolean' } } });
  const out = values.out ?? join(homedir(), '.claude/skill-reports');
  const cfg = loadConfig(out);
  const recs = loadDigests(out);
  const summary = summarize(recs);
  writeFileSync(join(out, 'merged.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`merged ${summary.n} records (${summary.records_with_unknown_fields} with unknown fields) into ${join(out, 'merged.json')}`);
  if (values.publish) {
    try { console.log(publish({ out, cfg })); }
    catch (e) { console.error(`publish failed, digest stays local (tier 0): ${(e.stderr || e.message).toString().trim()}`); process.exit(3); }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
