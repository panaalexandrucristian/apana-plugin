#!/usr/bin/env python3
"""Hybrid code search: Qwen3-Embedding-0.6B (dense) + BM25, fused with reciprocal rank fusion.

  code_rag.py index  [--repo DIR] [--dry-run] [--max-seconds N] [--limit-files N] [--ext .x,.y]
  code_rag.py search [--repo DIR] "question" [--k 5] [--snippet 4] [--json]
  code_rag.py status [--repo DIR]
  code_rag.py where  [--repo DIR]      print the index folder
  code_rag.py drop   [--repo DIR]      delete the index

The index lives under $CODE_RAG_HOME/indexes (default ~/.cache/code-rag), never inside the project.
`index` is resumable and incremental: a file is stored together with its chunks in one transaction, and
a file whose content is unchanged is not embedded again.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

MODEL = "Qwen/Qwen3-Embedding-0.6B"
QUERY_PROMPT = "Instruct: Given a natural language description, retrieve the source code that implements it\nQuery: "
SCHEMA = 1
RRF_K = 60
POOL = 100
MAX_SEQ = 512
BATCH = 16
FLUSH_CHUNKS = 256
MAX_CHARS = 1500
MAX_FILE_BYTES = 1_000_000
LINES_PER_CHUNK = 12.6  # dgapp2: 180,551 lines -> 14,335 AST chunks (measured, n=1)
CHUNKS_PER_SECOND = 9.4  # Qwen3-0.6B fp16 on MPS, Apple M3 16 GB (measured, n=1)
EXIT_NO_INDEX = 4
EXIT_LOCKED = 5
SKIP_DIRS = {".git", ".gradle", ".idea", ".code-rag", ".venv", "venv", "build", "out", "dist", "target", "generated",
             "node_modules", "Pods", "DerivedData", "__pycache__", ".next"}
LANG = {".kt": "kotlin", ".kts": "kotlin", ".java": "java", ".py": "python", ".js": "javascript",
        ".jsx": "javascript", ".ts": "typescript", ".tsx": "tsx", ".go": "go", ".rs": "rust", ".c": "c",
        ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".swift": "swift",
        ".rb": "ruby", ".php": "php", ".scala": "scala", ".cs": "csharp"}
_split = re.compile(r"[A-Za-z]+|\d+")
_camel = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def code_rag_home():
    return Path(os.environ.get("CODE_RAG_HOME") or Path.home() / ".cache" / "code-rag")


def resolve_repo(arg):
    start = Path(arg or os.getcwd()).resolve()
    if arg is None:
        done = subprocess.run(["git", "-C", str(start), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        if done.returncode == 0 and done.stdout.strip():
            return Path(done.stdout.strip())
    return start


def index_dir(repo):
    digest = hashlib.sha1(str(repo).encode()).hexdigest()[:10]
    return code_rag_home() / "indexes" / f"{repo.name}-{digest}"


def tokenize(text):
    """Letters and digits runs; camelCase parts, plus the whole identifier when it has several parts."""
    out = []
    for word in _split.findall(text):
        parts = [p.lower() for p in _camel.split(word) if p]
        out.extend(parts)
        if len(parts) > 1:
            out.append(word.lower())
    return out


def rrf(rank_lists, k=RRF_K):
    """Reciprocal rank fusion: score = sum of 1 / (k + rank), rank starting at 1. Returns {id: score}."""
    score = {}
    for ranking in rank_lists:
        for rank, item in enumerate(ranking, start=1):
            score[item] = score.get(item, 0.0) + 1.0 / (k + rank)
    return score


def list_files(repo, exts):
    names = None
    if (repo / ".git").exists():
        done = subprocess.run(["git", "-C", str(repo), "ls-files", "-co", "--exclude-standard", "-z"],
                              capture_output=True)
        if done.returncode == 0:
            names = [n for n in done.stdout.decode("utf-8", "surrogateescape").split("\0") if n]
    if names is None:
        names = []
        for root, dirs, files in os.walk(repo):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            names.extend(os.path.relpath(os.path.join(root, f), repo) for f in files)
    keep = []
    for name in names:
        if Path(name).suffix.lower() not in exts or SKIP_DIRS.intersection(Path(name).parts[:-1]):
            continue
        try:
            if (repo / name).stat().st_size <= MAX_FILE_BYTES:
                keep.append(name)
        except OSError:
            pass
    return sorted(set(keep))


def line_chunks(text):
    """Whole lines up to MAX_CHARS each: [(start_line, end_line, text)], 1-based and inclusive."""
    out, buf, size, start = [], [], 0, 1
    for number, line in enumerate(text.splitlines(keepends=True), start=1):
        if size + len(line) > MAX_CHARS and buf:
            out.append((start, number - 1, "".join(buf)))
            buf, size, start = [], 0, number
        buf.append(line)
        size += len(line)
    if buf:
        out.append((start, start + len(buf) - 1, "".join(buf)))
    return out


_splitters = {}


def ast_splitter(language):
    if language not in _splitters:
        try:
            from llama_index.core.node_parser import CodeSplitter
            _splitters[language] = CodeSplitter(language=language)
            _splitters[language].split_text("\n")
        except Exception:
            _splitters[language] = None
    return _splitters[language]


def ast_chunks(text, language):
    """CodeSplitter chunks (default parameters) with line numbers found by searching the text, as measured."""
    splitter = ast_splitter(language)
    if splitter is None:
        return None
    try:
        pieces = splitter.split_text(text)
    except Exception:
        return None
    data, cursor, out = text.encode("utf-8"), 0, []
    for piece in pieces:
        raw = piece.encode("utf-8")
        at = data.find(raw, cursor)
        if at < 0:
            at = data.find(raw)
        if at < 0:
            continue
        cursor = at
        start = data.count(b"\n", 0, at) + 1
        out.append((start, start + raw.rstrip(b"\n").count(b"\n"), piece))
    return out or None


def chunk_file(rel, text):
    """Returns (chunks, used_ast); a chunk is (start_line, end_line, text)."""
    language = LANG.get(Path(rel).suffix.lower())
    chunks = ast_chunks(text, language) if language else None
    used_ast = chunks is not None
    if chunks is None:
        chunks = line_chunks(text)
    return [c for c in chunks if c[2].strip()], used_ast


class Store:
    """SQLite: one row per file and per chunk. A file and its chunks change in one transaction."""

    def __init__(self, folder):
        folder.mkdir(parents=True, exist_ok=True)
        self.folder = folder
        self.db = sqlite3.connect(str(folder / "index.sqlite"))
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
            CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, sha1 TEXT, mtime_ns INTEGER, size INTEGER,
                                             nchunks INTEGER);
            CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, sl INTEGER,
                                              el INTEGER, text TEXT, vec BLOB);
            CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);""")

    def meta(self, key, default=None):
        row = self.db.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
        return row[0] if row else default

    def set_meta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, str(value)))

    def bump(self):
        self.set_meta("generation", int(self.meta("generation", 0)) + 1)

    def files(self):
        return {r[0]: r[1:] for r in self.db.execute("SELECT path, sha1, mtime_ns, size, nchunks FROM files")}

    def put_file(self, rel, sha1, mtime_ns, size, chunks, vectors):
        with self.db:
            self.db.execute("DELETE FROM chunks WHERE path=?", (rel,))
            self.db.executemany("INSERT INTO chunks(path, sl, el, text, vec) VALUES(?,?,?,?,?)",
                                [(rel, c[0], c[1], c[2], v) for c, v in zip(chunks, vectors)])
            self.db.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)", (rel, sha1, mtime_ns, size, len(chunks)))
            self.bump()

    def touch_file(self, rel, mtime_ns, size):
        with self.db:
            self.db.execute("UPDATE files SET mtime_ns=?, size=? WHERE path=?", (mtime_ns, size, rel))

    def delete_files(self, paths):
        with self.db:
            for rel in paths:
                self.db.execute("DELETE FROM chunks WHERE path=?", (rel,))
                self.db.execute("DELETE FROM files WHERE path=?", (rel,))
            self.bump()

    def counts(self):
        return (self.db.execute("SELECT COUNT(*) FROM files").fetchone()[0],
                self.db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])

    def close(self):
        self.db.close()


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class Lock:
    def __init__(self, folder):
        self.path = folder / "index.lock"

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            try:
                pid = int(self.path.read_text().strip())
            except ValueError:
                pid = 0
            if pid and pid != os.getpid() and pid_alive(pid):
                print(f"another index run (pid {pid}) is using {self.path.parent}", file=sys.stderr)
                raise SystemExit(EXIT_LOCKED)
        self.path.write_text(str(os.getpid()))
        return self

    def __exit__(self, *exc):
        self.path.unlink(missing_ok=True)


def fingerprint(path):
    st = path.stat()
    return st.st_mtime_ns, st.st_size


def scan_changes(repo, store, exts):
    """(todo, removed, total): files whose mtime or size differ from the index, indexed files now gone."""
    names = list_files(repo, exts)
    known = store.files()
    todo = []
    for rel in names:
        mtime_ns, size = fingerprint(repo / rel)
        row = known.get(rel)
        if row is None or (row[1], row[2]) != (mtime_ns, size):
            todo.append(rel)
    return todo, sorted(set(known) - set(names)), len(names)


def run_index(repo, folder, embed, exts, limit_files=None, max_seconds=None, log=print, clock=time.monotonic):
    """Index new and changed files. embed(texts) -> list of bytes (one vector each). Returns a stats dict."""
    stats = {"files": 0, "chunks": 0, "skipped_unchanged": 0, "removed": 0, "line_chunked": 0, "stopped_early": False}
    with Lock(folder):
        store = Store(folder)
        built_with = store.meta("model")
        if built_with and built_with != MODEL:
            store.close()
            raise SystemExit(f"{folder} was built with {built_with}, not {MODEL}; run drop and index again")
        store.set_meta("schema", SCHEMA)
        store.set_meta("model", MODEL)
        store.set_meta("repo", repo)
        todo, removed, total = scan_changes(repo, store, exts)
        if removed:
            store.delete_files(removed)
            stats["removed"] = len(removed)
        if limit_files:
            todo = todo[:limit_files]
        started, pending, pending_chunks = clock(), [], 0

        def flush():
            nonlocal pending, pending_chunks
            if not pending:
                return
            texts = [c[2] for item in pending for c in item["chunks"]]
            vectors = embed(texts) if texts else []
            at = 0
            for item in pending:
                n = len(item["chunks"])
                store.put_file(item["rel"], item["sha1"], item["mtime_ns"], item["size"], item["chunks"],
                               vectors[at:at + n])
                at += n
            stats["files"] += len(pending)
            stats["chunks"] += len(texts)
            elapsed = max(clock() - started, 1e-9)
            log(f"{stats['files']}/{len(todo)} files, {stats['chunks']} chunks, "
                f"{stats['chunks'] / elapsed:.1f} chunks/s")
            pending, pending_chunks = [], 0

        known = store.files()
        for rel in todo:
            try:
                raw = (repo / rel).read_bytes()
                mtime_ns, size = fingerprint(repo / rel)
            except FileNotFoundError:  # removed since the scan (a git pull while indexing); the next run drops it
                continue
            sha1 = hashlib.sha1(raw).hexdigest()
            if rel in known and known[rel][0] == sha1:
                store.touch_file(rel, mtime_ns, size)
                stats["skipped_unchanged"] += 1
                continue
            chunks, used_ast = chunk_file(rel, raw.decode("utf-8", "replace"))
            stats["line_chunked"] += 0 if used_ast else 1
            pending.append({"rel": rel, "sha1": sha1, "mtime_ns": mtime_ns, "size": size, "chunks": chunks})
            pending_chunks += len(chunks)
            if pending_chunks >= FLUSH_CHUNKS:
                flush()
                if max_seconds and clock() - started >= max_seconds:
                    stats["stopped_early"] = True
                    break
        flush()
        store.set_meta("updated", time.strftime("%Y-%m-%d %H:%M:%S"))
        store.db.commit()
        stats["indexed_files"], stats["indexed_chunks"] = store.counts()
        stats["discovered_files"] = total
        store.close()
    return stats


def estimate(repo, exts):
    names = list_files(repo, exts)
    lines = 0
    for rel in names:
        with open(repo / rel, "rb") as handle:
            lines += sum(chunk.count(b"\n") for chunk in iter(lambda: handle.read(1 << 20), b""))
    chunks = lines / LINES_PER_CHUNK
    return {"files": len(names), "lines": lines, "estimated_chunks": round(chunks),
            "estimated_minutes": round(chunks / CHUNKS_PER_SECOND / 60, 1),
            "basis": f"{LINES_PER_CHUNK} lines/chunk and {CHUNKS_PER_SECOND} chunks/s, measured once on an Apple M3"}


# ---- embedding (needs torch) and the search caches (need numpy and bm25s) ----

def device_name():
    import torch
    return "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"


class Embedder:
    def __init__(self):
        self._model = None

    @property
    def model(self):
        if self._model is None:
            import torch
            from sentence_transformers import SentenceTransformer
            device = device_name()
            dtype = torch.float32 if device == "cpu" else torch.float16
            self._model = SentenceTransformer(MODEL, device=device, tokenizer_kwargs={"padding_side": "left"},
                                              model_kwargs={"torch_dtype": dtype})
            self._model.max_seq_length = MAX_SEQ
        return self._model

    def docs(self, texts):
        import numpy as np
        vectors = self.model.encode(texts, batch_size=BATCH, normalize_embeddings=True, show_progress_bar=False)
        return [row.tobytes() for row in vectors.astype(np.float16)]

    def query(self, text):
        import numpy as np
        return self.model.encode([QUERY_PROMPT + text], normalize_embeddings=True,
                                 show_progress_bar=False)[0].astype(np.float32)


class FakeEmbedder:
    """Deterministic hashed bag-of-words vectors for tests (CODE_RAG_FAKE_EMBED=1); no model needed."""
    DIM = 64

    def _vec(self, text):
        import numpy as np
        v = np.zeros(self.DIM, dtype=np.float32)
        for token in tokenize(text):
            v[int(hashlib.md5(token.encode()).hexdigest(), 16) % self.DIM] += 1.0
        norm = np.linalg.norm(v)
        return v / norm if norm else v

    def docs(self, texts):
        import numpy as np
        return [self._vec(t).astype(np.float16).tobytes() for t in texts]

    def query(self, text):
        return self._vec(text)


def make_embedder():
    return FakeEmbedder() if os.environ.get("CODE_RAG_FAKE_EMBED") == "1" else Embedder()


def build_cache(store):
    """Write vectors.npy, ids.npy and the BM25 index for the current generation."""
    import bm25s
    import numpy as np
    folder = store.folder
    count = store.db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    ids, matrix, corpus, dim = np.zeros(count, dtype=np.int64), None, [], None
    for at, (chunk_id, text, vec) in enumerate(store.db.execute("SELECT id, text, vec FROM chunks ORDER BY id")):
        row = np.frombuffer(vec, dtype=np.float16)
        if matrix is None:
            dim = row.shape[0]
            matrix = np.zeros((count, dim), dtype=np.float16)
        matrix[at], ids[at] = row, chunk_id
        corpus.append(tokenize(text))
    if matrix is None:
        return False
    retriever = bm25s.BM25()
    retriever.index(corpus, show_progress=False)
    retriever.save(str(folder / "bm25"))
    np.save(folder / "vectors.npy", matrix)
    np.save(folder / "ids.npy", ids)
    (folder / "cache.json").write_text(json.dumps({"generation": int(store.meta("generation", 0))}))
    return True


def cache_fresh(store):
    try:
        done = json.loads((store.folder / "cache.json").read_text())["generation"]
    except (OSError, ValueError, KeyError):
        return False
    return done == int(store.meta("generation", 0)) and (store.folder / "vectors.npy").exists()


def dense_ranking(matrix, query, pool=POOL):
    import numpy as np
    scores = np.empty(matrix.shape[0], dtype=np.float32)
    for lo in range(0, matrix.shape[0], 20000):
        scores[lo:lo + 20000] = matrix[lo:lo + 20000].astype(np.float32) @ query
    top = np.argpartition(-scores, min(pool, len(scores) - 1))[:pool]
    return [int(i) for i in top[np.argsort(-scores[top])]]


def bm25_ranking(folder, question, pool=POOL):
    import bm25s
    retriever = bm25s.BM25.load(str(folder / "bm25"))
    terms = [t for t in tokenize(question) if t in retriever.vocab_dict]
    if not terms:
        return []
    docs, _ = retriever.retrieve([terms], k=min(pool, retriever.scores["num_docs"]), show_progress=False)
    return [int(i) for i in docs[0]]


def overlaps(a, b):
    return a[0] == b[0] and a[1] <= b[2] and b[1] <= a[2]


TEST_PATH = re.compile(r"(^|/)(test|androidTest|shared-test)/|Test\.(kt|java)$")


def search(store, question, embedder, k=5, snippet=4, tests=True):
    import numpy as np
    if not cache_fresh(store):
        build_cache(store)
    matrix, ids = np.load(store.folder / "vectors.npy", mmap_mode="r"), np.load(store.folder / "ids.npy")
    dense = dense_ranking(matrix, embedder.query(question))
    lexical = bm25_ranking(store.folder, question)
    fused = rrf([dense, lexical])
    where = {"dense": {pos: r for r, pos in enumerate(dense, 1)}, "bm25": {pos: r for r, pos in enumerate(lexical, 1)}}
    results, seen = [], []
    for pos in sorted(fused, key=fused.get, reverse=True):
        row = store.db.execute("SELECT path, sl, el, text FROM chunks WHERE id=?", (int(ids[pos]),)).fetchone()
        if row is None or (not tests and TEST_PATH.search(row[0])) or any(overlaps(row, other) for other in seen):
            continue
        seen.append(row)
        lines = [ln.strip()[:140] for ln in row[3].splitlines() if ln.strip()][:snippet]
        results.append({"path": row[0], "start": row[1], "end": row[2], "rrf": round(fused[pos], 4),
                        "dense_rank": where["dense"].get(pos), "bm25_rank": where["bm25"].get(pos), "snippet": lines})
        if len(results) == k:
            break
    return results


def status(repo, folder, exts):
    if not (folder / "index.sqlite").exists():
        return None
    store = Store(folder)
    todo, removed, total = scan_changes(repo, store, exts)
    files, chunks = store.counts()
    info = {"repo": str(repo), "index": str(folder), "indexed_files": files, "indexed_chunks": chunks,
            "discovered_files": total, "changed_or_new_files": len(todo), "removed_files": len(removed),
            "updated": store.meta("updated"), "model": store.meta("model"), "cache_fresh": cache_fresh(store)}
    store.close()
    return info


def parse_exts(value):
    exts = set(LANG)
    for ext in (value or "").split(","):
        if ext.strip():
            exts.add(("." + ext.strip().lstrip(".")).lower())
    return exts


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("index", "search", "status", "where", "drop"):
        p = sub.add_parser(name)
        p.add_argument("--repo")
        p.add_argument("--ext", help="extra extensions to index, comma separated (line chunks, no AST)")
        if name == "index":
            p.add_argument("--dry-run", action="store_true")
            p.add_argument("--max-seconds", type=float)
            p.add_argument("--limit-files", type=int)
        if name == "search":
            p.add_argument("question")
            p.add_argument("--k", type=int, default=5)
            p.add_argument("--snippet", type=int, default=4)
            p.add_argument("--json", action="store_true")
            p.add_argument("--no-tests", action="store_true", help="leave test files out of the results")
    args = ap.parse_args(argv)
    repo = resolve_repo(args.repo)
    folder = index_dir(repo)
    exts = parse_exts(args.ext)

    if args.cmd == "where":
        print(folder)
    elif args.cmd == "drop":
        shutil.rmtree(folder, ignore_errors=True)
        print(f"removed {folder}")
    elif args.cmd == "status":
        info = status(repo, folder, exts)
        if info is None:
            print(f"no index for {repo}")
            return EXIT_NO_INDEX
        print(json.dumps(info))
    elif args.cmd == "index":
        if args.dry_run:
            print(json.dumps(estimate(repo, exts)))
            return 0
        embedder = make_embedder()
        stats = run_index(repo, folder, embedder.docs, exts, args.limit_files, args.max_seconds,
                          log=lambda m: print(m, flush=True))
        store = Store(folder)
        if not cache_fresh(store):
            build_cache(store)
        store.close()
        print(json.dumps(stats))
    elif args.cmd == "search":
        if not (folder / "index.sqlite").exists():
            print(f"no index for {repo}; run: code-rag index --repo {repo}")
            return EXIT_NO_INDEX
        store = Store(folder)
        changed, removed, _ = scan_changes(repo, store, exts)
        results = search(store, args.question, make_embedder(), args.k, args.snippet, not args.no_tests)
        store.close()
        if args.json:
            print(json.dumps({"results": results, "changed_since_index": len(changed) + len(removed)}))
        else:
            for n, r in enumerate(results, 1):
                print(f"{n}. {r['path']}:{r['start']}-{r['end']}  rrf={r['rrf']} dense=#{r['dense_rank']} "
                      f"bm25=#{r['bm25_rank']}")
                for line in r["snippet"]:
                    print(f"     {line}")
            if changed or removed:
                print(f"note: {len(changed)} files changed or new and {len(removed)} removed since the last index; "
                      f"line numbers may have moved, run index to refresh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
