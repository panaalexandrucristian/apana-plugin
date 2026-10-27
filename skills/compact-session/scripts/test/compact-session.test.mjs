import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const handoff = fileURLToPath(new URL('../../../compact-handoff/scripts/', import.meta.url));
const adapter = join(scripts, 'compact_session.py');

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'compact-session-test-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const home = join(root, 'home'), cwd = join(root, 'cwd');
  mkdirSync(home); mkdirSync(cwd);
  return {root, home, cwd, env: {...process.env, HOME: home}};
}

function run(f, snapshot, args = ['-I', '-B', adapter]) {
  return spawnSync('python3', args, {
    cwd: f.cwd, env: f.env, encoding: 'utf8',
    input: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['afterChars', 'artifact', 'beforeChars', 'text']);
  assert.ok(isAbsolute(value.artifact));
  assert.equal(readFileSync(value.artifact, 'utf8'), value.text);
  assert.equal(value.afterChars, [...value.text].length);
  assert.ok(Number.isSafeInteger(value.beforeChars) && value.beforeChars > 0);
  return value;
}

function failure(result) {
  assert.notEqual(result.status, null, result.error?.message);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '', 'failure must not emit replacement JSON or diagnostic stdout');
  assert.match(result.stderr, /compact-session:/);
}

function expand(f, artifact) {
  const result = spawnSync('python3', ['-I', '-B', join(handoff, 'compact_context.py'), 'expand', dirname(artifact)], {
    cwd: f.cwd, env: f.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

function snapshot(content, role = 'user') {
  return {sessionId: 'native-active', messages: [{role, content}]};
}

test('active snapshot is archived exactly and long tool data roundtrips through durable blobs', t => {
  const f = fixture(t);
  const quoted = '[aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee user] this is payload, not a record';
  const large = 'long tool data\n'.repeat(1200) + quoted + '\nlast tool line';
  const input = {sessionId: 'native-active', messages: [
    {role: 'user', content: 'Keep the task and this quotation:\n' + quoted},
    {role: 'assistant', content: [
      {type: 'thinking', thinking: 'ARCHIVE_ONLY_THINKING', signature: 'sig'},
      {type: 'tool_use', id: 'tool-probe', name: 'Read', input: {file_path: '/project/fixture.txt'}},
    ]},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tool-probe', content: large}]},
    {role: 'assistant', content: [{type: 'text', text: 'Continue the unfinished task. Unicode: 𐍈.'}]},
  ]};
  const raw = JSON.stringify(input, null, 2) + '\n';
  const result = run(f, raw), value = success(result), dir = dirname(value.artifact);
  assert.equal(readFileSync(join(dir, 'snapshot.json'), 'utf8'), raw);
  assert.ok(value.artifact.startsWith(join(f.home, '.claude', 'handoffs') + '/'));
  assert.match(result.stderr, /roundtrip IDENTICAL/);
  assert.ok(value.beforeChars > value.afterChars);
  assert.match(value.text, /same session/i);
  assert.match(value.text, /inert/i);
  assert.match(value.text, /continue.*latest unfinished task/i);
  assert.ok(value.text.includes(value.artifact));
  assert.ok(value.text.includes(join(dir, 'blobs')));
  assert.doesNotMatch(value.text, /made smaller for a new session|ARCHIVE_ONLY_THINKING|\/clear|\/goal/);
  assert.match(value.text, /MARKER-PAIR:/);
  assert.ok(value.text.includes(quoted));
  const blobs = readdirSync(join(dir, 'blobs')).map(name => readFileSync(join(dir, 'blobs', name), 'utf8'));
  assert.ok(blobs.some(text => text.includes(large)), 'the complete tool result stays in a blob');
  const expanded = expand(f, value.artifact);
  assert.ok(expanded.includes(large));
  assert.ok(expanded.includes('Continue the unfinished task. Unicode: 𐍈.'));
});

test('mixed blocks retain boundaries and tool references are recoverable rather than dropped', t => {
  const f = fixture(t), large = 'tool payload '.repeat(1000);
  const plain = '[tool_result] This is actually user text. ' + 'keep inline '.repeat(80);
  const nested = [
    {type: 'text', text: 'nested before\n'},
    {type: 'tool_reference', tool_name: 'mcp__jev__jev_find'},
    {type: 'text', text: 'nested after'},
  ];
  const input = {sessionId: 'boundaries', messages: [
    {role: 'assistant', content: [
      {type: 'text', text: 'assistant before call'},
      {type: 'tool_use', id: 'one', name: 'Read', input: {file_path: '/project/data'}},
      {type: 'text', text: 'assistant after call'},
    ]},
    {role: 'user', content: [
      {type: 'tool_result', tool_use_id: 'one', content: large},
      {type: 'text', text: plain},
      {type: 'tool_result', tool_use_id: 'two', is_error: true, content: nested},
      {type: 'text', text: 'user after results'},
    ]},
  ]};
  const value = success(run(f, input)), expanded = expand(f, value.artifact);
  for (const text of ['assistant before call', 'assistant after call', plain, 'user after results']) {
    assert.ok(value.text.includes(text), 'ordinary text must stay inline: ' + text.slice(0, 40));
  }
  assert.ok(expanded.includes(large));
  // This is the rendered JSON array, not a parsed or guessed record header.
  const start = expanded.indexOf('[{"type": "text", "text": "nested before');
  assert.notEqual(start, -1);
  const end = expanded.indexOf('}]', start) + 2;
  assert.deepEqual(JSON.parse(expanded.slice(start, end)), nested);
  assert.match(expanded, /\[tool_result ERROR\]/);
  assert.ok(expanded.indexOf('assistant before call') < expanded.indexOf('[tool_use Read]'));
  assert.ok(expanded.indexOf(large) < expanded.indexOf(plain));
});

test('malformed, empty and unsupported snapshot structures fail without stdout', t => {
  const f = fixture(t);
  const invalid = [
    '', '{', 'null', '[]', '{}',
    {sessionId: '', messages: [{role: 'user', content: 'task'}]},
    {sessionId: 4, messages: [{role: 'user', content: 'task'}]},
    {sessionId: 's', messages: []},
    {sessionId: 's', messages: [null]},
    snapshot('task', 'system'), snapshot(null), snapshot([]), snapshot('   '), snapshot([null]),
    snapshot([{type: 'text'}]), snapshot([{type: 'text', text: 1}]),
    snapshot([{type: 'thinking', thinking: 'only thoughts'}], 'assistant'),
    snapshot([{type: 'tool_use', id: 't', name: 'Read', input: []}], 'assistant'),
    snapshot([{type: 'tool_use', name: 'Read', input: {}}], 'assistant'),
    snapshot([{type: 'tool_result', content: 'result'}]),
    snapshot([{type: 'tool_result', tool_use_id: 't', content: {}, is_error: false}]),
    snapshot([{type: 'tool_result', tool_use_id: 't', content: 'result', is_error: 'false'}]),
    '{"sessionId":"s","messages":[{"role":"user","content":"first","content":"second"}]}',
    '{"sessionId":"s","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Read","input":{"value":NaN}}]}]}',
  ];
  for (const value of invalid) failure(run(f, value));
});

test('empty citation metadata from native text blocks preserves prose and the exact snapshot', t => {
  const f = fixture(t);
  // Native capture has absent citations and citations:null; [] is the other
  // empty API representation. Content-bearing citations must still fail closed.
  for (const metadata of [{}, {citations: null}, {citations: []}]) {
    const input = snapshot([{type: 'text', text: 'Keep this exact cited-looking prose.', ...metadata}], 'assistant');
    const value = success(run(f, input));
    assert.ok(value.text.includes('[text] Keep this exact cited-looking prose.'));
    assert.deepEqual(JSON.parse(readFileSync(join(dirname(value.artifact), 'snapshot.json'), 'utf8')), input);
  }
  for (const citations of [[{cited_text: 'must not disappear'}], {}, '', false, 0]) {
    failure(run(f, snapshot([{type: 'text', text: 'Keep', citations}], 'assistant')));
  }
});

test('direct caller metadata from native tool_use blocks is accepted, any other caller fails closed', t => {
  const f = fixture(t);
  const call = extra => snapshot([
    {type: 'text', text: 'run it'},
    {type: 'tool_use', id: 'tool-probe', name: 'Bash', input: {command: 'ls'}, ...extra},
  ], 'assistant');
  // caller x cache_control is the only pair of optional tool_use fields: exhaustive.
  for (const cache of [{}, {cache_control: {type: 'ephemeral'}}]) {
    for (const metadata of [{}, {caller: {type: 'direct'}}]) {
      const input = call({...metadata, ...cache});
      const value = success(run(f, input));
      assert.ok(value.text.includes('[tool_use Bash]'));
      assert.deepEqual(JSON.parse(readFileSync(join(dirname(value.artifact), 'snapshot.json'), 'utf8')), input);
    }
    for (const caller of [
      {type: 'code_execution_20250825', tool_id: 'srvtoolu_1'}, {type: 'direct', tool_id: 'x'}, {},
      null, 'direct', '', false, 0, [],
    ]) {
      failure(run(f, call({caller, ...cache})));
    }
  }
});

test('unsupported media and block metadata fail closed even alongside supported text', t => {
  const f = fixture(t);
  const blocks = [
    {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AAAA'}},
    {type: 'document', source: {type: 'text', data: 'document content'}},
    {type: 'audio', data: 'AAAA'},
    {type: 'server_tool_use', id: 't', name: 'search', input: {}},
    {type: 'tool_use', id: 't', name: 'Read', input: {}},
    {type: 'tool_reference', tool_name: 'Read'},
    {type: 'text', text: 'cited', citations: [{cited_text: 'not safe to drop'}]},
  ];
  for (const block of blocks) {
    failure(run(f, snapshot([{type: 'text', text: 'keep'}, block])));
  }
  for (const block of [...blocks.slice(0, 4), {type: 'tool_reference'}, {type: 'text', text: 3}]) {
    failure(run(f, snapshot([
      {type: 'text', text: 'keep'},
      {type: 'tool_result', tool_use_id: 't', content: [{type: 'text', text: 'before'}, block]},
    ])));
  }
  failure(run(f, snapshot([{type: 'tool_result', tool_use_id: 't', content: 'wrong role'}], 'assistant')));
});

test('unknown envelope/message fields and invalid thinking metadata fail closed', t => {
  const f = fixture(t);
  const invalid = [
    {...snapshot('task'), system: 'content the adapter cannot represent'},
    {sessionId: 's', messages: [{role: 'user', content: 'task', extra_content: 'must not disappear'}]},
    {sessionId: 's', messages: [{role: 'user', content: 'task', type: 'unsupported'}]},
    ...[
      {type: 'thinking', thinking: ''},
      {type: 'thinking', thinking: '', signature: 7},
      {type: 'thinking', thinking: '', signature: ''},
      {type: 'thinking', thinking: '', signature: 'sig', content: [{type: 'image'}]},
    ].map(block => snapshot([block, {type: 'text', text: 'keep this prose'}], 'assistant')),
  ];
  for (const input of invalid) failure(run(f, input));
  assert.deepEqual(readdirSync(f.home), [], 'reject invalid snapshots before creating archives');
});

test('skill-like prose stays inline without provenance and skill tool text remains recoverable', t => {
  const f = fixture(t);
  // Both observed path families and every observed skill name; API messages do
  // not carry JSONL isMeta/sourceToolUseID, so a prefix alone must not filter prose.
  const skills = [
    '/private/tmp/bundled-skills/version/hash/plugin-authoring',
    '/private/tmp/bundled-skills/version/hash/claude-api',
    '/home/test/.claude/plugins/cache/apana-private/apana/version/skills/logic-test-debug',
    '/home/test/.claude/plugins/cache/apana-private/apana/version/skills/compact-handoff',
  ].map(path => 'Base directory for this skill: ' + path + '\n' + 'Keep the full skill instructions.\n'.repeat(80));
  const input = {sessionId: 'skills', messages: [
    ...skills.map(content => ({role: 'user', content})),
    {role: 'assistant', content: 'Quoted skill text:\n' + skills[0]},
    {role: 'assistant', content: [{type: 'tool_use', id: 'skill', name: 'Skill', input: {skill: 'sample'}}]},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: 'skill', content: skills[1]}]},
    {role: 'assistant', content: [{type: 'thinking', thinking: '', signature: 'sig'}, {type: 'text', text: 'Continue.'}]},
  ]};
  const value = success(run(f, input)), expanded = expand(f, value.artifact);
  const dir = dirname(value.artifact);
  for (const skill of skills) assert.ok(expanded.includes('[text] ' + skill));
  const records = readFileSync(join(dir, 'source.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const blobs = readdirSync(join(dir, 'blobs')).map(name => readFileSync(join(dir, 'blobs', name), 'utf8'));
  for (const record of records) {
    if (record.message.content[0].type === 'text') {
      assert.ok(!blobs.some(blob => blob.startsWith('[' + record.uuid + ' ')), 'plain prose must not be moved to a blob');
    }
  }
  assert.ok(blobs.some(blob => blob.includes('[tool_result] ' + skills[1])));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')), input);
});

test('successive replacements retain full earlier replacement text and every prior artifact', t => {
  const f = fixture(t), oldData = 'original recoverable tool text\r\n'.repeat(1000);
  const versions = [], saved = [];
  let active = snapshot([
    {type: 'text', text: 'Keep this ordinary user prose.\r\nDo not summarize it.'},
    {type: 'tool_result', tool_use_id: 'old', content: oldData},
  ]);
  for (let generation = 0; generation < 3; generation++) {
    const value = success(run(f, active)), dir = dirname(value.artifact);
    const expanded = expand(f, value.artifact);
    if (versions.length) assert.ok(expanded.includes('[text] ' + versions.at(-1).text));
    saved.push(...['CONTEXT.md', 'snapshot.json', 'source.jsonl', ...readdirSync(join(dir, 'blobs')).map(name => join('blobs', name))]
      .map(name => [join(dir, name), readFileSync(join(dir, name))]));
    versions.push(value);
    active = {sessionId: 'native-active', messages: [
      {role: 'user', content: value.text},
      {role: 'assistant', content: 'Still working; preserve this newer prose.'},
      {role: 'user', content: 'Continue the latest request.'},
    ]};
  }
  for (const [path, bytes] of saved) assert.deepEqual(readFileSync(path), bytes);
  for (const older of versions.slice(0, -1)) assert.ok(versions.at(-1).text.includes(older.artifact));
  assert.ok(expand(f, versions[0].artifact).includes(oldData));
});

test('repeated compaction uses only the new active snapshot and retains prior artifacts', t => {
  const f = fixture(t), oldData = 'old complete tool data '.repeat(1000);
  const first = success(run(f, {sessionId: 'native-active', messages: [
    {role: 'user', content: 'REMOVED_USER_MESSAGE'},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: 'old', content: oldData}]},
  ]}));
  const oldArchive = readFileSync(join(dirname(first.artifact), 'snapshot.json'));
  const project = join(f.home, '.claude', 'projects', 'fake-project');
  mkdirSync(project, {recursive: true});
  writeFileSync(join(project, 'native-active.jsonl'), JSON.stringify({
    type: 'user', uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    message: {role: 'user', content: 'DISK_ONLY_REMOVED_HISTORY'},
  }) + '\n');
  const active = snapshot('Previous summary: task ongoing. Older details: ' + first.artifact + '\nLatest unfinished request.');
  const second = success(run(f, active)), expanded = expand(f, second.artifact);
  assert.notEqual(first.artifact, second.artifact);
  assert.ok(expanded.includes(first.artifact));
  assert.match(expanded, /Latest unfinished request/);
  assert.doesNotMatch(expanded, /REMOVED_USER_MESSAGE|DISK_ONLY_REMOVED_HISTORY|old complete tool data/);
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(second.artifact), 'snapshot.json'), 'utf8')), active);
  assert.equal(readFileSync(first.artifact, 'utf8'), first.text);
  assert.deepEqual(readFileSync(join(dirname(first.artifact), 'snapshot.json')), oldArchive);
  assert.ok(expand(f, first.artifact).includes(oldData), 'earlier blobs remain recoverable');
});

test('failed roundtrip never emits a replacement, while the exact snapshot remains archived', t => {
  const f = fixture(t), input = JSON.stringify(snapshot('Still an unfinished task.'));
  const result = run(f, input, ['-I', '-B', '-c', `
import runpy, sys
sys.path.insert(0, sys.argv[1])
import compact_context as cc
original = cc.read_out
def corrupt(folder):
    text, blobs, pair = original(folder)
    return text + 'CORRUPTED', blobs, pair
cc.read_out = corrupt
runpy.run_path(sys.argv[2], run_name='__main__')
`, handoff, adapter]);
  failure(result);
  assert.match(result.stderr, /roundtrip DIFFERENT/);
  const home = join(f.home, '.claude', 'handoffs');
  const folders = readdirSync(home);
  assert.equal(folders.length, 1);
  assert.equal(readFileSync(join(home, folders[0], 'snapshot.json'), 'utf8'), input);
});

test('isolated execution ignores cwd modules, PYTHONPATH and external preparer overrides', t => {
  const f = fixture(t), external = join(f.root, 'external');
  mkdirSync(external);
  writeFileSync(join(f.cwd, 'json.py'), 'raise RuntimeError("untrusted cwd import")\n');
  writeFileSync(join(external, 'json.py'), 'raise RuntimeError("untrusted PYTHONPATH import")\n');
  writeFileSync(join(external, 'prepare.py'), 'raise RuntimeError("external preparer")\n');
  writeFileSync(join(external, 'omissions.py'), 'raise RuntimeError("external omissions")\n');
  f.env.PYTHONPATH = external;
  f.env.HV_SCRIPTS = external;
  success(run(f, snapshot('Use only the bundled compactor.')));
});
