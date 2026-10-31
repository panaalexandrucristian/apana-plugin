// Reads Claude Code transcripts and appends a per-laptop digest of skill invocations (incremental, local only).
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOW = 8;                  // records after an invocation that are searched for its base directory and signals
const SETTLE_MS = 10 * 60 * 1000;  // a file touched more recently may still gain records for the last invocations
const DEFAULT_ALIASES = { 'jev:logic-test-debug': 'apana:logic-test-debug' };
const HANDOFF_START = /^Citește\s+\S*HANDOFF\.md\s+și urmează instrucțiunile din el/;  // how claude-auto and compact-handoff start the first message of a continued session
const CORRECTION = /^\s*(nu\b|nu,|stop\b|gre[sș]it|no\b|wrong\b|that'?s not|not what|de ce\b)/i;

const sha = (s, n = 10) => createHash('sha256').update(s).digest('hex').slice(0, n);
const unknown = (why) => `unknown: ${why}`;

export function pluginVersion() {
  try { return JSON.parse(readFileSync(join(HERE, '../../../.claude-plugin/plugin.json'), 'utf8')).version; }
  catch { return unknown('plugin.json not found next to the skill'); }
}

const textOf = (rec) => {
  const c = rec.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return '';
};

// Where a skill was loaded from, from the "Base directory for this skill: <path>" text the harness injects.
export function classifyBase(dir, home = homedir()) {
  const plugin = /\/plugins\/cache\/([^/]+)\/([^/]+)\/(\d+\.\d+\.\d+[^/]*)\/skills\/[^/]+\/?$/.exec(dir);
  if (plugin) return { skill_source: 'plugin', plugin: `${plugin[1]}/${plugin[2]}`, plugin_version: plugin[3] };
  if (dir.startsWith(`${home}/.claude/skills/`)) return { skill_source: 'user' };
  if (/\/\.claude\/skills\/[^/]+\/?$/.test(dir)) return { skill_source: 'project' };
  return { skill_source: 'synced' };
}

export function skillHash(dir) {
  try { return sha(readFileSync(join(dir, 'SKILL.md')), 12); } catch { return unknown('SKILL.md not readable'); }
}

// The last message the user typed before record i: not a meta record, a tool result, a local-command output or a task notification (the harness writes those).
const lastTyped = (recs, i) => {
  for (let j = i - 1; j >= 0; j--) {
    const r = recs[j];
    if (r.type !== 'user' || r.isMeta || (Array.isArray(r.message?.content) && r.message.content.some((p) => p.type === 'tool_result'))) continue;
    const t = textOf(r).trim();
    if (t && !t.startsWith('<local-command-') && !t.startsWith('<task-notification>')) return t;
  }
  return '';
};

// Pure: records of one transcript file -> invocation records. `recs` are parsed JSON objects in file order.
export function findInvocations(recs, ctx) {
  const out = [];
  recs.forEach((rec, i) => {
    let skill, trigger, model;
    if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
      const use = rec.message.content.find((p) => p.type === 'tool_use' && p.name === 'Skill');
      if (use && typeof use.input?.skill === 'string') { skill = use.input.skill; trigger = HANDOFF_START.test(lastTyped(recs, i)) ? 'after-handoff' : 'claude-proactive'; model = rec.message.model; }
    } else if (rec.type === 'user') {
      const t = textOf(rec).trim();
      if (t.startsWith('<command-message>')) {
        const m = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(t);
        if (m) { skill = m[1]; trigger = 'user-slash'; }
      }
    }
    if (!skill || !rec.uuid) return;
    const after = recs.slice(i + 1, i + 1 + WINDOW);
    let base = null;
    for (const a of after) {
      const t = a.type === 'user' ? textOf(a).trimStart() : '';
      const m = /^Base directory for this skill: (.+)$/m.exec(t.startsWith('Base directory') ? t : '');
      if (m) { base = m[1].trim(); break; }
      // The next invocation owns any base directory after this point.
      if (t.startsWith('<command-message>') || (a.type === 'assistant' && Array.isArray(a.message?.content) && a.message.content.some((p) => p.name === 'Skill'))) break;
    }
    // Built-in commands (/clear, /goal) also appear as <command-name>; a real skill has a plugin prefix or loads a base directory.
    if (trigger === 'user-slash' && !skill.includes(':') && !base) return;
    model ??= recs.slice(i + 1, i + 41).find((a) => a.type === 'assistant' && a.message?.model)?.message.model ?? unknown('no assistant record near the invocation');
    out.push(buildRecord(rec, i, skill, trigger, model, base, after, ctx));
  });
  return out;
}

function signalsOf(after) {
  const sig = [];
  const seen = new Set();
  for (const a of after) {
    if (a.type === 'user' && Array.isArray(a.message?.content)) {
      if (a.message.content.some((p) => p.type === 'tool_result' && p.is_error)) sig.push('tool_error');
    }
    if (a.type === 'user') {
      const t = textOf(a);
      if (t.includes('[Request interrupted')) sig.push('abandon');
      else if (a.message?.content && !Array.isArray(a.message.content) || (Array.isArray(a.message?.content) && !a.message.content.some((p) => p.type === 'tool_result'))) {
        if (!t.startsWith('Base directory') && !t.startsWith('<') && CORRECTION.test(t)) sig.push('user_correction');
      }
    }
    if (a.type === 'assistant' && Array.isArray(a.message?.content)) {
      for (const p of a.message.content) if (p.type === 'tool_use') {
        const k = `${p.name}:${JSON.stringify(p.input)}`;
        if (seen.has(k)) sig.push('retry'); else seen.add(k);
      }
    }
  }
  return [...new Set(sig)];
}

function buildRecord(rec, i, skill, trigger, model, base, after, ctx) {
  const info = base ? classifyBase(base, ctx.home) : {};
  const r = {
    schema: 1, id: rec.uuid, ts: rec.timestamp, skill: ctx.aliases[skill] ?? skill, raw_skill: skill, trigger,
    session: rec.sessionId, project: sha(ctx.salt + (rec.cwd ?? '')),
    cc_version: rec.version ?? unknown('record has no version field'),
    skill_source: info.skill_source ?? unknown('the loaded skill text has no base directory line (bundled skill?)'),
    plugin: info.plugin, plugin_version: info.plugin_version ?? (info.skill_source ? 'none' : unknown('the loaded skill text has no base directory line (bundled skill?)')),
    skill_hash: info.skill_source && info.skill_source !== 'plugin' ? skillHash(base) : (info.skill_source ? 'none' : unknown('the loaded skill text has no base directory line (bundled skill?)')),
    model, improve_skill_version: ctx.version, signals: signalsOf(after),
  };
  if (ctx.quotes && trigger === 'user-slash') r.quote = textOf(rec).replace(/<[^>]+>/g, ' ').trim().slice(0, 200);
  return r;
}

export function listTranscripts(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

function readFrom(file, offset) {
  const size = statSync(file).size;
  if (size <= offset) return { buf: Buffer.alloc(0), size };
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  return { buf, size };
}

export function loadJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function loadConfig(out) {
  const p = join(out, 'config.json');
  const cfg = loadJson(p, null) ?? {};
  if (!cfg.salt) {
    cfg.salt = randomBytes(16).toString('hex');
    cfg.laptop_class ??= 'personal';
    cfg.publish ??= false;
    mkdirSync(out, { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  }
  return cfg;
}

export const machineFile = (cfg) => `machine-${sha(cfg.salt + hostname())}.jsonl`;

export function extract({ projects, out, managed, quotes, now = Date.now(), home = homedir() }) {
  const cfg = loadConfig(out);
  const isManaged = managed ?? cfg.laptop_class === 'gestionat';
  if (quotes && isManaged) throw new Error('--quotes is refused on a laptop marked "gestionat"');
  const statePath = join(out, 'state.json');
  const state = loadJson(statePath, { files: {}, seen: [] });
  const seen = new Set(state.seen);
  const ctx = { salt: cfg.salt, aliases: { ...DEFAULT_ALIASES, ...cfg.aliases }, version: pluginVersion(), quotes: !!quotes, home };
  const stats = { files: 0, records: 0, unparsed: 0, unknown_versions: 0, held_back: 0 };
  const lines = [];
  for (const file of listTranscripts(projects)) {
    const offset = state.files[file] ?? 0;
    const { buf, size } = readFrom(file, offset < statSync(file).size ? offset : 0);
    const start = offset < size ? offset : 0;
    const end = buf.lastIndexOf(10) + 1;
    if (!end) continue;
    stats.files++;
    const parsed = [];
    let pos = start;
    for (const raw of buf.subarray(0, end).toString('utf8').split('\n')) {
      const len = Buffer.byteLength(raw) + 1;
      if (raw.trim()) {
        try { parsed.push({ rec: JSON.parse(raw), pos }); } catch { stats.unparsed++; }
      }
      pos += len;
    }
    const recs = parsed.map((p) => p.rec);
    const settled = now - statSync(file).mtimeMs > SETTLE_MS;
    let next = start + end;
    for (const inv of findInvocations(recs, ctx)) {
      const idx = recs.findIndex((r) => r.uuid === inv.id);
      if (!settled && idx > recs.length - 1 - WINDOW) { next = Math.min(next, parsed[idx].pos); stats.held_back++; continue; }
      if (seen.has(inv.id)) continue;
      seen.add(inv.id);
      lines.push(JSON.stringify(inv));
      stats.records++;
      if (Object.values(inv).some((v) => typeof v === 'string' && v.startsWith('unknown'))) stats.unknown_versions++;
    }
    state.files[file] = next;
  }
  mkdirSync(out, { recursive: true });
  if (lines.length) appendFileSync(join(out, machineFile(cfg)), lines.join('\n') + '\n');
  writeFileSync(statePath, JSON.stringify({ files: state.files, seen: [...seen] }));
  return stats;
}

function main() {
  const { values } = parseArgs({ options: { projects: { type: 'string' }, out: { type: 'string' }, managed: { type: 'boolean' }, quotes: { type: 'boolean' } } });
  try {
    const stats = extract({
      projects: values.projects ?? join(homedir(), '.claude/projects'),
      out: values.out ?? join(homedir(), '.claude/skill-reports'),
      managed: values.managed, quotes: values.quotes,
    });
    console.log(JSON.stringify(stats));
  } catch (e) { console.error(e.message); process.exit(2); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
