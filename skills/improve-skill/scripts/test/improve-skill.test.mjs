import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, classifyBase, findInvocations } from '../extract.mjs';
import { validateReport, dedupReports, scanRedaction, REQUIRED, ENUMS } from '../report.mjs';
import { publish, loadDigests, summarize } from '../sync.mjs';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = () => mkdtempSync(join(tmpdir(), 'improve-skill-'));
const BASE = '/h/.claude/plugins/cache/apana-private/apana/0.8.0/skills/review-plan';
let n = 0;
const rec = (o) => ({ uuid: `u${++n}`, timestamp: '2026-10-30T10:00:00Z', sessionId: 's1', version: '2.1.300', cwd: '/secret/project', ...o });
const user = (text, o) => rec({ type: 'user', message: { role: 'user', content: text }, ...o });
const assistant = (content, o) => rec({ type: 'assistant', message: { model: 'claude-x', content }, ...o });
const slash = (name) => user(`<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`);

function fixture() {
  const projects = tmp(); const out = tmp();
  mkdirSync(join(projects, 'p'));
  const recs = [
    slash('jev:logic-test-debug'), user(`Base directory for this skill: ${BASE}\n\n# x`), assistant([{ type: 'text', text: 'ok' }]),
    user('nu, asta e gresit'),
    slash('clear'), user('<local-command-stdout>x</local-command-stdout>'),
    user('The `<command-name>` blocks are parsed'),
    assistant([{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'apana:review-plan' } }]),
    user(`Base directory for this skill: ${BASE}`),
  ];
  for (let i = 0; i < 9; i++) recs.push(assistant([{ type: 'text', text: 'pad' }]));
  const file = join(projects, 'p', 's1.jsonl');
  writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
  utimesSync(file, new Date(0), new Date(0));
  return { projects, out, file };
}

const digestOf = (out) => readdirSync(out).filter((f) => f.startsWith('machine-')).flatMap((f) => readFileSync(join(out, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

test('extract finds slash and Skill-tool invocations, ignores built-ins and prose, applies the alias', () => {
  const { projects, out } = fixture();
  const stats = extract({ projects, out, home: '/h' });
  const d = digestOf(out);
  assert.deepEqual(d.map((r) => [r.skill, r.trigger]), [['apana:logic-test-debug', 'user-slash'], ['apana:review-plan', 'claude-proactive']]);
  assert.equal(stats.unparsed, 1);
  assert.equal(d[0].raw_skill, 'jev:logic-test-debug');
  assert.equal(d[0].plugin_version, '0.8.0');
  assert.equal(d[0].cc_version, '2.1.300');
  assert.ok(d[0].signals.includes('user_correction'));
  assert.ok(!JSON.stringify(d).includes('/secret/project'), 'project path must be hashed');
});

test('extract is incremental and deduplicates', () => {
  const { projects, out } = fixture();
  extract({ projects, out, home: '/h' });
  const again = extract({ projects, out, home: '/h' });
  assert.equal(again.records, 0);
  assert.equal(digestOf(out).length, 2);
});

test('a recently written file holds back the last invocations', () => {
  const { projects, out, file } = fixture();
  utimesSync(file, new Date(), new Date());
  const stats = extract({ projects, out, home: '/h' });
  assert.equal(stats.held_back, 0, 'both invocations have a full window after them');
  const short = join(projects, 'p', 's2.jsonl');
  writeFileSync(short, JSON.stringify(slash('apana:x')) + '\n');
  assert.equal(extract({ projects, out, home: '/h' }).held_back, 1);
});

test('unknown version is written with the reason, not omitted', () => {
  const { projects, out } = fixture();
  writeFileSync(join(projects, 'p', 'nobase.jsonl'), JSON.stringify(slash('apana:orphan')) + '\n');
  utimesSync(join(projects, 'p', 'nobase.jsonl'), new Date(0), new Date(0));
  const stats = extract({ projects, out, home: '/h' });
  const r = digestOf(out).find((x) => x.skill === 'apana:orphan');
  assert.match(r.plugin_version, /^unknown: \S/);
  assert.ok(stats.unknown_versions >= 1);
});

test('--quotes is refused on a managed laptop and managed digests carry no text', () => {
  const { projects, out } = fixture();
  assert.throws(() => extract({ projects, out, managed: true, quotes: true, home: '/h' }), /gestionat/);
  extract({ projects, out, managed: true, home: '/h' });
  assert.deepEqual(scanRedaction(readdirSync(out).filter((f) => f.startsWith('machine-')).map((f) => readFileSync(join(out, f), 'utf8')).join(''), { managed: true }), []);
});

test('classifyBase tells plugin, user, project and other paths apart', () => {
  assert.equal(classifyBase(BASE, '/h').plugin, 'apana-private/apana');
  assert.equal(classifyBase('/h/.claude/skills/mine', '/h').skill_source, 'user');
  assert.equal(classifyBase('/work/app/.claude/skills/mine', '/h').skill_source, 'project');
  assert.equal(classifyBase('/elsewhere/skill', '/h').skill_source, 'synced');
});

const good = () => ({
  kind: 'bug', skill: 'apana:x', plugin_version: '0.8.0', cc_version: '2.1.300', skill_hash: 'abc', improve_skill_version: '0.9.0',
  severity: 'minor', trigger: 'user-slash', evidence: { records: ['u1'], counts: [{ name: 'corrections', value: 2, label: 'guessed', n: 5 }] },
  expected: 'e', actual: 'a', proposed_change: 'p', laptop_class: 'personal', status: 'open',
});

test('validateReport accepts a good report and rejects each kind of defect', () => {
  assert.deepEqual(validateReport(good(), new Set(['u1'])), []);
  const no = (mut) => validateReport(mut(good()), new Set(['u1']));
  assert.ok(no((r) => { delete r.evidence; return r; }).length);
  assert.ok(no((r) => { r.severity = 'huge'; return r; }).length);
  assert.ok(no((r) => { r.evidence.counts[0].label = 'sure'; return r; }).length);
  assert.ok(no((r) => { delete r.evidence.counts[0].n; return r; }).length);
  assert.ok(no((r) => { r.evidence.records = ['missing']; return r; }).length);
  assert.ok(no((r) => { r.cc_version = 'unknown'; return r; }).length, 'unknown needs a reason');
  assert.deepEqual(no((r) => { r.cc_version = 'unknown: no field'; return r; }), []);
});

test('dedupReports merges the same finding from two laptops, ignoring versions', () => {
  const a = { ...good(), laptop: 'A' };
  const b = { ...good(), laptop: 'B', plugin_version: '0.7.0' };
  const out = dedupReports([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].laptop_count, 2);
  assert.deepEqual(out[0].versions, ['0.8.0', '0.7.0']);
});

test('scanRedaction finds paths, e-mails, tokens and managed quotes', () => {
  for (const t of ['see /Users/ana/x', 'a@b.com', 'ghp_' + 'a'.repeat(30), 'sk-' + 'a'.repeat(24)]) assert.equal(scanRedaction(t).length, 1, t);
  assert.deepEqual(scanRedaction('{"skill":"apana:x","session":"abc"}'), []);
  assert.equal(scanRedaction('{"quote":"hi"}', { managed: true }).length, 1);
  assert.equal(scanRedaction('{"quote":"hi"}').length, 0);
});

test('publish: refused without consent, blocked by the scan, pushes to a local bare repo, falls back on a bad remote', () => {
  const { projects, out } = fixture();
  extract({ projects, out, home: '/h' });
  const cfg = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'));
  assert.throws(() => publish({ out, cfg }), /publishing is off/);
  const bare = join(tmp(), 'r.git');
  execFileSync('git', ['init', '--bare', '--quiet', bare]);
  const on = { ...cfg, publish: true, repo: bare };
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t' };
  Object.assign(process.env, env);
  assert.equal(publish({ out, cfg: on }), 'published');
  assert.match(execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }), /machines\/machine-/);
  assert.equal(publish({ out, cfg: on }), 'nothing new to publish');
  assert.equal(loadDigests(out).length, 2, 'local and cloned digests of the same laptop collapse by record id');
  const out2 = tmp();
  extract({ projects, out: out2, home: '/h' });
  assert.throws(() => publish({ out: out2, cfg: { ...JSON.parse(readFileSync(join(out2, 'config.json'), 'utf8')), publish: true, repo: '/nonexistent/repo.git' } }));
  assert.equal(digestOf(out2).length, 2, 'the local digest survives a failed publish');
  writeFileSync(join(out, readdirSync(out).find((f) => f.startsWith('machine-'))), JSON.stringify({ id: 'x', note: 'mail a@b.com' }) + '\n');
  assert.throws(() => publish({ out, cfg: on }), /redaction scan/);
});

test('summarize counts per skill and records with unknown fields', () => {
  const s = summarize([{ skill: 'a', laptop: 'L', trigger: 'user-slash', signals: ['retry'], plugin_version: '1', skill_hash: 'h' }, { skill: 'a', laptop: 'M', trigger: 'user-slash', plugin_version: 'unknown: x', skill_hash: 'h' }]);
  assert.equal(s.skills.a.invocations, 2);
  assert.equal(s.skills.a.laptops, 2);
  assert.equal(s.records_with_unknown_fields, 1);
});

test('the report template and the issue form list the same fields', () => {
  const yml = [...readFileSync(join(SKILL_DIR, 'assets/skill-feedback.yml'), 'utf8').matchAll(/^\s+id: (\w+)$/gm)].map((m) => m[1]).sort();
  const md = readFileSync(join(SKILL_DIR, 'references/report-template.md'), 'utf8');
  for (const f of REQUIRED) assert.ok(md.includes('`' + f + '`'), `template lacks ${f}`);
  assert.deepEqual(yml, [...REQUIRED].sort());
});

test('SKILL.md frontmatter has name, a one-line description under 800 characters and allowed-tools', () => {
  const t = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(t)[1].split('\n');
  assert.equal(fm.length, 3);
  assert.equal(fm[0], 'name: improve-skill');
  assert.match(fm[1], /^description: ".*"$/);
  assert.ok(fm[1].length - 'description: '.length < 800);
});

const CTX = { salt: 'x', aliases: {}, version: '1', quotes: false, home: '/h' };
const skillCall = () => assistant([{ type: 'tool_use', id: 't9', name: 'Skill', input: { skill: 'apana:review-plan' } }]);
const triggerAfter = (...before) => findInvocations([...before, skillCall()], CTX).map((r) => r.trigger);
const HOME_HANDOFF = 'Citește /Users/apana/.claude/handoffs/auto/handoff-d712132a-20261031-c1feexcb/HANDOFF.md și urmează instrucțiunile din el';
const TMP_HANDOFF = 'Citește /tmp/handoff-d86da71f-20261026-iny1lf94/HANDOFF.md și urmează instrucțiunile din el';
const AUTO_TAIL = '. Sesiunea precedentă a fost oprită automat la ~123k tokeni de context, ca lucrul să continue în această sesiune nouă.';
const EXTRA_TAIL = `${AUTO_TAIL} Citește și, în ordine, /x/e1.md: conțin ultimele evenimente ale sesiunii precedente.`;

test('a Skill call that follows a handoff continuation message is after-handoff, not claude-proactive', () => {
  for (const head of [HOME_HANDOFF, TMP_HANDOFF]) {
    for (const tail of [AUTO_TAIL, '.', '', EXTRA_TAIL]) {
      assert.deepEqual(triggerAfter(user(head + tail)), ['after-handoff'], head + tail);
    }
  }
  const asParts = rec({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: HOME_HANDOFF + '.' }] } });
  assert.deepEqual(triggerAfter(asParts), ['after-handoff']);
});

test('the continuation counts when the claude-auto anchor message came first', () => {
  assert.deepEqual(triggerAfter(user('Răspunde exact: ANCHOR_READY'), assistant([{ type: 'text', text: 'ANCHOR_READY' }]), user(HOME_HANDOFF + AUTO_TAIL)), ['after-handoff']);
});

test('what the user did not type between the continuation and the call does not break the attribution', () => {
  const toolResult = rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  const meta = rec({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /x' } });
  const between = [assistant([{ type: 'text', text: 'citesc nota' }]), toolResult, meta, user('<local-command-stdout>Set effort</local-command-stdout>'), user('<task-notification>\n<task-id>a1</task-id>\n</task-notification>')];
  assert.deepEqual(triggerAfter(user(HOME_HANDOFF + AUTO_TAIL), ...between), ['after-handoff']);
});

test('a message the user typed after the continuation keeps the call claude-proactive', () => {
  const cont = user(HOME_HANDOFF + AUTO_TAIL);
  for (const typed of [user('nu, fă altfel'), slash('clear'), user('[Request interrupted by user]')]) {
    assert.deepEqual(triggerAfter(cont, assistant([{ type: 'text', text: 'ok' }]), typed), ['claude-proactive']);
  }
});

test('text that is not a handoff continuation message stays claude-proactive', () => {
  assert.deepEqual(triggerAfter(user('Read /tmp/handoff-x/HANDOFF.md completely using these offset:limit ranges in order: 1:281.')), ['claude-proactive']);
  assert.deepEqual(triggerAfter(user('Te rog: ' + HOME_HANDOFF)), ['claude-proactive'], 'only a message that starts with it counts');
  assert.deepEqual(triggerAfter(user('Citește /x/NOTES.md și urmează instrucțiunile din el')), ['claude-proactive']);
  assert.deepEqual(triggerAfter(assistant([{ type: 'text', text: 'ok' }])), ['claude-proactive']);
});

test('a slash command after the continuation is still user-slash', () => {
  assert.deepEqual(findInvocations([user(HOME_HANDOFF + AUTO_TAIL), slash('apana:review-plan')], CTX).map((r) => r.trigger), ['user-slash']);
});

test('the three lists of trigger values agree and the report check accepts after-handoff', () => {
  const md = readFileSync(join(SKILL_DIR, 'references/report-template.md'), 'utf8');
  const yml = readFileSync(join(SKILL_DIR, 'assets/skill-feedback.yml'), 'utf8');
  const inTemplate = [...(/^\| `trigger` \| (.+) \|$/m.exec(md)[1]).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const inForm = /label: trigger, options: \[([^\]]+)\]/.exec(yml)[1].split(',').map((v) => v.trim());
  assert.ok(ENUMS.trigger.includes('after-handoff'));
  assert.deepEqual(inTemplate, ENUMS.trigger);
  assert.deepEqual(inForm, ENUMS.trigger);
  assert.deepEqual(validateReport({ ...good(), trigger: 'after-handoff' }, new Set(['u1'])), []);
  assert.ok(validateReport({ ...good(), trigger: 'handoff-reload' }, new Set(['u1'])).length);
});
