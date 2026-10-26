#!/usr/bin/env python3
"""Offline parent-copy preservation regressions; no provider credentials."""
import argparse
import ast
import contextlib
from collections import Counter
from dataclasses import dataclass, field
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import traceback
from unittest.mock import patch
import uuid

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent
SOURCES = {'candidate': SCRIPTS / 'make_context.py'}
CASES = {}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inventory(path):
    return {str(p.relative_to(path)): digest(p) for p in sorted(path.rglob('*')) if p.is_file()}


def case(fn):
    CASES[fn.__name__] = fn
    return fn


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Skip(Exception):
    """The case needs a condition this system cannot produce."""


@dataclass
class Node:
    md: Path
    identity: str
    children: list = field(default_factory=list)
    assets: dict = field(default_factory=dict)
    newline: str = '\n'
    delim: bool = True
    refstyle: str = 'backticks'
    absolute: bool = False
    body_identity: str = ''

    @property
    def folder(self):
        return self.md.name == 'HANDOFF.md'

    @property
    def side(self):
        return self.md.parent / 'parents' if self.folder else self.md.with_name(self.md.stem + '-parents')

    @property
    def body(self):
        # Deliberately contains paths, a second separator, Unicode and CR bytes.
        return (f'BODY:{self.body_identity or self.identity}\n'
                'history only: `parents/no-rewrite/HANDOFF.md` and `blobs/R0000.txt`\n'
                'diacritics ăâîșț 日本語 🙂\r\n---\nend without trailing newline').encode()

    def write(self):
        self.md.parent.mkdir(parents=True, exist_ok=True)
        lines = ['# Handoff', 'Fixture: ' + self.identity]
        for i, child in enumerate(self.children):
            ref = str(child.md) if self.absolute else os.path.relpath(child.md, self.md.parent)
            if self.refstyle == 'backticks':
                lines.append(f'PARENT {i}: `{ref}`')
            elif self.refstyle == 'markdown':
                lines.append(f'PARENT {i}: [handoff]({ref})')
            else:
                lines.append(f'PARENT {i}: {ref}')
        for name in self.assets:
            lines.append('ASSET: `' + ((str(self.md.parent) + '/') if self.absolute else '') + name + '`')
        intro = self.newline.join(lines) + self.newline
        self.md.write_bytes(intro.encode() + ((self.newline + '---' + self.newline).encode() if self.delim else b'\nBODY-START\n') + self.body)
        for name, data in self.assets.items():
            p = self.md.parent / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        return self


def node(base, name, identity=None, kind='folder', **kwargs):
    md = Path(base) / name / 'HANDOFF.md' if kind == 'folder' else Path(base) / (name + '.md')
    n = Node(md, identity or name, **kwargs)
    if kind == 'folder' and 'assets' not in kwargs:
        n.assets = {'blobs/R0000.txt': ('BLOB:' + n.identity).encode() + bytes(range(256)),
                    'blobs/empty.txt': b'', 'blobs/nested/raw.bin': b'\x00\xff\r\n' * 71}
    return n.write()


def child(parent, name, identity=None, kind='folder', **kwargs):
    c = node(parent.side, name, identity, kind, **kwargs)
    parent.children.append(c)
    parent.write()
    return c


def refs(md):
    raw = md.read_bytes()
    intro = raw.split(b'\n---\n', 1)[0].split(b'\r\n---\r\n', 1)[0].split(b'\nBODY-START\n', 1)[0].decode()
    found = []
    for line in intro.splitlines():
        if not line.startswith('PARENT '):
            continue
        val = line.split(': ', 1)[1]
        if val.startswith('`'):
            val = val[1:-1]
        elif val.startswith('[handoff]('):
            val = val[len('[handoff]('):-1]
        found.append((md.parent / val).resolve())
    return found


def check_node(expected, actual, dest, seen=None):
    seen = set() if seen is None else seen
    key = (str(expected.md), str(actual))
    if key in seen:
        return
    seen.add(key)
    require(actual.is_file(), f'MISSING handoff expected={expected.identity} actual={actual}')
    require(actual.resolve().is_relative_to(dest.resolve()), f'NONPORTABLE reference outside output: {actual}')
    raw = actual.read_bytes()
    require(raw.endswith(expected.body), f'BODY MISMATCH expected={expected.identity} actual={actual}; suffix={raw[-180:]!r}')
    require(raw.count(b'\n') == expected.md.read_bytes().count(b'\n'), f'LINE COUNT changed: {actual}')
    for name, data in expected.assets.items():
        p = actual.parent / name
        require(p.is_file(), f'MISSING asset expected={expected.identity}/{name} actual={p}')
        require(p.read_bytes() == data, f'BLOB MISMATCH expected={expected.identity}/{name} actual={p}')
    actual_refs = refs(actual)
    require(len(actual_refs) == len(expected.children), f'EDGE COUNT mismatch: {actual}')
    for exp, got in zip(expected.children, actual_refs):
        check_node(exp, got, dest, seen)


class Env:
    def __init__(self, module, root):
        self.module = module
        self.root = root
        self.src = root / 'src'
        self.src.mkdir()
        self.dest = root / 'output/parents'
        self.snapshots = []

    def copy(self, nodes, dest=None, check=True):
        dest = dest or self.dest
        before = inventory(self.src)
        try:
            result = self.module.copy_parents([str(n.md) for n in nodes], str(dest))
        finally:
            require(inventory(self.src) == before, 'SOURCE MUTATED by copy_parents')
        require(len(result) == len(nodes), f'Result count {len(result)} != {len(nodes)}')
        for n, (original, copied, exists) in zip(nodes, result):
            require(original == str(n.md) and exists is True and copied is not None, f'Invalid copy result: {original, copied, exists}')
            assert isinstance(copied, str)
            if check:
                check_node(n, Path(copied), dest)
        return [Path(r[1]) for r in result]


@case
def leaf_folder_binary_blobs(e):
    e.copy([node(e.src, 'handoff-11111111-20260101-leaf')])


@case
def leaf_legacy_md(e):
    e.copy([node(e.src, 'handoff-11111111-20260101-cut', kind='md')])


@case
def missing_parent(e):
    fp = str(e.src / 'handoff-11111111-20260101-missing.md')
    require(e.module.copy_parents([fp], str(e.dest)) == [(fp, None, False)], 'Missing parent not reported exactly')


@case
def empty_parent_list(e):
    require(e.module.copy_parents([], str(e.dest)) == [], 'Empty list should return []')
    require(not e.dest.exists(), 'Empty list unnecessarily created destination')


@case
def unique_folder_chain(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    p = root
    for i in range(5):
        p = child(p, f'handoff-{i:08x}-20260101-child')
    e.copy([root])


@case
def unique_mixed_legacy_chain(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    p = child(root, 'handoff-22222222-20260101-cut', kind='md')
    p = child(p, 'handoff-33333333-20260101-folder')
    child(p, 'handoff-44444444-20260101-cut', kind='md')
    e.copy([root])


@case
def absolute_folder_intro(e):
    root = node(e.src, 'handoff-11111111-20260101-root', absolute=True)
    child(root, 'handoff-22222222-20260101-child')
    out = e.copy([root])[0]
    require(str(root.md.parent).encode() not in out.read_bytes().split(b'\n---\n')[0], 'Absolute root still in intro')


def system_alias(path):
    # macOS links /var and /tmp to /private/...; the alias spelling of `path`,
    # whatever spelling TMPDIR has.
    real = path.resolve()
    alias = next((Path('/', *real.parts[2:]) for top in ('tmp', 'var')
                  if real.parts[1:3] == ('private', top) and Path('/' + top).resolve() == Path('/private', top)), None)
    if alias is None:
        raise Skip('no /tmp or /var system alias of ' + str(real))
    return alias


@case
def system_alias_folder_intro(e):
    # The intro quotes the /var spelling the caller gave.
    alias = system_alias(e.src)
    root = node(alias, 'handoff-11111111-20260101-root', absolute=True)
    child(root, 'handoff-22222222-20260101-child')
    out = e.copy([root])[0]
    require(str(alias).encode() not in out.read_bytes().split(b'\n---\n')[0], 'Aliased absolute root still in intro')


@case
def system_alias_dest_spelling(e):
    # The new handoff links its parents relative to `dest` as the caller
    # spelled it; a /private path would make that link dangle.
    dest = system_alias(e.dest.parent) / e.dest.name
    out = e.copy([node(e.src, 'handoff-11111111-20260101-leaf')], dest)[0]
    require(dest in out.parents, 'Copy not under the destination as given: %s' % out)
    require((dest.resolve() / os.path.relpath(out, dest)).is_file(), 'Relative link dangles: %s' % os.path.relpath(out, dest))


@case
def absolute_legacy_md_sidecar(e):
    root = node(e.src, 'handoff-11111111-20260101-cut', kind='md', absolute=True)
    child(root, 'handoff-22222222-20260101-child')
    e.copy([root])


@case
def legacy_md_multilevel_sidecars(e):
    root = node(e.src, 'handoff-11111111-20260101-cut', kind='md')
    p = child(root, 'handoff-22222222-20260101-cut', kind='md')
    child(p, 'handoff-33333333-20260101-cut', kind='md')
    e.copy([root])


@case
def repeated_identical_input(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    child(root, 'handoff-22222222-20260101-child')
    paths = e.copy([root] * 4)
    require(len(set(paths)) == 1, 'Identical source should reuse the same output')


@case
def completed_retry_is_idempotent(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    child(root, 'handoff-22222222-20260101-child')
    e.copy([root])
    before = inventory(e.dest)
    e.copy([root])
    require(inventory(e.dest) == before, 'Completed retry changed bytes/layout')


def diamond(e, *, divergent=False, blob_only=False, deep_divergence=False):
    root = node(e.src, 'handoff-11111111-20260101-root')
    a = child(root, 'handoff-22222222-20260101-left')
    b = child(root, 'handoff-33333333-20260101-right')
    ca = child(a, 'handoff-44444444-20260101-shared', 'SHARED-A' if divergent else 'SHARED')
    cb = child(b, 'handoff-44444444-20260101-shared', 'SHARED-B' if divergent else 'SHARED')
    if blob_only:
        cb.assets['blobs/R0000.txt'] = b'OTHER BLOB, SAME BODY'
        cb.write()
    if deep_divergence:
        child(ca, 'handoff-55555555-20260101-great', 'GREAT-A')
        child(cb, 'handoff-55555555-20260101-great', 'GREAT-B')
    return root


@case
def diamond_identical_ancestors(e):
    e.copy([diamond(e)])


@case
def diamond_same_basename_different_bodies(e):
    e.copy([diamond(e, divergent=True)])


@case
def diamond_same_body_different_blob_bytes(e):
    e.copy([diamond(e, blob_only=True)])


@case
def diamond_identical_parent_different_grandparent(e):
    e.copy([diamond(e, deep_divergence=True)])


@case
def direct_same_basename_folders(e):
    a = node(e.src / 'a', 'handoff-11111111-20260101-same', 'A')
    b = node(e.src / 'b', 'handoff-11111111-20260101-same', 'B')
    e.copy([a, b])


@case
def direct_same_basename_legacy_md(e):
    a = node(e.src / 'a', 'handoff-11111111-20260101-same', 'A', kind='md')
    b = node(e.src / 'b', 'handoff-11111111-20260101-same', 'B', kind='md')
    e.copy([a, b])


@case
def nested_same_basename_legacy_md(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    a = child(root, 'handoff-22222222-20260101-left')
    b = child(root, 'handoff-33333333-20260101-right')
    child(a, 'handoff-44444444-20260101-same', 'A', kind='md')
    child(b, 'handoff-44444444-20260101-same', 'B', kind='md')
    e.copy([root])


@case
def root_and_ancestor_share_basename(e):
    root = node(e.src, 'handoff-11111111-20260101-same', 'ROOT')
    child(root, 'handoff-11111111-20260101-same', 'ANCESTOR')
    e.copy([root])


@case
def direct_parents_have_conflicting_ancestors(e):
    a = node(e.src, 'handoff-11111111-20260101-left')
    b = node(e.src, 'handoff-22222222-20260101-right')
    child(a, 'handoff-33333333-20260101-same', 'A')
    child(b, 'handoff-33333333-20260101-same', 'B')
    e.copy([a, b])


@case
def retry_empty_destination_directory(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    (e.dest / root.md.parent.name).mkdir(parents=True)
    e.copy([root])


@case
def retry_missing_blob(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    out = e.copy([root])[0]
    (out.parent / 'blobs/R0000.txt').unlink()
    e.copy([root])


@case
def retry_truncated_legacy_md(e):
    root = node(e.src, 'handoff-11111111-20260101-cut', kind='md')
    e.dest.mkdir(parents=True)
    (e.dest / root.md.name).write_bytes(b'partly copied')
    e.copy([root])


def interrupted_after_copy(e, md=False):
    root = node(e.src, 'handoff-11111111-20260101-root', kind='md' if md else 'folder')
    child(root, 'handoff-22222222-20260101-child')
    method = 'copy2' if md else 'copytree'
    original = getattr(shutil, method)
    triggered = False

    def interrupt(*args, **kwargs):
        nonlocal triggered
        first = not triggered
        triggered = True
        result = original(*args, **kwargs)
        if first:
            raise OSError('INJECTED: interruption immediately after the root copy')
        return result

    with patch.object(shutil, method, interrupt):
        try:
            e.copy([root], check=False)
        except OSError as exc:
            require('INJECTED' in str(exc), f'Unexpected failure: {exc}')
        else:
            raise AssertionError('Fault injection did not execute')
    e.copy([root])


@case
def retry_interrupted_before_folder_intro_rewrite(e):
    interrupted_after_copy(e)


@case
def retry_interrupted_before_legacy_intro_rewrite(e):
    interrupted_after_copy(e, md=True)


@case
def unique_auxiliary_sidecar_files(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    child(root, 'handoff-22222222-20260101-child')
    files = {'metadata.bin': bytes(range(256)), 'aux/nested/data.bin': b'\x00\xff\r\n', 'note.md': b'plain note with no separator'}
    for name, data in files.items():
        p = root.side / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    e.copy([root])
    got = [p.read_bytes() for p in e.dest.rglob('*') if p.is_file()]
    require(all(data in got for data in files.values()), 'Auxiliary files lost bytes')


@case
def colliding_auxiliary_sidecar_directories(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    a = child(root, 'handoff-22222222-20260101-left')
    b = child(root, 'handoff-33333333-20260101-right')
    for p, data in ((a, b'auxiliary-A'), (b, b'auxiliary-B')):
        f = p.side / 'aux/data.bin'
        f.parent.mkdir(parents=True)
        f.write_bytes(data)
    e.copy([root])
    values = [p.read_bytes() for p in e.dest.rglob('data.bin')]
    require(b'auxiliary-A' in values and b'auxiliary-B' in values, f'AUXILIARY COLLISION expected both A,B actual={values!r}')


@case
def non_utf8_auxiliary_markdown(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    root.side.mkdir()
    data = b'legacy arbitrary .md bytes: \xff\xfe\x00'
    (root.side / 'notes.md').write_bytes(data)
    e.copy([root])
    require(any(p.read_bytes() == data for p in e.dest.rglob('notes.md')), 'Opaque notes.md not retained')


@case
def orphan_legacy_sidecar_preserved(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    p = root.side / 'orphan-parents/archive.bin'
    p.parent.mkdir(parents=True)
    p.write_bytes(b'ORPHAN BYTES')
    e.copy([root])
    require(any(q.read_bytes() == b'ORPHAN BYTES' for q in e.dest.rglob('archive.bin')), 'Orphan sidecar bytes lost')


@case
def crlf_parent_reference(e):
    root = node(e.src, 'handoff-11111111-20260101-root', newline='\r\n')
    child(root, 'handoff-22222222-20260101-child')
    e.copy([root])


@case
def parent_reference_without_separator(e):
    root = node(e.src, 'handoff-11111111-20260101-root', delim=False)
    child(root, 'handoff-22222222-20260101-child')
    e.copy([root])


@case
def parent_reference_markdown_link(e):
    root = node(e.src, 'handoff-11111111-20260101-root', refstyle='markdown')
    child(root, 'handoff-22222222-20260101-child')
    e.copy([root])


@case
def parent_reference_without_backticks(e):
    root = node(e.src, 'handoff-11111111-20260101-root', refstyle='plain')
    child(root, 'handoff-22222222-20260101-child')
    e.copy([root])


@case
def spaces_and_unicode_names(e):
    root = node(e.src, 'handoff-11111111-20260101-spa ce-ă')
    child(root, 'handoff-22222222-20260101-子 孫')
    e.copy([root])


@case
def next_copy_of_whole_handoff(e):
    root = diamond(e)
    e.copy([root])
    current = node(e.root, 'output', 'CURRENT')
    current.children.append(root)
    copied_root = e.dest / root.md.parent.name / 'HANDOFF.md'
    # Write current reference to the already-generated parent location, while
    # keeping the expected semantic tree pointing to the original fixture.
    current.write()
    text = current.md.read_bytes()
    oldref = os.path.relpath(root.md, current.md.parent)
    text = text.replace(('`' + oldref + '`').encode(), ('`' + os.path.relpath(copied_root, current.md.parent) + '`').encode())
    current.md.write_bytes(text)
    e.copy([current], dest=e.root / 'next/parents')


@case
def directly_recopy_saved_ancestor(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    a = child(root, 'handoff-22222222-20260101-child')
    child(a, 'handoff-33333333-20260101-grandchild')
    copied_root = e.copy([root])[0]
    copied_a = refs(copied_root)[0]
    dest = e.root / 'recopied/parents'
    result = e.module.copy_parents([str(copied_a)], str(dest))
    require(result[0][2], 'Saved ancestor not reported copied')
    check_node(a, Path(result[0][1]), dest)


@case
def real_compact_blob_roundtrip_after_parent_copy(e):
    m = e.module
    cc = m.cc
    grand = e.src / 'handoff-22222222-20260101-grand'
    parent = e.src / 'handoff-11111111-20260101-parent'
    grand.mkdir()
    parent.mkdir()
    originals = {}
    # Write actual generated introductions, marker headers and compact blobs.
    for folder, ancestors in ((grand, []), (parent, [(str(grand / 'HANDOFF.md'), str(parent / 'parents' / grand.name / 'HANDOFF.md'), True)])):
        if ancestors:
            shutil.copytree(grand, parent / 'parents' / grand.name)
        text = ('[12345678-1234-4123-8123-123456789abc user] Keep all bytes.\n'
                '[22345678-1234-4123-8123-123456789abc user] [tool_result] '
                + (folder.name + ' ăâîșț 日本語 🙂\r\n') * 90)
        compact, blobs, pair = cc.compact_text(text, cc.DEFAULT_LIMITS, cc.DEFAULT_PREVIEW, False, {}, True)
        require(bool(blobs), 'Fixture did not produce any actual blobs')
        intro = m.build_intro(False, '12345678', '2026-01-01 00:00', '/synthetic/source.jsonl', True,
                              m.parents_paragraph(ancestors, str(folder)))
        cc.write_out(str(folder), compact, blobs, cc.DEFAULT_LIMITS, pair, intro=intro, name='HANDOFF.md')
        originals[folder.name] = (text, inventory(folder / 'blobs'), (folder / 'HANDOFF.md').read_bytes().split(b'\n---\n', 1)[1])
    # Recopy grand after generation of its real payload, before checking parent.
    copied_grand = parent / 'parents' / grand.name
    shutil.rmtree(copied_grand)
    shutil.copytree(grand, copied_grand)
    before = inventory(e.src)
    result = m.copy_parents([str(parent / 'HANDOFF.md')], str(e.dest))
    require(result[0][2], 'Real generated parent not copied')
    for name, (text, blob_hashes, body) in originals.items():
        matches = [p for p in e.dest.rglob('HANDOFF.md') if p.parent.name == name]
        require(len(matches) == 1, f'Expected exactly one generated {name}, found {matches}')
        md = matches[0]
        require(md.read_bytes().split(b'\n---\n', 1)[1] == body, 'Actual compact transcript changed')
        require(inventory(md.parent / 'blobs') == blob_hashes, 'Actual blob hash changed')
        require(cc.expand_text(*cc.read_out(str(md.parent))) == text, 'Expanded actual transcript differs')
    require(inventory(e.src) == before, 'Generated sources mutated')


def run_main_fixture(e, root):
    m = e.module
    sid = '12345678-1234-4123-8123-123456789abc'
    records = []
    messages = [('user', 'Continue the synthetic handoff.'),
                ('assistant', [{'type': 'tool_use', 'id': 'toolu_review', 'name': 'Read', 'input': {'file_path': str(root.md)}}]),
                ('user', [{'type': 'tool_result', 'tool_use_id': 'toolu_review', 'content': root.md.read_text()}]),
                ('assistant', 'Synthetic replay only.')]
    previous = None
    for i, (role, content) in enumerate(messages):
        rid = f'{i:08x}-1234-4123-8123-123456789abc'
        records.append({'type': role, 'uuid': rid, 'parentUuid': previous, 'sessionId': sid,
                        'cwd': str(e.root), 'timestamp': f'2026-01-01T00:00:0{i}Z',
                        'message': {'role': role, 'content': content}})
        previous = rid
    sess = e.src / (sid + '.jsonl')
    sess.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records))
    home = e.root / 'isolated-home'
    tmp = e.root / 'isolated-tmp'
    home.mkdir()
    tmp.mkdir()
    buf = io.StringIO()
    before = inventory(e.src)
    # Baseline generator was frozen without sibling helpers. HERE redirects only
    # helper lookup to the unchanged snapshot helpers, not parent-copy logic.
    with patch.object(m, 'HERE', str(SCRIPTS)), patch.object(sys, 'argv', [str(SOURCES['candidate']), str(sess), str(e.dest.parent), '--no-opencode']), \
            patch.object(tempfile, 'tempdir', str(tmp)), patch.dict(os.environ, {'HOME': str(home), 'TMPDIR': str(tmp), 'PYTHONDONTWRITEBYTECODE': '1'}), contextlib.redirect_stdout(buf):
        try:
            m.main()
        finally:
            (e.root / 'main.stdout.txt').write_text(buf.getvalue())
    require('roundtrip IDENTICAL' in buf.getvalue() and 'ready:' in buf.getvalue(), 'Main pipeline did not report a checked ready handoff')
    require(inventory(e.src) == before, 'Main pipeline mutated sources')
    actual = e.dest / root.md.parent.name / 'HANDOFF.md'
    check_node(root, actual, e.dest)


@case
def main_pipeline_normal_diamond(e):
    run_main_fixture(e, diamond(e))


@case
def main_pipeline_conflicting_diamond(e):
    run_main_fixture(e, diamond(e, divergent=True))


@case
def readonly_folder_needs_reference_rewrite(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    child(root, 'handoff-22222222-20260101-child')
    root.md.chmod(0o400)
    e.copy([root])
    require(root.md.stat().st_mode & 0o777 == 0o400, 'Source mode changed')


@case
def readonly_legacy_md_needs_reference_rewrite(e):
    root = node(e.src, 'handoff-11111111-20260101-root', kind='md')
    child(root, 'handoff-22222222-20260101-child')
    root.md.chmod(0o400)
    e.copy([root])
    require(root.md.stat().st_mode & 0o777 == 0o400, 'Source mode changed')


@case
def collision_across_separate_copy_calls(e):
    a = node(e.src / 'a', 'handoff-11111111-20260101-same', 'A')
    b = node(e.src / 'b', 'handoff-11111111-20260101-same', 'B')
    first = e.copy([a])[0]
    e.copy([b])
    check_node(a, first, e.dest)
    before = inventory(e.dest)
    e.copy([b])
    require(before == inventory(e.dest), 'Retry after collision is not idempotent')


@case
def collision_at_component_byte_limit(e):
    name = 'handoff-' + 'ă' * 120
    a = node(e.src / 'a', name, 'A')
    b = node(e.src / 'b', name, 'B')
    e.copy([a, b])


@case
def relocated_legacy_absolute_graph(e):
    root = node(e.src / 'original', 'handoff-11111111-20260101-root', absolute=True)
    a = child(root, 'handoff-22222222-20260101-child', absolute=True)
    child(a, 'handoff-33333333-20260101-grandchild')
    moved = e.src / 'moved' / root.md.parent.name
    shutil.copytree(root.md.parent, moved)
    # Model an old copy: introductions still contain the original absolute paths.
    root.md = moved / 'HANDOFF.md'
    e.copy([root])


@case
def relocated_legacy_graph_without_original(e):
    root = node(e.src / 'original', 'handoff-11111111-20260101-root', absolute=True)
    a = child(root, 'handoff-22222222-20260101-child', absolute=True)
    b = child(a, 'handoff-33333333-20260101-grandchild')
    old = root.md.parent
    moved = e.src / 'moved' / old.name
    shutil.copytree(old, moved)
    root.md = moved / 'HANDOFF.md'
    a.md = moved / 'parents' / a.md.parent.name / 'HANDOFF.md'
    b.md = a.md.parent / 'parents' / b.md.parent.name / 'HANDOFF.md'
    shutil.rmtree(old)
    e.copy([root])


@case
def retry_preserves_unrelated_output(e):
    e.dest.mkdir(parents=True)
    note = e.dest / 'user-note.bin'
    note.write_bytes(b'UNRELATED\x00\xff')
    root = node(e.src, 'handoff-11111111-20260101-root')
    child(root, 'handoff-22222222-20260101-child')
    e.copy([root])
    e.copy([root])
    require(note.read_bytes() == b'UNRELATED\x00\xff', 'Unrelated output was changed')


@case
def randomized_colliding_graphs_100(e):
    import random
    for seed in range(100):
        rng = random.Random(seed)
        counter = [0]
        def build(base, depth, slot):
            counter[0] += 1
            identity = 'seed-%d-node-%d' % (seed, counter[0])
            name = 'handoff-%08x-20260101-shared' % (depth * 10 + slot)
            current = node(base, name, identity, kind=rng.choice(['folder', 'md']), absolute=rng.choice([True, False]))
            for i in range(rng.randint(0, 2) if depth else 0):
                current.children.append(build(current.side, depth - 1, i))
            current.write()
            return current
        root = build(e.src / str(seed), 4, 0)
        try:
            e.copy([root], dest=e.root / ('random-out-%d' % seed))
        except Exception as exc:
            raise AssertionError('Randomized preservation seed=%d: %s' % (seed, exc)) from exc


@case
def legacy_generated_provenance_explanation(e):
    root = node(e.src, 'handoff-11111111-20260101-root')
    ancestor = child(root, 'handoff-22222222-20260101-child')
    reference = os.path.relpath(ancestor.md, root.md.parent)
    paragraph = ('## Handoff părinte\nAceastă sesiune a pornit din alt handoff. '
                 'Părintele este păstrat întreg în: `' + reference + '` '
                 '(căi relative la folderul acestui fișier). Din el ai inline doar rezumatul. '
                 'Dacă și el a pornit dintr-un handoff, îl găsești lângă el, în '
                 '`parents/` sau în `<nume>-parents/`.\n')
    root.md.write_bytes(('# Handoff\n' + paragraph + '\n---\n').encode() + root.body)
    copied = e.copy([root], check=False)[0]
    raw = copied.read_bytes()
    require(raw.endswith(root.body), 'Legacy generated body changed')
    match = re.search(r'Părintele este păstrat întreg în: `([^`]+)`', raw.decode())
    assert match is not None
    parent_ref = match.group(1)
    check_node(ancestor, (copied.parent / parent_ref).resolve(), e.dest)


def load(target):
    sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location('review_' + target, SOURCES[target])
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    # Both frozen scripts execute main() even on import. Remove only that exact
    # final dispatch in memory; all function ASTs remain the original source.
    tree = ast.parse(SOURCES[target].read_text(), filename=str(SOURCES[target]))
    require(ast.unparse(tree.body[-1]) == "if '--selftest' in sys.argv:\n    selftest()\nelse:\n    main()", 'Unexpected entrypoint; refusing to load')
    tree.body.pop()
    exec(compile(tree, str(SOURCES[target]), 'exec'), module.__dict__)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repeat', type=int, default=1)
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--quiet', action='store_true')
    parser.add_argument('--report')
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error('--repeat must be positive')
    names = args.case or list(CASES)
    if set(names) - CASES.keys():
        parser.error('Unknown case')
    hashes = {k: digest(v) for k, v in SOURCES.items()}
    results = []
    with tempfile.TemporaryDirectory(prefix='parent-preservation-', dir=os.environ.get('TMPDIR')) as tmp:
        root = Path(tmp)
        module = load('candidate')
        for repeat in range(1, args.repeat + 1):
            for name in names:
                folder = root / f'r{repeat}' / name
                folder.mkdir(parents=True)
                row = {'repeat': repeat, 'case': name}
                try:
                    CASES[name](Env(module, folder))
                except Skip as exc:
                    row.update(status='SKIP', error=str(exc))
                except Exception as exc:
                    row.update(status='FAIL', error=f'{type(exc).__name__}: {exc}', traceback=traceback.format_exc())
                else:
                    row['status'] = 'PASS'
                results.append(row)
                if not args.quiet:
                    print(f"{row['status']} {name}" + (': ' + row['error'] if row['status'] != 'PASS' else ''), flush=True)
    require(hashes == {k: digest(v) for k, v in SOURCES.items()}, 'Sources changed during tests')
    payload = {'python': sys.version, 'source_sha256': hashes, 'case_count': len(names), 'repeat': args.repeat,
               'summary': dict(Counter(r['status'] for r in results)), 'results': results}
    if args.report:
        Path(args.report).write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n')
    print('SUMMARY ' + json.dumps(payload['summary']))
    return int(any(r['status'] == 'FAIL' for r in results))


if __name__ == '__main__':
    raise SystemExit(main())
