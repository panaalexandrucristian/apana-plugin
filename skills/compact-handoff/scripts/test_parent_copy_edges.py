#!/usr/bin/env python3
"""Regression checks for provenance, ownership, publication and path validation.
Offline stdlib fixtures are isolated in TMPDIR and cleaned up after each run.
Exit 1 means at least one expected preservation/fail-closed invariant failed.
"""
import argparse
import ast
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import traceback
from unittest.mock import patch

sys.dont_write_bytecode = True
DEFAULT = Path(__file__).resolve().parent
SCRATCH = Path(tempfile.gettempdir())
CASES = {}


def case(fn):
    CASES[fn.__name__] = fn
    return fn


def require(value, message):
    if not value:
        raise AssertionError(message)


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def manifest(root):
    result = {}
    for p in sorted(root.rglob('*')):
        mode = p.lstat().st_mode
        result[str(p.relative_to(root))] = {'mode': stat.S_IMODE(mode), 'symlink': os.readlink(p)} if p.is_symlink() else {'mode': stat.S_IMODE(mode), 'sha256': digest(p) if p.is_file() else None}
    return result


def load(scripts):
    sys.path.insert(0, str(scripts))
    spec = importlib.util.spec_from_file_location('parent_copy', scripts / 'parent_copy.py')
    assert spec is not None and spec.loader is not None
    helper = importlib.util.module_from_spec(spec)
    sys.modules['parent_copy'] = helper
    spec.loader.exec_module(helper)
    spec = importlib.util.spec_from_file_location('make_context_review', scripts / 'make_context.py')
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    tree = ast.parse((scripts / 'make_context.py').read_bytes())
    require(ast.unparse(tree.body[-1]) == "if '--selftest' in sys.argv:\n    selftest()\nelse:\n    main()", 'Unexpected final dispatcher')
    tree.body.pop()
    exec(compile(tree, str(scripts / 'make_context.py'), 'exec'), module.__dict__)
    return helper, module


class Env:
    def __init__(self, root, helper, generator):
        self.root, self.h, self.m = root, helper, generator
        self.src = root / 'src'
        self.src.mkdir()
        self.dest = root / 'out' / 'parents'
        self.evidence = {}

    def handoff(self, path, label, refs=(), loose=(), newline=b'\n'):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        copies = [(str(p), str(p) if ok else None, ok) for p, ok in refs]
        intro = self.m.build_intro(False, '12345678', '2026-01-01 00:00', '/synthetic/source.jsonl', True, self.m.parents_paragraph(copies, str(path.parent)))
        body = b'\nBODY:' + label.encode() + b'\r\n`parents/do-not-rewrite/HANDOFF.md`\n\xff\x00---\nEND'
        path.write_bytes(intro.encode().replace(b'\n', newline) + body)
        for rel, data in loose:
            f = path.parent / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(data)
        return path

    def copy(self, roots, dest=None):
        before = manifest(self.src)
        try:
            result = self.h.copy_parents([str(p) for p in roots], str(dest or self.dest))
        finally:
            require(before == manifest(self.src), 'Sources changed')
        require(all(x[2] for x in result), 'Existing source reported absent')
        return [Path(x[1]) for x in result]

    def refs(self, md):
        # Independent actual-generator parser, skip ONLY the notice attached
        # immediately to this token rather than searching ahead across tokens.
        raw = md.read_bytes().split(b'\n---\n', 1)[0].split(b'\r\n---\r\n', 1)[0]
        prefix = 'Părintele este păstrat întreg în: '.encode()
        lines = [line for line in raw.splitlines() if prefix in line]
        refs = []
        for line in lines:
            for match in re.finditer(br'`([^`]+)`', line.split(prefix, 1)[1]):
                # Match offsets belong to the suffix, not the full line.
                suffix = line.split(prefix, 1)[1]
                if suffix[match.end():].startswith(b' (nu mai exista'):
                    continue
                refs.append((md.parent / os.fsdecode(match.group(1))).resolve())
        return refs

    def body(self, md):
        raw = md.read_bytes()
        return raw[raw.index(b'\nBODY:'):]

    def expect_edge(self, out, original):
        refs = self.refs(out)
        self.evidence.setdefault('edges', []).append({'from': str(out), 'resolved': [str(p) for p in refs], 'expected_body_sha256': hashlib.sha256(self.body(original)).hexdigest()})
        require(len(refs) == 1, 'Expected one real provenance edge, got %r' % refs)
        require(refs[0].is_file(), 'Dangling real provenance edge: %s' % refs[0])
        require(self.dest in refs[0].parents, 'Provenance outside destination: %s' % refs[0])
        require(self.body(refs[0]) == self.body(original), 'WRONG PARENT BODY: %s resolves to %s' % (out, refs[0]))
        return refs[0]

    def reject(self, fn, description):
        try:
            fn()
        except (ValueError, OSError) as exc:
            self.evidence['rejection'] = '%s: %s' % (type(exc).__name__, exc)
        else:
            raise AssertionError('Unsupported input accepted: ' + description)


@case
def generated_provenance_one_present_one_missing(e):
    p = e.src / 'root' / 'HANDOFF.md'
    q = e.handoff(p.parent / 'parents' / 'a' / 'HANDOFF.md', 'child')
    e.handoff(p, 'root', [(q, True), (Path('/absent/x.md'), False)])
    out = e.copy([p])[0]
    e.expect_edge(out, q)


@case
def generated_missing_notice_collision(e):
    a = e.src / 'a' / 'HANDOFF.md'
    b = e.src / 'b' / 'HANDOFF.md'
    qa = e.handoff(a.parent / 'parents' / 'same' / 'HANDOFF.md', 'ancestor-A')
    qb = e.handoff(b.parent / 'parents' / 'same' / 'HANDOFF.md', 'ancestor-B')
    e.handoff(a, 'A', [(qa, True), (Path('/absent/x.md'), False)])
    e.handoff(b, 'B', [(qb, True), (Path('/absent/x.md'), False)])
    oa, ob = e.copy([a, b])
    e.expect_edge(oa, qa)
    e.expect_edge(ob, qb)


@case
def generated_missing_notice_recopy_alias(e):
    root = e.src / 'root' / 'HANDOFF.md'
    child = e.handoff(root.parent / 'parents' / 'same' / 'HANDOFF.md', 'actual-child')
    e.handoff(root, 'root', [(child, True), (Path('/absent/x.md'), False)])
    first = e.copy([root])[0]
    conflicting = e.handoff(e.src / 'unrelated' / 'same' / 'HANDOFF.md', 'unrelated')
    second_dest = e.root / 'second' / 'parents'
    e.copy([conflicting], second_dest)
    second = e.copy([first], second_dest)[0]
    e.dest = second_dest
    e.expect_edge(second, child)


@case
def generated_long_names_missing_notice_control(e):
    a = e.src / 'a' / 'HANDOFF.md'
    b = e.src / 'b' / 'HANDOFF.md'
    name = 'handoff-12345678-20260101-' + 'long' * 20
    qa = e.handoff(a.parent / 'parents' / name / 'HANDOFF.md', 'ancestor-A')
    qb = e.handoff(b.parent / 'parents' / name / 'HANDOFF.md', 'ancestor-B')
    # Missing filename >70 bytes keeps its notice out of the earlier token's window.
    missing = Path('/absent/' + name + '.md')
    e.handoff(a, 'A', [(qa, True), (missing, False)])
    e.handoff(b, 'B', [(qb, True), (missing, False)])
    oa, ob = e.copy([a, b])
    e.expect_edge(oa, qa)
    e.expect_edge(ob, qb)


@case
def generated_multiple_present_parents(e):
    p = e.src / 'root' / 'HANDOFF.md'
    q = e.handoff(p.parent / 'parents' / 'a' / 'HANDOFF.md', 'child-A')
    r = e.handoff(p.parent / 'parents' / 'b' / 'HANDOFF.md', 'child-B')
    e.handoff(p, 'root', [(q, True), (r, True)])
    out = e.copy([p])[0]
    got = e.refs(out)
    require(len(got) == 2, 'Lost real generated edges')
    require([e.body(g) for g in got] == [e.body(q), e.body(r)], 'Wrong generated parent bodies')


@case
def opaque_sidecar_metadata_survives_relocation(e):
    root = e.handoff(e.src / 'root' / 'HANDOFF.md', 'root', loose=[('parents/archive/bytes.bin', b'opaque\xff\x00'), ('parents/orphan.md', b'opaque md')])
    first = e.copy([root])[0]
    moved = e.root / 'moved'
    shutil.move(str(e.dest), moved)
    second = e.copy([moved / first.parent.name / first.name], e.root / 'second' / 'parents')[0]
    values = [p.read_bytes() for p in second.parent.parent.rglob('*') if p.is_file()]
    require(b'opaque\xff\x00' in values and b'opaque md' in values, 'Unlinked data lost after relocation')


@case
def legacy_metadata_pair_retry_after_index_publish(e):
    root = e.handoff(e.src / 'handoff-12345678-20260101-legacy.md', 'legacy')
    side = root.with_name(root.stem + '-parents')
    side.mkdir()
    (side / 'data.bin').write_bytes(b'LOOSE')
    original = e.h.os.link
    fired = []
    def interrupt(src, dst, *args, **kwargs):
        if Path(dst).suffix == '.md' and not fired:
            fired.append(str(dst))
            raise OSError('injected after companion, before md publication')
        return original(src, dst, *args, **kwargs)
    with patch.object(e.h.os, 'link', interrupt):
        e.reject(lambda: e.copy([root]), 'injected publication fault')
    require(fired, 'Fault not reached')
    indexes = list(e.dest.glob('.handoff-parent-storage-*.json'))
    require(len(indexes) == 1 and not list(e.dest.glob('*.md')), 'Unexpected interruption position')
    out = e.copy([root])[0]
    require(e.body(out) == e.body(root), 'Legacy body changed')
    before = manifest(e.dest)
    e.copy([root])
    require(before == manifest(e.dest), 'Completed pair retry non-idempotent')
    new = e.root / 'recopy'
    e.copy([out], new)
    require(any(p.read_bytes() == b'LOOSE' for p in new.rglob('*') if p.is_file()), 'Metadata loose dependency lost')


@case
def partial_legacy_metadata_never_overwritten(e):
    root = e.handoff(e.src / 'handoff-12345678-20260101-legacy.md', 'legacy')
    side = root.with_name(root.stem + '-parents')
    side.mkdir()
    (side / 'data.bin').write_bytes(b'LOOSE')
    e.dest.mkdir(parents=True)
    index = e.h._storage_path(e.dest / root.name, False)
    index.write_bytes(b'{PARTIAL')
    out = e.copy([root])[0]
    require(out.name != root.name, 'Invalid companion was reused')
    require(index.read_bytes() == b'{PARTIAL', 'Partial old index overwritten')
    second = e.root / 'recopy'
    e.copy([out], second)
    require(any(p.read_bytes() == b'LOOSE' for p in second.rglob('*') if p.is_file()), 'Aliased companion ownership lost')


@case
def retry_after_folder_publication(e):
    p = e.src / 'root' / 'HANDOFF.md'
    q = e.handoff(p.parent / 'parents' / 'child' / 'HANDOFF.md', 'child')
    e.handoff(p, 'root', [(q, True)])
    original = e.h.os.rename
    calls = []
    def interrupt(src, dst, *args, **kwargs):
        result = original(src, dst, *args, **kwargs)
        calls.append(str(dst))
        if len(calls) == 1:
            raise OSError('injected immediately after folder publication')
        return result
    with patch.object(e.h.os, 'rename', interrupt):
        e.reject(lambda: e.copy([p]), 'injected rename fault')
    require(calls, 'Fault not reached')
    out = e.copy([p])[0]
    e.expect_edge(out, q)
    before = manifest(e.dest)
    e.copy([p])
    require(before == manifest(e.dest), 'Retry after publication not idempotent')


@case
def readonly_directory_and_nested_payload_retry(e):
    p = e.src / 'root' / 'HANDOFF.md'
    q = e.handoff(p.parent / 'parents' / 'child' / 'HANDOFF.md', 'child', loose=[('blobs/deep/raw.bin', b'raw')])
    e.handoff(p, 'root', [(q, True)])
    for f in (q, q.parent / 'blobs' / 'deep' / 'raw.bin', p):
        f.chmod(0o400)
    for d in (q.parent / 'blobs' / 'deep', q.parent / 'blobs', q.parent, p.parent):
        d.chmod(0o500)
    out = e.copy([p])[0]
    e.expect_edge(out, q)
    before = manifest(e.dest)
    e.copy([p])
    require(before == manifest(e.dest), 'Read-only retry changed output')


@case
def canonical_missing_nested_provenance_rejected(e):
    p = e.handoff(e.src / 'root' / 'HANDOFF.md', 'root', [(e.src / 'gone' / 'HANDOFF.md', True)])
    e.reject(lambda: e.copy([p]), 'missing canonical ancestor')
    require(not e.dest.exists(), 'Published before graph discovery complete')


@case
def provenance_cycle_rejected(e):
    a = e.src / 'a' / 'HANDOFF.md'
    b = e.src / 'b' / 'HANDOFF.md'
    e.handoff(a, 'A', [(b, True)])
    e.handoff(b, 'B', [(a, True)])
    e.reject(lambda: e.copy([a]), 'provenance cycle')
    require(not e.dest.exists(), 'Published cyclic graph')


@case
def symlink_source_and_payload_rejected(e):
    q = e.handoff(e.src / 'real' / 'HANDOFF.md', 'real')
    link = e.src / 'link'
    link.symlink_to(q.parent, target_is_directory=True)
    e.reject(lambda: e.copy([link / 'HANDOFF.md']), 'symlink in source')
    p = e.handoff(e.src / 'root' / 'HANDOFF.md', 'root')
    (p.parent / 'blob-link').symlink_to(q)
    e.reject(lambda: e.copy([p]), 'symlink in payload')
    require(not e.dest.exists(), 'Published symlink graph')


@case
def symlink_dotdot_cannot_select_different_source(e):
    lexical = e.handoff(e.src / 'local' / 'HANDOFF.md', 'LEXICAL-WRONG')
    intended = e.handoff(e.src / 'outside' / 'local' / 'HANDOFF.md', 'PHYSICAL-INTENDED')
    (e.src / 'outside' / 'anchor').mkdir()
    (e.src / 'link').symlink_to(e.src / 'outside' / 'anchor', target_is_directory=True)
    input_path = e.src / 'link' / '..' / 'local' / 'HANDOFF.md'
    require(input_path.read_bytes() == intended.read_bytes(), 'Fixture physical path is wrong')
    e.evidence['input_path'] = str(input_path)
    e.evidence['physical'] = str(input_path.resolve())
    e.evidence['lexical'] = str(lexical)
    e.reject(lambda: e.copy([input_path]), 'symlink hidden by lexical .. normalization')


@case
def metadata_traversal_rejected(e):
    p = e.handoff(e.src / 'root' / 'HANDOFF.md', 'root')
    (p.parent / '.handoff-parent-storage.json').write_text(json.dumps({'format': 'handoff-parent-storage-v1', 'entries': [{'name': '../escape', 'kind': 'opaque'}]}))
    e.reject(lambda: e.copy([p]), 'metadata path traversal')
    require(not e.dest.exists(), 'Published invalid index')


@case
def metadata_self_cycle_opaque_directory_rejected(e):
    p = e.handoff(e.src / 'root' / 'HANDOFF.md', 'root')
    (p.parent / '.handoff-parent-storage.json').write_text(json.dumps({'format': 'handoff-parent-storage-v1', 'entries': [{'name': 'root', 'kind': 'opaque'}]}))
    e.reject(lambda: e.copy([p]), 'metadata self-cycle disguised as opaque directory')


@case
def metadata_opaque_role_cannot_mask_real_handoff(e):
    root = e.src / 'root' / 'HANDOFF.md'
    child = e.src / 'handoff-12345678-20260101-child.md'
    grand = e.handoff(e.src / 'grand' / 'HANDOFF.md', 'grand')
    e.handoff(child, 'child', [(grand, True)])
    e.handoff(root, 'root', [(child, True)])
    (root.parent / '.handoff-parent-storage.json').write_text(json.dumps({'format': 'handoff-parent-storage-v1', 'entries': [{'name': child.name, 'kind': 'opaque'}]}))
    # Either reject this inconsistent index or fully preserve the real edge.
    try:
        out = e.copy([root])[0]
    except (ValueError, OSError) as exc:
        e.evidence['rejection'] = str(exc)
        return
    copied_child = e.expect_edge(out, child)
    e.expect_edge(copied_child, grand)


@case
def metadata_opaque_role_cannot_mask_selected_root(e):
    root = e.src / 'root' / 'HANDOFF.md'
    child = e.src / 'handoff-12345678-20260101-child.md'
    grand = e.handoff(e.src / 'grand' / 'HANDOFF.md', 'grand')
    e.handoff(child, 'child', [(grand, True)])
    e.handoff(root, 'root')
    (root.parent / '.handoff-parent-storage.json').write_text(json.dumps({'format': 'handoff-parent-storage-v1', 'entries': [{'name': child.name, 'kind': 'opaque'}]}))
    try:
        out = e.copy([root, child])[1]
    except (ValueError, OSError) as exc:
        e.evidence['rejection'] = str(exc)
        return
    e.expect_edge(out, grand)


@case
def absolute_external_same_basename_not_false_cycle(e):
    a = e.src / 'a' / 'handoff-12345678-20260101-same' / 'HANDOFF.md'
    b = e.handoff(e.src / 'b' / a.parent.name / 'HANDOFF.md', 'ancestor')
    e.handoff(a, 'root', [(b, True)])
    relative = os.fsencode(os.path.relpath(b, a.parent))
    a.write_bytes(a.read_bytes().replace(b'`' + relative + b'`', b'`' + os.fsencode(b) + b'`'))
    out = e.copy([a])[0]
    e.expect_edge(out, b)


@case
def readonly_empty_leaf_directory(e):
    p = e.handoff(e.src / 'root' / 'HANDOFF.md', 'root')
    p.parent.chmod(0o500)
    out = e.copy([p])[0]
    require(e.body(out) == e.body(p), 'Read-only leaf body changed')


@case
def main_generated_missing_notice_collision(e):
    import contextlib
    import io
    a = e.src / 'handoff-11111111-20260101-a' / 'HANDOFF.md'
    b = e.src / 'handoff-22222222-20260101-b' / 'HANDOFF.md'
    common = 'handoff-33333333-20260101-shared'
    qa = e.handoff(a.parent / 'parents' / common / 'HANDOFF.md', 'ancestor-A')
    qb = e.handoff(b.parent / 'parents' / common / 'HANDOFF.md', 'ancestor-B')
    missing = e.src / 'gone' / 'HANDOFF.md'
    e.handoff(a, 'A', [(qa, True), (missing, False)])
    e.handoff(b, 'B', [(qb, True), (missing, False)])
    # All handoffs in this E2E fixture are valid UTF-8, like real output.
    for md in (a, b, qa, qb):
        md.write_bytes(md.read_bytes().replace(b'\xff\x00', b'UTF8'))
    sid = '12345678-1234-4123-8123-123456789abc'
    rows = []
    messages = [('user', 'Continue from both saved handoffs.'),
                ('assistant', [{'type': 'tool_use', 'id': 'read-a', 'name': 'Read', 'input': {'file_path': str(a)}},
                               {'type': 'tool_use', 'id': 'read-b', 'name': 'Read', 'input': {'file_path': str(b)}}]),
                ('user', [{'type': 'tool_result', 'tool_use_id': 'read-a', 'content': a.read_text()},
                          {'type': 'tool_result', 'tool_use_id': 'read-b', 'content': b.read_text()}]),
                ('assistant', 'Synthetic offline replay.')]
    previous = None
    for i, (role, content) in enumerate(messages):
        rid = '%08x-1234-4123-8123-123456789abc' % i
        rows.append({'type': role, 'uuid': rid, 'parentUuid': previous, 'sessionId': sid,
                     'cwd': str(e.root), 'timestamp': '2026-01-01T00:00:0%dZ' % i,
                     'message': {'role': role, 'content': content}})
        previous = rid
    session = e.src / (sid + '.jsonl')
    session.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))
    before = manifest(e.src)
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.object(sys, 'argv', [e.m.__file__, str(session), str(e.dest.parent), '--no-opencode']), \
            patch.object(tempfile, 'tempdir', str(SCRATCH)), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            e.m.main()
        finally:
            (e.root / 'main.stdout.txt').write_text(stdout.getvalue())
            (e.root / 'main.stderr.txt').write_text(stderr.getvalue())
    require(manifest(e.src) == before, 'Main changed sources')
    e.evidence['stdout'] = str(e.root / 'main.stdout.txt')
    e.evidence['reported_ready'] = 'ready:' in stdout.getvalue()
    e.evidence['reported_roundtrip_identical'] = 'roundtrip IDENTICAL' in stdout.getvalue()
    require(e.evidence['reported_ready'] and e.evidence['reported_roundtrip_identical'], 'Generator did not report success')
    e.expect_edge(e.dest / a.parent.name / a.name, qa)
    e.expect_edge(e.dest / b.parent.name / b.name, qb)


def index(e, root, rows):
    p = e.h._storage_path(root, root.name == 'HANDOFF.md')
    p.write_text(json.dumps({'format': 'handoff-parent-storage-v1', 'entries': rows}))

def reject_prepublication(e, roots):
    def action():
        copied = e.copy(roots)
        e.evidence['unexpected_success'] = {'roots': [str(p) for p in roots], 'returned': [str(p) for p in copied], 'published': manifest(e.dest)}
        e.evidence['published_indexes'] = {str(p.relative_to(e.dest)): json.loads(p.read_text()) for p in e.dest.rglob('.handoff-parent-storage*.json')}
        return copied
    e.reject(action, 'inconsistent metadata roles')
    require(not e.dest.exists(), 'Invalid graph published before rejection')

@case
def selected_handoff_then_opaque_metadata_rejected(e):
    child = e.handoff(e.src / 'handoff-12345678-20260101-child.md', 'child')
    root = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    index(e, root, [{'name': child.name, 'kind': 'opaque'}])
    reject_prepublication(e, [child, root])

@case
def contradictory_md_then_opaque_rows_rejected(e):
    child = e.handoff(e.src / 'handoff-12345678-20260101-child.md', 'child')
    root = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    index(e, root, [{'name': child.name, 'kind': 'md'}, {'name': child.name, 'kind': 'opaque'}])
    reject_prepublication(e, [root])

@case
def contradictory_opaque_then_md_rows_rejected(e):
    child = e.handoff(e.src / 'handoff-12345678-20260101-child.md', 'child')
    root = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    index(e, root, [{'name': child.name, 'kind': 'opaque'}, {'name': child.name, 'kind': 'md'}])
    reject_prepublication(e, [root])

@case
def opaque_directory_conflicts_with_selected_folder(e):
    child = e.handoff(e.src / 'child/HANDOFF.md', 'child')
    root = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    index(e, root, [{'name': child.parent.name, 'kind': 'opaque'}])
    reject_prepublication(e, [root, child])

@case
def opaque_directory_conflicts_with_provenance(e):
    grand = e.handoff(e.src / 'external/grand/HANDOFF.md', 'grand')
    child = e.handoff(e.src / 'child/HANDOFF.md', 'child', [(grand, True)])
    root = e.handoff(e.src / 'root/HANDOFF.md', 'root', [(child, True)])
    index(e, root, [{'name': child.parent.name, 'kind': 'opaque'}])
    reject_prepublication(e, [root])

@case
def readonly_after_publication_fault_restores_mode(e):
    p = e.handoff(e.src / 'root/HANDOFF.md', 'root', loose=[('blobs/raw.bin', b'unchanged')])
    p.chmod(0o400)
    p.parent.chmod(0o500)
    original = e.h.os.rename
    fired = []
    def fault(src, dst, *args, **kwargs):
        result = original(src, dst, *args, **kwargs)
        fired.append(str(dst))
        raise OSError('injected post-rename error')
    with patch.object(e.h.os, 'rename', fault):
        e.reject(lambda: e.copy([p]), 'post-rename interruption')
    require(len(fired) == 1, 'Fault injection not reached exactly once')
    out = Path(fired[0])
    require(stat.S_IMODE(out.stat().st_mode) == 0o500, 'Published inode mode not restored')
    require(stat.S_IMODE((out / 'HANDOFF.md').stat().st_mode) == 0o400, 'Handoff mode changed')
    before = manifest(e.dest)
    require(e.copy([p])[0] == out / 'HANDOFF.md', 'Retry did not reuse publication')
    require(manifest(e.dest) == before, 'Retry changed output bytes or modes')
    e.evidence['published_directory_mode'] = oct(stat.S_IMODE(out.stat().st_mode))

@case
def readonly_before_publication_fault_restores_staged_mode(e):
    p = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    p.parent.chmod(0o500)
    staged = []
    real_cleanup = e.h.tempfile.TemporaryDirectory.cleanup
    def fault(src, dst, *args, **kwargs):
        staged.append(Path(src))
        raise OSError('injected pre-rename error')
    def inspect_cleanup(temp):
        if staged:
            require(stat.S_IMODE(staged[0].stat().st_mode) == 0o500, 'Private staged mode not restored before cleanup')
        return real_cleanup(temp)
    with patch.object(e.h.os, 'rename', fault), patch.object(e.h.tempfile.TemporaryDirectory, 'cleanup', inspect_cleanup):
        e.reject(lambda: e.copy([p]), 'pre-rename interruption')
    require(len(staged) == 1, 'Fault not reached')
    require(not (e.dest / p.parent.name).exists(), 'Published despite pre-rename fault')
    out = e.copy([p])[0]
    require(stat.S_IMODE(out.parent.stat().st_mode) == 0o500, 'Successful retry mode changed')

@case
def opaque_readonly_directory_copy_mode_and_relocation(e):
    p = e.handoff(e.src / 'root/HANDOFF.md', 'root', loose=[('parents/archive/nested/data.bin', b'RAW\x00\xff')])
    archive = p.parent / 'parents/archive'
    (archive / 'nested/data.bin').chmod(0o400)
    (archive / 'nested').chmod(0o500)
    archive.chmod(0o500)
    out = e.copy([p])[0]
    copied_archive = e.dest / 'archive'
    require(stat.S_IMODE(copied_archive.stat().st_mode) == 0o500, 'Opaque output mode changed')
    require(stat.S_IMODE((copied_archive / 'nested').stat().st_mode) == 0o500, 'Nested output mode changed')
    moved = e.root / 'moved'
    shutil.move(str(e.dest), moved)
    e.copy([moved / out.parent.name / out.name], e.root / 'next/parents')
    require((e.root / 'next/parents/archive/nested/data.bin').read_bytes() == b'RAW\x00\xff', 'Opaque read-only bytes lost')

@case
def absolute_nested_same_name_relocation_uses_local_copy(e):
    name = 'handoff-12345678-20260101-same'
    p = e.src / 'old' / name / 'HANDOFF.md'
    q = e.handoff(p.parent / 'parents' / name / 'HANDOFF.md', 'ancestor')
    e.handoff(p, 'root', [(q, True)])
    rel = os.fsencode(os.path.relpath(q, p.parent))
    p.write_bytes(p.read_bytes().replace(b'`' + rel + b'`', b'`' + os.fsencode(q) + b'`'))
    moved = e.src / 'moved' / name
    moved.parent.mkdir()
    shutil.move(str(p.parent), moved)
    out = e.copy([moved / 'HANDOFF.md'])[0]
    e.expect_edge(out, moved / 'parents' / name / 'HANDOFF.md')

@case
def generated_crlf_missing_first_middle_last(e):
    p = e.src / 'root/HANDOFF.md'
    a = e.handoff(p.parent / 'parents/a/HANDOFF.md', 'a')
    b = e.handoff(p.parent / 'parents/b/HANDOFF.md', 'b')
    absent = Path('/absent/HANDOFF.md')
    e.handoff(p, 'root', [(absent, False), (a, True), (absent, False), (b, True), (absent, False)], newline=b'\r\n')
    out = e.copy([p])[0]
    refs = e.refs(out)
    require([e.body(x) for x in refs] == [e.body(a), e.body(b)], 'Present edges corrupted by neighboring missing tokens')
    require(e.body(out) == e.body(p), 'Body changed')

@case
def dotdot_after_regular_file_rejected(e):
    p = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    fake = e.src / 'not-a-directory'
    fake.write_bytes(b'file')
    e.reject(lambda: e.copy([fake / '..' / 'root/HANDOFF.md']), 'non-directory before dotdot')
    require(not e.dest.exists(), 'Invalid physical path was published')

@case
def relative_dotdot_without_symlink_still_works(e):
    p = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    directory = e.src / 'subdirectory'
    directory.mkdir()
    out = e.copy([directory / '..' / 'root/HANDOFF.md'])[0]
    require(e.body(out) == e.body(p), 'Valid dotdot path selected wrong body')


@case
def selected_folder_then_opaque_metadata_rejected(e):
    child = e.handoff(e.src / 'child/HANDOFF.md', 'child')
    root = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    index(e, root, [{'name': child.parent.name, 'kind': 'opaque'}])
    reject_prepublication(e, [child, root])


@case
def metadata_folder_roles_rejected_in_both_orders(e):
    child = e.handoff(e.src / 'child/HANDOFF.md', 'child')
    root = e.handoff(e.src / 'root/HANDOFF.md', 'root')
    for kinds in [('folder', 'opaque'), ('opaque', 'folder')]:
        index(e, root, [{'name': child.parent.name, 'kind': kind} for kind in kinds])
        reject_prepublication(e, [root])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scripts', type=Path, default=DEFAULT)
    parser.add_argument('--case', action='append')
    parser.add_argument('--quiet', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    names = args.case or list(CASES)
    require(not set(names) - set(CASES), 'Unknown cases')
    tracked = ['parent_copy.py', 'make_context.py', 'test_parent_preservation.py']
    hashes = {name: digest(args.scripts / name) for name in tracked}
    helper, generator = load(args.scripts)
    temp = tempfile.TemporaryDirectory(prefix='handoff-adversarial-', dir=str(SCRATCH))
    root = Path(temp.name)
    rows = []
    for name in names:
        fixture = root / name
        fixture.mkdir()
        e = Env(fixture, helper, generator)
        row = {'case': name, 'fixture': str(fixture)}
        try:
            CASES[name](e)
        except Exception as exc:
            row.update(status='FAIL', error='%s: %s' % (type(exc).__name__, exc), traceback=traceback.format_exc())
        else:
            row['status'] = 'PASS'
        row['evidence'] = e.evidence
        rows.append(row)
        if not args.quiet or row['status'] == 'FAIL':
            print(row['status'], name, row.get('error', ''), flush=True)
    require(hashes == {name: digest(args.scripts / name) for name in tracked}, 'Snapshot changed')
    result = {'python': sys.version, 'scripts': str(args.scripts), 'source_sha256': hashes, 'scratch': str(root), 'summary': dict(Counter(r['status'] for r in rows)), 'case_count': len(rows), 'results': rows}
    if args.report:
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print('SUMMARY', json.dumps(result['summary']))
    temp.cleanup()
    return int(any(r['status'] == 'FAIL' for r in rows))


if __name__ == '__main__':
    raise SystemExit(main())
