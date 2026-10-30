// Deterministic checks for improve-skill reports: validate against the template, dedup across laptops, scan for text that must not be published.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

export const REQUIRED = ['kind', 'skill', 'plugin_version', 'cc_version', 'skill_hash', 'improve_skill_version', 'severity', 'trigger', 'evidence', 'expected', 'actual', 'proposed_change', 'laptop_class', 'status'];
export const ENUMS = {
  kind: ['improvement', 'bug'],
  severity: ['blocker', 'major', 'minor'],
  trigger: ['user-slash', 'claude-proactive'],
  laptop_class: ['personal', 'gestionat'],
  status: ['open', 'accepted', 'rejected', 'done'],
};
export const LABELS = ['measured', 'calculated', 'guessed'];
const VERSION_FIELDS = ['plugin_version', 'cc_version', 'skill_hash', 'improve_skill_version'];

// A version that could not be determined is written `unknown: <reason>`, never omitted.
const versionOk = (v) => typeof v === 'string' && v.length > 0 && (!v.startsWith('unknown') || /^unknown: \S/.test(v));

export function validateReport(r, digestIds = null) {
  const errors = [];
  for (const f of REQUIRED) if (r[f] === undefined || r[f] === '') errors.push(`missing ${f}`);
  for (const [f, allowed] of Object.entries(ENUMS)) {
    if (r[f] !== undefined && !allowed.includes(r[f])) errors.push(`${f} must be one of ${allowed.join('/')}`);
  }
  for (const f of VERSION_FIELDS) if (r[f] !== undefined && !versionOk(r[f])) errors.push(`${f} must be a value or "unknown: <reason>"`);
  const ev = r.evidence;
  if (ev && typeof ev === 'object') {
    if (!Array.isArray(ev.records) || ev.records.length === 0) errors.push('evidence.records must list digest record ids');
    else if (digestIds) for (const id of ev.records) if (!digestIds.has(id)) errors.push(`evidence record ${id} is not in the digest`);
    for (const c of ev.counts ?? []) {
      if (!LABELS.includes(c.label)) errors.push(`count "${c.name}" needs a label (${LABELS.join('/')})`);
      if (!Number.isInteger(c.n) || c.n < 0) errors.push(`count "${c.name}" needs n`);
    }
  } else if (ev !== undefined) errors.push('evidence must be an object');
  return errors;
}

export function fingerprint(r) {
  const signal = String(r.signal ?? r.actual ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${r.skill}|${r.kind}|${signal}`).digest('hex').slice(0, 16);
}

const addUnique = (list, v) => { if (v !== undefined && !list.includes(v)) list.push(v); };

// Reports with the same fingerprint (no version in it) become one with counts of laptops and occurrences.
export function dedupReports(reports) {
  const byFp = new Map();
  for (const r of reports) {
    const fp = fingerprint(r);
    const g = byFp.get(fp) ?? { ...r, fingerprint: fp, laptops: [], occurrences: 0, versions: [], skill_hashes: [] };
    addUnique(g.laptops, r.laptop);
    g.occurrences += r.evidence?.records?.length ?? 1;
    addUnique(g.versions, r.plugin_version);
    addUnique(g.skill_hashes, r.skill_hash);
    byFp.set(fp, g);
  }
  return [...byFp.values()].map((g) => ({ ...g, laptop_count: g.laptops.length }));
}

const PATTERNS = [
  ['absolute path', /(?:\/Users|\/home|\/private\/var|\/var\/folders)\/[^\s"'`]+/],
  ['absolute path', /\b[A-Za-z]:\\Users\\[^\s"'`]+/],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['token', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/],
  ['token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
];

// Returns findings for text that must not leave the laptop. On a managed laptop a `quote` field also blocks.
export function scanRedaction(text, { managed = false } = {}) {
  const findings = [];
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) findings.push({ kind, match: m[0].slice(0, 24) });
  }
  if (managed && /"quote"\s*:/.test(text)) findings.push({ kind: 'transcript text', match: '"quote"' });
  return findings;
}

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { digest: { type: 'string', multiple: true }, managed: { type: 'boolean' } } });
  const [cmd, file] = positionals;
  if (!file) { console.error('usage: report.mjs validate|dedup|scan <file> [--digest f]... [--managed]'); process.exit(2); }
  if (cmd === 'validate') {
    const ids = values.digest ? new Set(values.digest.flatMap((d) => readJsonl(d).map((r) => r.id))) : null;
    let bad = 0;
    readJsonl(file).forEach((r, i) => { const e = validateReport(r, ids); if (e.length) { bad++; console.log(`report ${i + 1}: ${e.join('; ')}`); } });
    console.log(bad ? `${bad} report(s) rejected` : 'all reports valid');
    process.exit(bad ? 1 : 0);
  } else if (cmd === 'dedup') {
    for (const g of dedupReports(readJsonl(file))) console.log(JSON.stringify(g));
  } else if (cmd === 'scan') {
    const f = scanRedaction(readFileSync(file, 'utf8'), { managed: !!values.managed });
    f.forEach((x) => console.log(`${x.kind}: ${x.match}`));
    console.log(f.length ? `${f.length} finding(s)` : 'clean');
    process.exit(f.length ? 1 : 0);
  } else { console.error(`unknown command ${cmd}`); process.exit(2); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
