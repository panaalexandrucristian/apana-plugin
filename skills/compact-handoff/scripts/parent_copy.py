"""Lossless, flat parent storage. Only provenance links are graph edges.

Discover before writing; assign a separate identity to each physical source;
rewrite only introduction tokens; compare complete staged payloads on retries.
An existing, different destination is never overwritten or trusted as a copy.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from typing import Optional


_BOUNDARY = re.compile(br"(?m)^(?:---|BODY-START)\r?$")
_TOKEN = re.compile(br"`([^`\r\n]+)`|\[[^\]\r\n]*\]\(([^\r\n]+)\)")
_PROVENANCE = re.compile(br"^(?:PARENT(?: [0-9]+)?|Parent):\s*|P\xc4\x83rintele este p\xc4\x83strat \xc3\xaentreg \xc3\xaen:\s*")
_STORAGE = ".handoff-parent-storage.json"


def _storage_path(path, folder):
    if folder:
        return path.parent / _STORAGE
    tag = hashlib.sha256(os.fsencode(path.name)).hexdigest()[:24]
    return path.with_name(".handoff-parent-storage-" + tag + ".json")


def intro_end(raw):
    """First explicit boundary, irrespective of newline convention."""
    match = _BOUNDARY.search(raw)
    return match.start() if match else 0


def _given(path):
    """`path` absolute, in the spelling the caller used (macOS /var, not /private/var)."""
    path = Path(path)
    return path if path.is_absolute() else Path.cwd() / path


def _safe_path(path):
    """Reject links before opening anything. macOS's system aliases are OK."""
    path = Path(path)
    if not path.is_absolute():
        path = Path.cwd() / path
    current = Path(path.anchor)
    # Inspect components in filesystem order: abspath would erase link/..
    # before we could reject the symlink, potentially selecting different data.
    for part in path.parts[1:]:
        if part == "..":
            if not current.is_dir():
                raise ValueError("non-directory before '..' in parent storage: %s" % current)
            current = current.parent
        else:
            current /= part
            if current.is_symlink():
                if str(current) not in ("/tmp", "/var"):
                    raise ValueError("symlink in parent storage: %s" % current)
                current = current.resolve()
    return current


def _inventory(path):
    """Full bytes and empty directories, not just the handoff's body hash."""
    result = {}
    def walk(p, rel):
        mode = p.lstat().st_mode
        if stat.S_ISDIR(mode):
            result[rel] = None
            for child in sorted(p.iterdir()):
                walk(child, rel + "/" + child.name)
        elif stat.S_ISREG(mode):
            h = hashlib.sha256()
            with p.open("rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    h.update(chunk)
            result[rel] = h.digest()
        else:
            raise ValueError("non-regular entry in parent storage: %s" % p)
    walk(path, "")
    return result


def _replace_file(path, raw):
    """Only a private staged copy is changed, including for mode 0400 input."""
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IWUSR)
    try:
        path.write_bytes(raw)
    finally:
        path.chmod(stat.S_IMODE(mode))


def relativize_intro(md_path, orig_dir, orig_file=None):
    """Compatibility entry point: byte-safe legacy introduction rewriting."""
    path = Path(md_path)
    raw = path.read_bytes()
    end = intro_end(raw)
    intro = raw[:end]
    directory = os.fsencode(orig_dir)
    if orig_file is None:
        new = intro.replace(directory + b"/blobs/", b"blobs/").replace(directory + b"/parents/", b"parents/").replace(directory, "acest folder".encode())
    else:
        new = intro.replace(os.fsencode(orig_file), "acest fișier".encode()).replace(directory + b"/", b"")
    if new == intro:
        return False
    _replace_file(path, new + raw[end:])
    return True


def _layout(path, folder):
    """A handoff's payload source and the sidecar of its stored parents."""
    if folder:
        return path.parent, path.parent / "parents"
    return path, path.with_name(path.stem + "-parents")


class _Entry:
    def __init__(self, path, handoff=False):
        self.path = path
        # Introductions quote the spelling the caller used, e.g. macOS /var
        # for the resolved /private/var; text is compared with every form.
        self.forms = [path]
        self.handoff = handoff
        self.folder = handoff and path.name == "HANDOFF.md"
        self.source, self.side = _layout(path, self.folder)
        self.name = self.source.name
        self.dependencies = []
        self.links = []
        self.raw = b""
        self.end = 0
        self.output = None
        self.expected = None
        self.metadata_output = None
        self.metadata = None
        self.had_storage = False
        self.state = "new"


class _Graph:
    def __init__(self, dest):
        self.dest = _safe_path(dest)
        self.entries = {}
        self.sources = {}
        self.claimed = set()
        self.stage: Optional[Path] = None
        self.warnings = set()

    def add(self, path, handoff=False, depth=0):
        given = _given(path)
        path = _safe_path(path)
        source = path.parent if handoff and path.name == "HANDOFF.md" else path
        owner = self.sources.get(source)
        if owner is not None and owner.handoff != handoff:
            # A folder and its HANDOFF.md have different entrypoint paths but
            # the same payload source. Roles must agree in either visit order.
            raise ValueError("opaque storage entry conflicts with parent provenance: %s" % source)
        if path in self.entries:
            entry = self.entries[path]
            if handoff != entry.handoff:
                raise ValueError("opaque storage entry conflicts with parent provenance: %s" % path)
            if entry.state == "visiting":
                raise ValueError("cycle in parent provenance: %s" % path)
            if given not in entry.forms:
                entry.forms.append(given)
            return entry
        if depth >= 256 or len(self.entries) >= 10000:
            raise ValueError("parent graph exceeds safe traversal limit")
        if not path.is_file() and handoff:
            raise ValueError("missing parent handoff: %s" % path)
        entry = self.entries[path] = _Entry(path, handoff)
        if given != path:
            entry.forms.append(given)
        self.sources[entry.source] = entry
        entry.state = "visiting"
        if self.dest == entry.source or (entry.source.is_dir() and entry.source in self.dest.parents):
            raise ValueError("parent destination overlaps source: %s" % entry.source)
        if handoff:
            entry.raw = path.read_bytes()
            if not entry.raw.startswith(b"# Handoff"):
                raise ValueError("malformed parent handoff: %s" % path)
            entry.end = intro_end(entry.raw)
            if not entry.end:
                raise ValueError("parent introduction has no boundary: %s" % path)
            # A sidecar is actual parent storage, not arbitrary Markdown links.
            if entry.side.exists():
                _safe_path(entry.side)
                if not entry.side.is_dir():
                    raise ValueError("parent sidecar is not a directory: %s" % entry.side)
                companions = set()
                for child in entry.side.glob("*.md"):
                    _safe_path(child)
                    if child.is_file():
                        with child.open("rb") as f:
                            if f.read(9) == b"# Handoff":
                                companions.add(_storage_path(child, False))
                for child in sorted(entry.side.iterdir()):
                    _safe_path(child)
                    if child in companions:
                        continue  # owned and validated with the legacy .md
                    if child.is_dir() and (child / "HANDOFF.md").exists():
                        dep = self.add(child / "HANDOFF.md", True, depth + 1)
                    elif child.is_file() and child.suffix == ".md":
                        with child.open("rb") as f:
                            is_handoff = f.read(9) == b"# Handoff"
                        dep = self.add(child, is_handoff, depth + 1)
                    elif child.name.endswith("-parents") and child.with_name(child.name[:-8] + ".md").is_file():
                        # A real legacy handoff owns this sidecar. Opaque .md
                        # files do not, so preserve their sidecars as opaque too.
                        owner = child.with_name(child.name[:-8] + ".md")
                        with owner.open("rb") as f:
                            if f.read(9) == b"# Handoff":
                                continue
                        dep = self.add(child, False, depth + 1)
                    else:
                        dep = self.add(child, False, depth + 1)
                    entry.dependencies.append(dep)
            self.read_storage(entry, depth)
            self.read_links(entry, depth)
        # Validate all copied payloads, including opaque data, before copytree
        # can follow a symlink or special file. Exclude only this node's sidecar.
        if entry.folder:
            for child in sorted(entry.source.iterdir()):
                if child.name != "parents":
                    _inventory(child)
        else:
            _inventory(entry.source)
        entry.state = "discovered"
        return entry

    def read_storage(self, entry, depth):
        """Retain unreferenced sidecar data when a saved flat parent is reused.

        The index contains only sibling basenames, never arbitrary paths. It
        is needed only for storage entries not described by provenance links.
        """
        index = _storage_path(entry.path, entry.folder)
        if not os.path.lexists(index):
            return
        _safe_path(index)
        entry.had_storage = True
        try:
            data = json.loads(index.read_bytes())
            if not isinstance(data, dict) or data.get("format") != "handoff-parent-storage-v1" or not isinstance(data.get("entries"), list):
                raise ValueError("unknown storage index format")
            for row in data["entries"]:
                name, kind = row["name"], row["kind"]
                if not isinstance(name, str) or name in ("", ".", "..") or "/" in name or "\\" in name or kind not in ("folder", "md", "opaque"):
                    raise ValueError("invalid storage entry")
                base = entry.path.parent.parent if entry.folder else entry.path.parent
                target = base / name
                if _safe_path(target) == entry.source:
                    raise ValueError("storage entry owns its own source")
                if kind == "folder":
                    target /= "HANDOFF.md"
                entry.dependencies.append(self.add(target, kind != "opaque", depth + 1))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("invalid parent storage index %s: %s" % (index, exc)) from exc

    def storage_bytes(self, entry):
        linked = {dep.path for _, _, dep in entry.links}
        loose = {dep.path: dep for dep in entry.dependencies if dep.path not in linked}
        if not loose and not (entry.folder and entry.had_storage):
            return None
        rows = [{"name": dep.output.name, "kind": "folder" if dep.folder else "md" if dep.handoff else "opaque"} for dep in loose.values()]
        return (json.dumps({"format": "handoff-parent-storage-v1", "entries": rows}, ensure_ascii=True, sort_keys=True) + "\n").encode()

    def local_target(self, entry, value):
        """Prefer a nested local copy over an obsolete absolute original."""
        ref = Path(os.fsdecode(value))
        if ref.is_absolute():
            # An exact path under this node is stronger than a name-based
            # relocation hint (the root and its ancestor can share a name).
            if entry.side in ref.parents and ref.exists():
                return _safe_path(ref)
            marker = entry.source.name if entry.folder else entry.side.name
            parts = ref.parts
            # Preserve the longest existing storage-relative suffix, not the
            # last matching basename, which can incorrectly select self.
            for i in range(len(parts)):
                if parts[i] == marker:
                    base = entry.source if entry.folder else entry.side
                    local = base.joinpath(*parts[i + 1:])
                    # A relocation hint must select a nested stored parent,
                    # not this handoff merely sharing the external basename.
                    if entry.side in local.parents and local.exists():
                        return _safe_path(local)
        return _safe_path(ref if ref.is_absolute() else entry.path.parent / ref)

    def read_links(self, entry, depth):
        offset = 0
        for line in entry.raw[:entry.end].splitlines(keepends=True):
            provenance = _PROVENANCE.search(line)
            # Generated paragraphs keep explanatory backticks on the same
            # line; only the preceding parent list is provenance, not the
            # later `parents/` / `<nume>-parents/` examples.
            provenance_end = line.find(" (căi relative".encode(), provenance.end()) if provenance else -1
            if provenance_end < 0:
                provenance_end = len(line)
            tokens = list(_TOKEN.finditer(line))
            if provenance and not tokens:
                start = provenance.end()
                stop = len(line.rstrip(b"\r\n"))
                if start < stop:
                    tokens = [(start, stop, line[start:stop])]
                else:
                    raise ValueError("empty parent reference in %s" % entry.path)
            for token in tokens:
                if isinstance(token, tuple):
                    start, stop, value = token
                else:
                    group = 1 if token.group(1) is not None else 2
                    start, stop = token.span(group)
                    value = token.group(group)
                strict = provenance is not None and provenance.end() <= start < provenance_end
                after_token = stop if isinstance(token, tuple) else token.end()
                if strict and re.match(br"[ \t]*\(nu mai exista(?:[ \t]|\))", line[after_token:]):
                    # A missing notice belongs only to its immediately preceding
                    # token, never an earlier parent across a semicolon.
                    continue
                if not value.endswith(b".md"):
                    if strict:
                        raise ValueError("malformed parent reference in %s" % entry.path)
                    continue
                # Ordinary intro prose can refer to local storage (legacy),
                # but must never cause arbitrary external files to be opened.
                target = self.local_target(entry, value)
                stored = next((d for d in entry.dependencies if d.path == target), None)
                if strict and stored is not None and not stored.handoff:
                    raise ValueError("opaque storage entry conflicts with parent provenance: %s" % target)
                if not strict and stored is None:
                    continue
                if stored is None:
                    if not (target.name == "HANDOFF.md" or target.name.startswith("handoff-") and target.suffix == ".md"):
                        raise ValueError("unsupported parent provenance path in %s: %s" % (entry.path, target))
                    stored = self.add(target, True, depth + 1)
                    entry.dependencies.append(stored)
                entry.links.append((offset + start, offset + stop, stored))
            offset += len(line)

    def rewritten(self, entry):
        raw = entry.raw
        edits = []
        # Path replacements are spans in the introduction; bodies and newline
        # bytes are never decoded or searched for path-looking strings.
        for start, stop, target in entry.links:
            parent = self.dest / "placeholder" if entry.folder else self.dest
            output = target.output / "HANDOFF.md" if target.folder else target.output
            edits.append((start, stop, os.fsencode(os.path.relpath(output, parent))))
        intro = raw[:entry.end]
        for start, stop, value in reversed(edits):
            intro = intro[:start] + value + intro[stop:]
        # Legacy descriptive paths (not graph edges) stay on their own lines.
        # Only quoted tokens are changed, never arbitrary transcript/prose text.
        def descriptive(match):
            group = 1 if match.group(1) is not None else 2
            value = match.group(group)
            relative_side = os.fsencode(entry.side.name) + b"/"
            replacement = value
            for form in entry.forms:
                source, side = _layout(form, entry.folder)
                prefix = os.fsencode(form.parent) + b"/"
                side = os.fsencode(side) + b"/"
                if value.startswith(side):
                    replacement = (b"../" if entry.folder else b"") + value[len(side):]
                    self.warnings.add(str(entry.path))
                elif value.startswith(relative_side) and entry.side.is_dir():
                    replacement = (b"../" if entry.folder else b"") + value[len(relative_side):]
                elif entry.folder and value == os.fsencode(source):
                    replacement = "acest folder".encode()
                elif not entry.folder and value == os.fsencode(form):
                    replacement = "acest fișier".encode()
                elif value.startswith(prefix):
                    replacement = value[len(prefix):]
                else:
                    continue
                break
            a, b = match.span(group)
            return match.group()[:a - match.start()] + replacement + match.group()[b - match.start():]
        intro = _TOKEN.sub(descriptive, intro)
        return intro + raw[entry.end:]

    def materialize(self, entry):
        if entry.output is not None:
            return
        for dep in entry.dependencies:
            self.materialize(dep)
        assert self.stage is not None
        staged = self.stage / str(len(self.claimed))
        entry.metadata = self.storage_bytes(entry) if entry.handoff else None
        if entry.folder:
            shutil.copytree(str(entry.source), str(staged), ignore=lambda d, names: ["parents"] if Path(d) == entry.source else [])
            mode = staged.stat().st_mode
            staged.chmod(mode | stat.S_IWUSR | stat.S_IXUSR)
            try:
                _replace_file(staged / "HANDOFF.md", self.rewritten(entry))
                if entry.metadata is not None:
                    index = staged / _STORAGE
                    if index.exists():
                        _replace_file(index, entry.metadata)
                    else:
                        index.write_bytes(entry.metadata)
            finally:
                staged.chmod(stat.S_IMODE(mode))
        elif entry.handoff:
            shutil.copy2(str(entry.source), str(staged))
            _replace_file(staged, self.rewritten(entry))
        elif entry.source.is_dir():
            shutil.copytree(str(entry.source), str(staged))
        else:
            shutil.copy2(str(entry.source), str(staged))
        entry.expected = _inventory(staged)
        # Basenames are a presentation preference, never source identity. The
        # fixed-size fallback does not accumulate suffixes over rotations.
        identity = hashlib.sha256(os.fsencode(entry.path)).hexdigest()[:24]
        suffix = ".md" if entry.path.suffix == ".md" and not entry.folder else ""
        prefix = re.match(r"handoff-[0-9a-f]{8}-\d{8}-", entry.name)
        alias = ((prefix.group() if prefix else "handoff-%s-00000000-" % identity[:8]) + identity) if entry.handoff else "parent-" + identity
        candidates = [entry.name, alias + suffix]
        for attempt in range(1000):
            name = candidates[attempt] if attempt < 2 else "%s-%d%s" % (alias, attempt, suffix)
            output = self.dest / name
            if output in self.claimed:
                continue
            index = _storage_path(output, False) if entry.handoff and not entry.folder else None
            if index is not None and os.path.lexists(index):
                if index.is_symlink() or not index.is_file() or index.read_bytes() != entry.metadata:
                    continue
            if os.path.lexists(output):
                try:
                    equal = _inventory(output) == entry.expected
                except (OSError, ValueError):
                    equal = False
                if not equal:
                    continue
                if index is not None and entry.metadata is not None and not index.exists():
                    continue  # incomplete legacy pair: do not patch old output
            else:
                if index is not None and entry.metadata is not None and not index.exists():
                    # Publish a legacy companion before its handoff. A retry
                    # verifies this companion before publishing/reusing the md.
                    with index.open("xb") as f:
                        f.write(entry.metadata)
                if staged.is_dir():
                    # macOS requires a writable directory for rename. Change
                    # only our staged inode, restoring its source mode even if
                    # an interruption is raised just after publication.
                    before = staged.stat()
                    mode = stat.S_IMODE(before.st_mode)
                    staged.chmod(mode | stat.S_IWUSR | stat.S_IXUSR)
                    try:
                        os.rename(str(staged), str(output))
                    finally:
                        for location in (staged, output):
                            if location.exists():
                                actual = location.stat()
                                if (actual.st_dev, actual.st_ino) == (before.st_dev, before.st_ino):
                                    location.chmod(mode)
                                    break
                else:
                    # Hard link publication cannot clobber an existing file.
                    os.link(str(staged), str(output))
            self.claimed.add(output)
            entry.output = output
            if index is not None and entry.metadata is not None:
                entry.metadata_output = index
            return
        raise ValueError("cannot allocate an unoccupied parent destination")


def copy_parents(parents, dest):
    """Return (original, copied, exists); errors never certify a partial graph."""
    if not parents:
        return []
    graph = _Graph(dest)
    roots = []
    for original in parents:
        path = _safe_path(original)
        roots.append((original, graph.add(original, True) if path.exists() else None))
    if not graph.entries:
        return [(original, None, False) for original, _ in roots]
    graph.dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".parent-copy-", dir=str(graph.dest)) as stage:
        graph.stage = Path(stage)
        for _, entry in roots:
            if entry is not None:
                graph.materialize(entry)
        # Verify the exact published targets, including all blobs and opaque
        # auxiliary bytes, before the caller may print its ready message.
        for entry in graph.entries.values():
            if _inventory(entry.output) != entry.expected:
                raise OSError("parent copy verification failed: %s" % entry.output)
            if entry.metadata_output is not None and entry.metadata_output.read_bytes() != entry.metadata:
                raise OSError("parent storage verification failed: %s" % entry.metadata_output)
    if graph.warnings:
        import sys
        print("warning: unverified legacy descriptive parent paths in: " + ", ".join(sorted(graph.warnings)), file=sys.stderr)

    def shown(entry):
        # Callers link these relative to `dest` as they spelled it.
        output = _given(dest) / entry.output.relative_to(graph.dest)
        return str(output / "HANDOFF.md" if entry.folder else output)
    return [(original, shown(entry), True) if entry is not None else (original, None, False) for original, entry in roots]
