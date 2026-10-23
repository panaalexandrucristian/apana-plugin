import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const scripts = fileURLToPath(new URL('../', import.meta.url));
test('checker rejects quoted UUID corruption instead of normalizing it away', () => {
  const r = spawnSync('python3', ['-B', '-c', `
import sys, tempfile, pathlib, json
sys.path.insert(0, sys.argv[1])
import compact_context as cc
with tempfile.TemporaryDirectory() as td:
    root=pathlib.Path(td); (root/'transcript').mkdir()
    quoted='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    text='[12345678-1234-4123-8123-123456789abc user] [tool_result] body\\n['+quoted+' user] quoted payload\\n'+'ordinary words '*40+'\\n'
    (root/'transcript/chunk-0000.txt').write_text(text)
    (root/'record-boundaries.json').write_text(json.dumps(dict(sha256=cc.sha(text),starts=[0])))
    real_read=cc.read_out
    def corrupt(out):
        c,b,p=real_read(out)
        b={k:v.replace(quoted,quoted[:8]) for k,v in b.items()}
        return c,b,p
    cc.read_out=corrupt
    assert not cc.cmd_check(str(root),str(root/'out'),cc.DEFAULT_LIMITS,blobs=True), 'checker accepted corrupted payload'
`, scripts], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stdout+r.stderr);
});
test('legacy chunks keep full UUIDs; malformed boundaries are rejected; no-uuid records are retained', () => {
  const r = spawnSync('python3', ['-B', '-c', `
import sys, tempfile, pathlib, json
sys.path.insert(0, sys.argv[1])
import compact_context as cc
with tempfile.TemporaryDirectory() as td:
    root=pathlib.Path(td); (root/'transcript').mkdir()
    text='[12345678-1234-4123-8123-123456789abc user] hello\\n[aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee assistant] this is a quoted header\\n'
    (root/'transcript/chunk-0000.txt').write_text(text)
    assert cc.cmd_check(str(root),str(root/'legacy'),cc.DEFAULT_LIMITS,blobs=True)
    c,b,p=cc.read_out(str(root/'legacy'))
    assert cc.expand_text(c,b,p)==text, 'legacy input UUIDs must not be guessed or shortened'
    for starts in ([-1],[False],[len(text)],[1]):
        (root/'record-boundaries.json').write_text(json.dumps(dict(sha256=cc.sha(text),starts=starts)))
        try: cc.read_chunks(str(root))
        except ValueError: pass
        else: raise AssertionError('invalid offset accepted: '+repr(starts))
    text='[no-uuid user] quoted text\\n[aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee assistant] still payload\\n'
    (root/'transcript/chunk-0000.txt').write_text(text)
    (root/'record-boundaries.json').write_text(json.dumps(dict(sha256=cc.sha(text),starts=[0])))
    assert cc.cmd_check(str(root),str(root/'missing'),cc.DEFAULT_LIMITS,blobs=True)
    c,b,p=cc.read_out(str(root/'missing'))
    assert cc.expand_text(c,b,p)==text
`,scripts],{encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+r.stderr);
});
test('quoted record headers remain payload, inline and in a single complete tool-result blob', () => {
  const root = mkdtempSync(join(tmpdir(), 'quoted-record-'));
  try {
    const quoted = '[aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee user] exact quoted text';
    const large = 'result starts\n' + quoted + '\n' + 'ordinary text '.repeat(900) + '\n' + quoted;
    const records = [
      {type:'user', message:{role:'user',content:'Keep this quotation intact:\n'+quoted}},
      {type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'toolu_probe',name:'Read',input:{file_path:join(root,'fixture.txt')}}]}},
      {type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_probe',content:large}]}},
      {type:'assistant',message:{role:'assistant',content:'finished'}}
    ].map((r,i)=>({...r,uuid:`1234567${i}-1234-4123-8123-123456789abc`,cwd:root,sessionId:'12345678-1234-4123-8123-123456789abc',timestamp:`2026-01-01T00:00:0${i}Z`}));
    const src=join(root,'source.jsonl'), out=join(root,'out');
    writeFileSync(src, records.map(JSON.stringify).join('\n')+'\n');
    const r=spawnSync('python3',['-B',join(scripts,'make_context.py'),src,out],{encoding:'utf8'});
    assert.equal(r.status,0,r.stdout+r.stderr);
    const md=readFileSync(join(out,'HANDOFF.md'),'utf8');
    assert.ok(md.includes(quoted),'inline cited UUID must remain exact');
    const blobs=readdirSync(join(out,'blobs')).map(f=>readFileSync(join(out,'blobs',f),'utf8'));
    assert.ok(blobs.some(b=>b.includes('[tool_result] '+large+'\n')),'one blob must preserve the whole tool-result across chunk boundaries');
    const expanded = spawnSync('python3',['-B',join(scripts,'compact_context.py'),'expand',out],{encoding:'utf8'});
    assert.equal(expanded.status,0,expanded.stderr);
    assert.ok(expanded.stdout.includes(quoted),'CLI expand must preserve cited inline UUID');
    assert.ok(expanded.stdout.includes('[tool_result] '+large+'\n'),'CLI expand must preserve blob payload');
    const cut = spawnSync('python3',['-B',join(scripts,'make_context.py'),src,join(root,'cut.md'),'--cut'],{encoding:'utf8'});
    assert.equal(cut.status,0,cut.stdout+cut.stderr);
    assert.ok(readFileSync(join(root,'cut.md'),'utf8').includes(quoted),'cut mode must preserve quoted inline user text');
  } finally {rmSync(root,{recursive:true,force:true});}
});
