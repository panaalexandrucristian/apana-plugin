"""Source-derived oracles for OpenCode attachments, skills and bounded reading."""
import base64
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import compact_context as cc
import opencode_source as oc

SID = 'ses_fidelity000000000000000'
PDF = b'%PDF-1.4\noriginal\x00\xff\n%%EOF'
PNG = b'\x89PNG\r\n\x1a\n\x00\xfforiginal'
SKILL = '<skill_content name="Display name">\nAPI_TOKEN=abcdef1234567890\nKeep this instruction.\n</skill_content>'

FIXED_CLOCK = '''import datetime,runpy,sys
class Fixed(datetime.datetime):
    @classmethod
    def now(cls,tz=None):
        value=cls(2026,1,1,10,0)
        return value if tz is None else value.astimezone(tz)
datetime.datetime=Fixed
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name="__main__")
'''


def claude_archive(script, root, flags):
    """Clock-frozen archive bytes; normalize only the temporary fixture root.

    CLI size statistics depend on the source path's length in --cut mode, so
    stdout is covered by the CLI tests rather than this portable archive hash.
    """
    sid = '11111111-1111-4111-8111-111111111111'
    base = {'sessionId': sid, 'isSidechain': False, 'cwd': '/example', 'userType': 'external', 'version': '2.1.0'}
    source = []
    for i, (role, content, extra) in enumerate([
        ('user', 'Please continue.\n' + ('日本語🙂' * 40 + '\n') * 520, {}),
        ('assistant', [{'type': 'tool_use', 'id': 'toolu_example', 'name': 'Skill', 'input': {'skill': 'example'}}], {}),
        ('user', [{'type': 'tool_result', 'tool_use_id': 'toolu_example', 'content': 'Launching skill: example'}], {}),
        ('user', 'Base directory for this skill: /example/skills/example\n' + 'Keep these instructions.\n' * 50, {'isMeta': True, 'sourceToolUseID': 'toolu_example'}),
        ('assistant', [{'type': 'text', 'text': 'The implementation is pending.'}], {}),
    ], 1):
        source.append({**base, 'uuid': '00000000-0000-4000-8000-%012d' % i, 'type': role,
                       'timestamp': '2026-01-01T09:00:00Z', 'message': {'role': role, 'content': content}, **extra})
    session = root / (sid + '.jsonl')
    session.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in source) + '\n')
    out = root / ('out-' + ('-'.join(flags) or 'default'))
    result = subprocess.run([sys.executable, '-B', '-c', FIXED_CLOCK, str(script), str(session), str(out), *flags], capture_output=True, text=True,
                            env=dict(os.environ, HOME=str(root / 'home'), XDG_DATA_HOME=str(root / 'xdg')), timeout=90)
    if result.returncode: raise AssertionError(result.stderr)
    files = {str(p.relative_to(out)): p.read_bytes().replace(str(root).encode(), b'<ROOT>').decode() for p in sorted(out.rglob('*')) if p.is_file()}
    canonical = json.dumps(files, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def tool_skill(key='id', name='tool-skill', status='completed', text='Tool instructions.'):
    return {'type': 'tool', 'name': 'skill', 'state': {
        'input': {key: name}, 'status': status,
        'content': [{'type': 'text', 'text': text}]}}


def rows():
    files = [{'name': '../same.pdf', 'mime': mime, 'data': base64.b64encode(data).decode(),
              'source': source, 'mention': {'start': i, 'end': i + 1, 'text': label}}
             for i, (mime, data, source, label) in enumerate([
                 ('application/pdf', PDF, {'type': 'uri', 'uri': 'file:///gone.pdf'}, '[PDF 1]'),
                 ('image/png', PNG, {'type': 'inline'}, '[Image 1]')])]
    return [('user', {'text': 'Read [PDF 1] and [Image 1].', 'files': files, 'skills': [
        {'id': 'attached', 'name': 'Display name', 'text': SKILL, 'mention': {'text': '@attached', 'start': 0, 'end': 9}},
        {'id': 'empty', 'name': 'Empty'}]}, 3),
        ('assistant', {'content': [tool_skill('name'), tool_skill('id', 'attached', text='New version.'),
            tool_skill('id', 'failed', 'error'), tool_skill('id', 'pending', 'running'),
            tool_skill('id', 'compact-handoff'), tool_skill('id', 'tool-skill', text='Repeated version.')]}, 2)]


class Fidelity(unittest.TestCase):
    def setUp(self):
        # /tmp/handoff-* is reserved for archive paths by the generator's leak check.
        self.tmp = tempfile.TemporaryDirectory(prefix='opencode-fidelity-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / 'source.sqlite'
        self.env = dict(os.environ, HOME=str(self.root / 'home'), XDG_DATA_HOME=str(self.root / 'xdg'), PYTHONDONTWRITEBYTECODE='1')

    def database(self, source=None):
        oc.make_db(str(self.db), {SID: rows() if source is None else source})

    def cli(self, *flags, out='output', current=False):
        args = ['--current', 'handoff-marker-fidelity', '--opencode-db', str(self.db)] if current else ['--opencode', str(self.db), '--session', SID]
        if out is not None:
            args.append(str(self.root / out))
        return subprocess.run([sys.executable, '-B', str(SCRIPTS / 'make_context.py'), *args, *flags],
                              capture_output=True, text=True, env=self.env, timeout=90)

    def archive(self, folder='output'):
        folder = self.root / folder
        c, b, p = cc.read_out(str(folder))
        return cc.expand_text(c, b, p), b

    def test_user_files_and_skill_history_survive(self):
        self.database()
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = self.root / 'output'
        files = list((folder / 'attachments').iterdir())
        self.assertCountEqual([f.read_bytes() for f in files], [PDF, PNG])
        self.assertEqual(len({f.name for f in files}), 2)
        expanded, blobs = self.archive()
        for f in files:
            self.assertIn('attachments/' + f.name, expanded)
        for text in ('file:///gone.pdf', '[Image 1]', 'Display name', '@attached', oc.sanitize(SKILL),
                     'Tool instructions.', 'New version.', 'Repeated version.'):
            self.assertIn(text, expanded)
        self.assertNotIn('abcdef1234567890', expanded)
        self.assertTrue(any(oc.sanitize(SKILL) in b for b in blobs.values()))
        self.assertTrue((folder / 'read_handoff.py').is_file())
        self.assertIn('source inventory verified:', result.stdout)

    def test_skill_result_keeps_structured_blocks_and_separate_files(self):
        part = tool_skill()
        structured = {'type': 'resource', 'resource': {'uri': 'example:instructions', 'text': 'Additional instructions.'}}
        uri = 'data:image/png;base64,' + base64.b64encode(PNG).decode()
        part['state']['content'].extend([structured, {'type': 'file', 'mime': 'image/png', 'uri': uri}])
        part['state']['metadata'] = {'truncated': True}
        self.database([('assistant', {'content': [part]}, 0)])
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        expanded, blobs = self.archive()
        skill = next(text for text in blobs.values() if '[opencode skill result]' in text)
        self.assertIn('Tool instructions.', skill)
        self.assertIn(json.dumps(structured, ensure_ascii=False), skill)
        self.assertTrue(skill.endswith('\n(truncated)\n'))
        self.assertNotIn(uri, skill)
        self.assertEqual(sum(uri in text for text in blobs.values()), 1)
        self.assertIn(uri, expanded)

    def test_both_entry_points_list_and_choose_successful_skill_ids(self):
        source = rows()
        source[0][1]['text'] += ' handoff-marker-fidelity'
        self.database(source)
        for current in (False, True):
            with self.subTest(current=current):
                result = self.cli('--list-skills', out=None, current=current)
                self.assertEqual(result.returncode, 0, result.stderr)
                names = [line.split(' | ')[0] for line in result.stdout.splitlines() if line.startswith('skill: ')]
                self.assertEqual(names, ['skill: attached', 'skill: tool-skill'])
                for flags, expected in [((), ['attached', 'tool-skill']), (('--skills', 'tool-skill'), ['tool-skill']), (('--no-skills',), [])]:
                    folder = 'choice-' + str(current) + '-' + str(len(flags))
                    result = self.cli(*flags, current=current, out=folder)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    head = (self.root / folder / 'HANDOFF.md').read_text().split('\n---\n')[0]
                    for name in ('attached', 'tool-skill'):
                        self.assertEqual('`' + name + '`' in head, name in expected)
                    self.assertEqual('Skill-uri de încărcat din nou' in head, bool(expected))
                    self.assertIn('New version.', self.archive(folder)[0])
                for flags in [('--skills', 'unknown'), ('--skills', 'attached,'), ('--skills', 'attached', '--no-skills')]:
                    result = self.cli(*flags, current=current, out='invalid')
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((self.root / 'invalid').exists())

    def test_invalid_and_unsupported_sources_fail_before_ready(self):
        for case in ('invalid-base64', 'non-ascii', 'missing-data', 'media-user', 'media-tool', 'skill-message', 'parts', 'blob-ref'):
            with self.subTest(case=case):
                source = rows()
                if case in ('invalid-base64', 'non-ascii'):
                    source[0][1]['files'][0]['data'] = 'ab!?' if case == 'invalid-base64' else 'ăă'
                if case in ('missing-data', 'media-user'):
                    del source[0][1]['files'][0]['data']
                    if case == 'media-user': source[0][1]['files'][0]['uri'] = 'media:' + 'a' * 64
                if case == 'media-tool':
                    source[1][1]['content'][0]['state']['content'] = [{'type': 'file', 'uri': 'media:' + 'b' * 64}]
                if case == 'skill-message': source.append(('skill', {'skill': 'x', 'name': 'x', 'text': 'Not supported.'}, 0))
                if self.db.exists(): self.db.unlink()
                self.database(source)
                with closing(sqlite3.connect(self.db)) as c, c:
                    if case == 'parts':
                        c.execute('create table session_part(session_id TEXT, message_id TEXT, data TEXT)')
                        c.execute('insert into session_part values (?, ?, ?)', (SID, 'message', '{}'))
                    if case == 'blob-ref':
                        c.execute('create table blob_ref(session_id TEXT, hash TEXT)')
                        c.execute('insert into blob_ref values (?, ?)', (SID, 'hash'))
                result = self.cli(out=case)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn('ready:', result.stdout)
                self.assertFalse((self.root / case).exists())

    def test_inventory_is_independent_of_rendered_records(self):
        self.database()
        self.assertEqual(self.cli().returncode, 0)
        with closing(oc.connect(str(self.db))) as c:
            expected = oc.source_inventory(c, SID)
        expanded, blobs = self.archive()
        check = lambda b: oc.check_inventory(expected, b, str(self.root / 'output'))
        self.assertEqual(check(blobs), [])
        for name, text in blobs.items():
            if '[opencode attachment]' in text or '[opencode skill' in text:
                missing = dict(blobs); del missing[name]
                self.assertTrue(check(missing), name)
                corrupt = dict(blobs); corrupt[name] = text.replace('opencode', 'BROKEN', 1)
                self.assertTrue(check(corrupt), name)
        attachment = next((self.root / 'output' / 'attachments').iterdir())
        attachment.write_bytes(b'corrupted')
        self.assertTrue(check(blobs))

    def test_generator_rejects_renderer_omissions_and_corruption(self):
        self.database()
        bootstrap = '''import runpy,sys
sys.path.insert(0,sys.argv[1]);import opencode_source as oc
original=oc.render
def damaged(conn,sid):
    rendered=original(conn,sid)
    if mode=="file": rendered.attachments.clear()
    elif mode=="order": rendered.skills=dict(reversed(list(rendered.skills.items())))
    else:
        record=next(r for r in rendered.recs if "[opencode skill attachment]" in r.text)
        if mode=="missing": rendered.recs.remove(record)
        else: record.text=record.text.replace("Keep this instruction.","Corrupted instruction.")
    return rendered
oc.render=damaged
mode=sys.argv[2];sys.argv=sys.argv[3:];runpy.run_path(sys.argv[0],run_name="__main__")
'''
        for mode in ('file', 'order', 'missing', 'corrupted'):
            result = subprocess.run([sys.executable, '-B', '-c', bootstrap, str(SCRIPTS), mode,
                str(SCRIPTS / 'make_context.py'), '--opencode', str(self.db), str(self.root / mode)],
                capture_output=True, text=True, env=self.env, timeout=90)
            self.assertNotEqual(result.returncode, 0, mode)
            self.assertNotIn('ready:', result.stdout)
            self.assertIn('inventory', result.stderr)

    def test_unrelated_external_storage_does_not_block_selected_session(self):
        self.database()
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('create table session_part(session_id TEXT)')
            c.execute("insert into session_part values ('other')")
            c.execute('create table blob_ref(session_id TEXT)')
            c.execute("insert into blob_ref values ('other')")
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_inventory_and_render_share_a_read_snapshot(self):
        self.database()
        with closing(sqlite3.connect(self.db)) as writer, writer:
            writer.execute('PRAGMA journal_mode=WAL')
            c = oc.connect(str(self.db))
            self.addCleanup(c.close)
            c.execute('BEGIN')
            expected = oc.source_inventory(c, SID)
            writer.execute('delete from session_message where session_id=?', (SID,)); writer.commit()
            rendered = oc.render(c, SID)
            self.assertIn(oc.sanitize(SKILL), rendered.text)
            self.assertEqual(expected, oc.source_inventory(c, SID))

    def test_generator_keeps_snapshot_when_source_changes_between_passes(self):
        self.database()
        with closing(sqlite3.connect(self.db)) as c: c.execute('PRAGMA journal_mode=WAL')
        bootstrap = '''import runpy,sys,sqlite3
sys.path.insert(0,sys.argv[1]);import opencode_source as oc
original=oc.render;database=sys.argv[2]
def changed(conn,sid):
    writer=sqlite3.connect(database)
    writer.execute("delete from session_message where session_id=?",(sid,));writer.commit();writer.close()
    return original(conn,sid)
oc.render=changed
sys.argv=sys.argv[3:];runpy.run_path(sys.argv[0],run_name="__main__")
'''
        result = subprocess.run([sys.executable, '-B', '-c', bootstrap, str(SCRIPTS), str(self.db),
            str(SCRIPTS / 'make_context.py'), '--opencode', str(self.db), str(self.root / 'output')],
            capture_output=True, text=True, env=self.env, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(oc.sanitize(SKILL), self.archive()[0])

    def test_moving_then_copying_as_parent_preserves_attachments_and_reader(self):
        self.database()
        self.assertEqual(self.cli(out='handoff-12345678-20260101-source').returncode, 0)
        moved = self.root / 'moved' / 'handoff-12345678-20260101-source'
        moved.parent.mkdir()
        shutil.move(str(self.root / moved.name), moved)
        from parent_copy import copy_parents
        copied = Path(copy_parents([str(moved / 'HANDOFF.md')], str(self.root / 'parents'))[0][1])
        for path in [*moved.glob('attachments/*'), moved / 'read_handoff.py']:
            self.assertEqual((copied.parent / path.relative_to(moved)).read_bytes(), path.read_bytes())

    def test_claude_code_output_matches_pre_change_baseline(self):
        # Captured with the unmodified scripts at 2d78aab, not the implementation under test.
        expected = {
            (): 'd16b9fec292f8c8687b70684ffc0448d229d5a6904587279ca2ced5738e7dde1',
            ('--no-skills',): 'b95fb61d88cd6b50a5d80b1f8d742aa1fa03b58bd9a3d0c8a5a77481daf04b04',
            ('--skills', 'example'): 'd16b9fec292f8c8687b70684ffc0448d229d5a6904587279ca2ced5738e7dde1',
            ('--cut',): '8d1beb12f55cc5e6762dc69a578ce46f25132e929e737246d3b5f4cce6c39ff9',
        }
        for flags, digest in expected.items():
            with self.subTest(flags=flags):
                self.assertEqual(claude_archive(SCRIPTS / 'make_context.py', self.root, flags), digest)


class Reader(unittest.TestCase):
    def test_generated_plan_covers_actual_lines_and_visible_utf8_budget(self):
        import read_handoff as reader
        lines = reader.text_lines(('日本語🙂' * 80 + '\n') * 520 + ('x' * 1997 + '🙂🙂\n') * 40 + 'x' * 70000 + '\n')
        plan = reader.reading_plan(lines)
        next_line = 1
        for offset, count in plan:
            self.assertEqual(offset, next_line)
            self.assertLessEqual(count, 400)
            visible = ''
            for i, line in enumerate(lines[offset - 1:offset - 1 + count], offset):
                units = line.rstrip('\n').encode('utf-16-le')
                rendered = units[:4000].decode('utf-16-le', errors='replace')
                if len(units) > 4000: rendered += '... (line truncated to 2000 chars)'
                visible += '%d: %s\n' % (i, rendered)
            self.assertLessEqual(len(visible.encode()), reader.READ_BUDGET)
            next_line += count
        self.assertEqual(next_line, len(lines) + 1)

    def test_recovery_from_generated_note_and_blob_and_cli_errors(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); db = root / 'db.sqlite'; out = root / 'out'
            line = '🙂ă' * 20000 + ' FINAL INSTRUCTION: ask before editing.'
            source = [('user', {'text': line}, 1), ('assistant', {'content': [
                {'type': 'tool', 'name': 'read', 'state': {'input': {'path': 'example'}, 'status': 'completed',
                    'content': [{'type': 'text', 'text': line}]}}]}, 0)]
            oc.make_db(str(db), {SID: source})
            result = subprocess.run([sys.executable, '-B', str(SCRIPTS / 'make_context.py'), '--opencode', str(db), str(out)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            recovered = []
            for path in [out / 'HANDOFF.md', *sorted((out / 'blobs').glob('R*.txt'))]:
                for number, raw in enumerate(path.read_text().splitlines(keepends=True), 1):
                    if len(raw) <= 2000: continue
                    cursor = {'line': number, 'column': 0}; parts = []
                    while cursor:
                        r = subprocess.run([sys.executable, '-B', str(out / 'read_handoff.py'), str(path), '--line', str(cursor['line']), '--column', str(cursor['column']), '--stop-line', str(number)], capture_output=True, text=True)
                        self.assertEqual(r.returncode, 0, r.stderr)
                        page = [json.loads(x) for x in r.stdout.splitlines()]
                        parts.extend(x['text'] for x in page[:-1]); cursor = page[-1]['next']
                    self.assertEqual(''.join(parts), raw)
                    recovered.append(path.name)
            self.assertIn('HANDOFF.md', recovered)
            self.assertTrue(any(name.startswith('R') for name in recovered))
            for file, flags in [(out / 'missing', []), (out / 'HANDOFF.md', ['--line', '0'])]:
                r = subprocess.run([sys.executable, '-B', str(out / 'read_handoff.py'), str(file), *flags], capture_output=True, text=True)
                self.assertEqual(r.returncode, 2)
                self.assertIn('read_handoff:', r.stderr)

    def test_lossless_bounded_pages_and_line_only_recovery(self):
        spec = importlib.util.spec_from_file_location('read_handoff', SCRIPTS / 'read_handoff.py')
        reader = importlib.util.module_from_spec(spec); spec.loader.exec_module(reader)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'HANDOFF.md'
            for text in ('', 'short', 'a\r\nb\n', '🙂日本語ă"\\\t' * 9000 + '\r\nlast\n'):
                with self.subTest(size=len(text)):
                    p.write_bytes(text.encode())
                    cursor = {'line': 1, 'column': 0}; recovered = []
                    while cursor:
                        page = reader.read_page(str(p), **cursor)
                        self.assertLessEqual(len(page.encode()), reader.MAX_RESPONSE_BYTES)
                        self.assertTrue(all(len(line) < 2000 for line in page.splitlines()))
                        records = [json.loads(line) for line in page.splitlines()]
                        recovered.extend(r['text'] for r in records[:-1])
                        previous = cursor; cursor = records[-1]['next']
                        if cursor: self.assertGreater((cursor['line'], cursor['column']), (previous['line'], previous['column']))
                    self.assertEqual(''.join(recovered), text)
            p.write_bytes(b'first\r\nsecond\nthird')
            records = [json.loads(x) for x in reader.read_page(str(p), line=2, stop_line=2).splitlines()]
            self.assertEqual(''.join(r['text'] for r in records[:-1]), 'second\n')
            self.assertIsNone(records[-1]['next'])
            self.assertFalse(records[-1]['eof'])
            for kwargs in ({'line': 0}, {'column': -1}, {'line': 99}, {'column': 99}, {'line': 2, 'stop_line': 1}):
                with self.assertRaises(ValueError): reader.read_page(str(p), **kwargs)


if __name__ == '__main__':
    unittest.main(warnings='ignore')  # existing compact_context readers use open(...).read()
