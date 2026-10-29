import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import code_rag as cr

HAVE_NUMPY_BM25 = all(importlib.util.find_spec(m) for m in ("numpy", "bm25s"))
HAVE_AST = all(importlib.util.find_spec(m) for m in ("llama_index", "tree_sitter_language_pack"))
EXTS = set(cr.LANG)


def write(repo, rel, text):
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def fake_embed(calls):
    def embed(texts):
        calls.append(list(texts))
        return [b"\x00\x01" for _ in texts]
    return embed


class PureLogicTest(unittest.TestCase):
    def test_tokenize_splits_camel_case_and_keeps_the_whole_identifier(self):
        self.assertEqual(cr.tokenize("getUserName2"), ["get", "user", "name", "getusername", "2"])
        self.assertEqual(cr.tokenize("HTTPServer"), ["http", "server", "httpserver"])
        self.assertEqual(cr.tokenize("load"), ["load"])
        self.assertEqual(cr.tokenize("snake_case_name"), ["snake", "case", "name"])

    def test_rrf_adds_reciprocal_ranks_and_rewards_agreement(self):
        score = cr.rrf([[1, 2, 3], [3, 1]])
        self.assertAlmostEqual(score[1], 1 / 61 + 1 / 62)
        self.assertAlmostEqual(score[2], 1 / 62)
        self.assertEqual(max(score, key=score.get), 1)
        self.assertGreater(score[3], score[2])

    def test_line_chunks_cut_on_line_boundaries_and_keep_numbers(self):
        text = "".join(f"line{i:03d} " + "x" * 40 + "\n" for i in range(1, 101))
        chunks = cr.line_chunks(text)
        self.assertGreater(len(chunks), 1)
        self.assertEqual(chunks[0][0], 1)
        for (s1, e1, _), (s2, _, _) in zip(chunks, chunks[1:]):
            self.assertEqual(s2, e1 + 1)
        self.assertEqual(chunks[-1][1], 100)
        self.assertEqual("".join(c[2] for c in chunks), text)
        self.assertTrue(all(len(c[2]) <= cr.MAX_CHARS for c in chunks))

    def test_chunk_file_falls_back_to_lines_without_a_splitter(self):
        with mock.patch.object(cr, "ast_splitter", return_value=None):
            chunks, used_ast = cr.chunk_file("a.kt", "fun a() {}\n\nfun b() {}\n")
        self.assertFalse(used_ast)
        self.assertEqual(chunks, [(1, 3, "fun a() {}\n\nfun b() {}\n")])

    def test_ast_chunk_line_numbers_follow_overlapping_pieces(self):
        text = "a1\na2\na3\na4\na5\na6\n"

        class Splitter:
            def split_text(self, _):
                return ["a1\na2\na3\n", "a3\na4\na5\n", "a5\na6\n"]

        with mock.patch.object(cr, "ast_splitter", return_value=Splitter()):
            chunks, used_ast = cr.chunk_file("x.kt", text)
        self.assertTrue(used_ast)
        self.assertEqual([(c[0], c[1]) for c in chunks], [(1, 3), (3, 5), (5, 6)])

    def test_blank_chunks_are_dropped(self):
        with mock.patch.object(cr, "ast_splitter", return_value=None):
            self.assertEqual(cr.chunk_file("a.kt", "\n\n  \n")[0], [])


class ListFilesTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())

    def test_extension_skip_dirs_and_size(self):
        write(self.repo, "src/A.kt", "x")
        write(self.repo, "src/B.java", "x")
        write(self.repo, "src/notes.txt", "x")
        write(self.repo, "build/gen/C.kt", "x")
        write(self.repo, "node_modules/d/e.js", "x")
        write(self.repo, "src/Big.kt", "x" * (cr.MAX_FILE_BYTES + 1))
        self.assertEqual(cr.list_files(self.repo, EXTS), ["src/A.kt", "src/B.java"])
        self.assertEqual(cr.list_files(self.repo, EXTS | {".txt"}), ["src/A.kt", "src/B.java", "src/notes.txt"])

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_git_repo_honours_gitignore_and_skips_deleted_files(self):
        write(self.repo, "keep.kt", "x")
        write(self.repo, "gone.kt", "x")
        write(self.repo, "secret.kt", "x")
        write(self.repo, ".gitignore", "secret.kt\n")
        subprocess.run(["git", "-C", str(self.repo), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "keep.kt", "gone.kt", ".gitignore"], check=True)
        (self.repo / "gone.kt").unlink()
        self.assertEqual(cr.list_files(self.repo, EXTS), ["keep.kt"])


class IndexTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.folder = Path(tempfile.mkdtemp()) / "idx"
        write(self.repo, "a.py", "def alpha():\n    return 1\n")
        write(self.repo, "b.py", "def beta():\n    return 2\n")
        write(self.repo, "c.py", "def gamma():\n    return 3\n")
        patcher = mock.patch.object(cr, "ast_splitter", return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.calls = []

    def run_index(self, **kw):
        return cr.run_index(self.repo, self.folder, fake_embed(self.calls), EXTS, log=lambda m: None, **kw)

    def texts(self):
        return sorted(t for call in self.calls for t in call)

    def test_second_run_embeds_nothing(self):
        first = self.run_index()
        self.assertEqual((first["files"], first["chunks"], first["indexed_files"]), (3, 3, 3))
        self.calls.clear()
        again = self.run_index()
        self.assertEqual((again["files"], again["chunks"]), (0, 0))
        self.assertEqual(self.calls, [])

    def test_file_deleted_after_the_scan_is_skipped_not_fatal(self):
        scan = cr.scan_changes

        def scan_then_delete(*args):
            found = scan(*args)
            (self.repo / "b.py").unlink()  # what a git pull does while the index runs
            return found

        with mock.patch.object(cr, "scan_changes", scan_then_delete):
            stats = self.run_index()
        self.assertEqual((stats["files"], stats["indexed_files"]), (2, 2))

    def test_changed_file_is_re_embedded_alone_and_its_chunks_replaced(self):
        self.run_index()
        self.calls.clear()
        write(self.repo, "b.py", "def beta():\n    return 22\n\ndef delta():\n    return 4\n")
        stats = self.run_index()
        self.assertEqual(stats["files"], 1)
        self.assertEqual(len(self.texts()), 1)
        self.assertIn("delta", self.texts()[0])
        store = cr.Store(self.folder)
        self.assertEqual(store.counts(), (3, 3))
        self.assertEqual(store.db.execute("SELECT COUNT(*) FROM chunks WHERE path='b.py'").fetchone()[0], 1)

    def test_touch_without_content_change_is_not_embedded(self):
        self.run_index()
        self.calls.clear()
        path = self.repo / "a.py"
        path.write_text(path.read_text())
        os.utime(path, ns=(1, 1))
        stats = self.run_index()
        self.assertEqual(stats["skipped_unchanged"], 1)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.run_index()["skipped_unchanged"], 0)

    def test_deleted_file_leaves_the_index(self):
        self.run_index()
        (self.repo / "c.py").unlink()
        stats = self.run_index()
        self.assertEqual((stats["removed"], stats["indexed_files"], stats["indexed_chunks"]), (1, 2, 2))

    def test_interrupted_run_resumes_with_the_remaining_files(self):
        calls = []

        def flaky(texts):
            calls.append(list(texts))
            if len(calls) == 2:
                raise RuntimeError("laptop slept")
            return [b"\x00" for _ in texts]

        with mock.patch.object(cr, "FLUSH_CHUNKS", 1):
            with self.assertRaises(RuntimeError):
                cr.run_index(self.repo, self.folder, flaky, EXTS, log=lambda m: None)
            self.assertEqual(cr.Store(self.folder).counts(), (1, 1))
            self.calls.clear()
            self.run_index()
        self.assertEqual(len(self.texts()), 2)
        self.assertEqual(cr.Store(self.folder).counts(), (3, 3))

    def test_max_seconds_stops_after_a_flush_and_the_next_run_finishes(self):
        ticks = iter(range(0, 1000, 10))
        with mock.patch.object(cr, "FLUSH_CHUNKS", 1):
            stats = self.run_index(max_seconds=15, clock=lambda: next(ticks))
            self.assertTrue(stats["stopped_early"])
            self.assertLess(stats["indexed_files"], 3)
            rest = self.run_index()
        self.assertEqual(rest["indexed_files"], 3)
        self.assertFalse(rest["stopped_early"])

    def test_limit_files(self):
        self.assertEqual(self.run_index(limit_files=2)["indexed_files"], 2)

    def test_live_lock_of_another_process_blocks_a_run_and_a_dead_one_does_not(self):
        self.folder.mkdir(parents=True)
        (self.folder / "index.lock").write_text(str(os.getppid()))
        with self.assertRaises(SystemExit) as error:
            self.run_index()
        self.assertEqual(error.exception.code, cr.EXIT_LOCKED)
        self.assertEqual((self.folder / "index.lock").read_text(), str(os.getppid()))
        dead = subprocess.Popen(["true"])
        dead.wait()
        (self.folder / "index.lock").write_text(str(dead.pid))
        self.assertEqual(self.run_index()["indexed_files"], 3)
        self.assertFalse((self.folder / "index.lock").exists())

    def test_index_built_with_another_model_is_refused(self):
        self.run_index()
        store = cr.Store(self.folder)
        store.set_meta("model", "other/model")
        store.db.commit()
        store.close()
        with self.assertRaises(SystemExit):
            self.run_index()

    def test_estimate_uses_the_measured_ratios(self):
        info = cr.estimate(self.repo, EXTS)
        self.assertEqual((info["files"], info["lines"]), (3, 6))
        self.assertEqual(info["estimated_chunks"], round(6 / cr.LINES_PER_CHUNK))


@unittest.skipUnless(HAVE_NUMPY_BM25, "needs numpy and bm25s (the code-rag venv)")
class SearchTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.home = Path(tempfile.mkdtemp())
        write(self.repo, "net/Parser.kt",
              "class ConfigParser {\n  fun parseJsonConfig(text: String): Config {\n    return decodeJson(text)\n  }\n}\n")
        write(self.repo, "ui/Button.kt", "class SubmitButton {\n  fun renderButtonLabel() = draw(label)\n}\n")
        write(self.repo, "db/Store.py", "def save_order_to_database(order):\n    connection.insert(order)\n")
        env = mock.patch.dict(os.environ, {"CODE_RAG_HOME": str(self.home), "CODE_RAG_FAKE_EMBED": "1"})
        env.start()
        self.addCleanup(env.stop)
        patcher = mock.patch.object(cr, "ast_splitter", return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cr.main(list(argv))
        return code, out.getvalue()

    def test_search_without_index_exits_4(self):
        code, out = self.cli("search", "--repo", str(self.repo), "anything")
        self.assertEqual(code, cr.EXIT_NO_INDEX)
        self.assertIn("code-rag index", out)

    def test_index_then_search_finds_the_matching_file_first(self):
        code, _ = self.cli("index", "--repo", str(self.repo))
        self.assertEqual(code, 0)
        code, out = self.cli("search", "--repo", str(self.repo), "--json", "parse json config text")
        top = json.loads(out)["results"][0]
        self.assertEqual(top["path"], "net/Parser.kt")
        self.assertEqual((top["start"], top["end"]), (1, 5))
        self.assertEqual(top["dense_rank"], 1)
        self.assertEqual(top["bm25_rank"], 1)
        code, out = self.cli("search", "--repo", str(self.repo), "save order database")
        self.assertTrue(out.startswith("1. db/Store.py:1-2"))

    def test_status_counts_and_staleness(self):
        self.cli("index", "--repo", str(self.repo))
        info = json.loads(self.cli("status", "--repo", str(self.repo))[1])
        self.assertEqual((info["indexed_files"], info["changed_or_new_files"], info["cache_fresh"]), (3, 0, True))
        write(self.repo, "ui/Button.kt", "class SubmitButton {}\n")
        write(self.repo, "new/Other.kt", "class Other {}\n")
        info = json.loads(self.cli("status", "--repo", str(self.repo))[1])
        self.assertEqual(info["changed_or_new_files"], 2)
        out = self.cli("search", "--repo", str(self.repo), "button")[1]
        self.assertIn("2 files changed or new", out)

    def test_cache_is_rebuilt_after_an_incremental_index(self):
        self.cli("index", "--repo", str(self.repo))
        write(self.repo, "db/Store.py", "def delete_customer_account(acct):\n    connection.remove(acct)\n")
        self.cli("index", "--repo", str(self.repo))
        out = json.loads(self.cli("search", "--repo", str(self.repo), "--json", "delete customer account")[1])
        self.assertEqual(out["results"][0]["path"], "db/Store.py")
        self.assertEqual(out["changed_since_index"], 0)

    def test_overlapping_chunks_of_one_file_are_reported_once(self):
        class Splitter:
            def split_text(self, text):
                lines = text.splitlines(keepends=True)
                return ["".join(lines[:4]), "".join(lines[2:])]

        write(self.repo, "big/Many.kt", "".join(f"fun worker{i}() = ordersQueue.process{i}()\n" for i in range(8)))
        with mock.patch.object(cr, "ast_splitter", return_value=Splitter()):
            self.cli("index", "--repo", str(self.repo))
        out = json.loads(self.cli("search", "--repo", str(self.repo), "--json", "--k", "10", "worker orders queue")[1])
        spans = [(r["start"], r["end"]) for r in out["results"] if r["path"] == "big/Many.kt"]
        self.assertEqual(len(spans), 1)

    def test_no_tests_leaves_test_files_out_of_the_results(self):
        # path shapes measured in architecture-samples and dgapp2-android (n=2 repos)
        tests = ["app/src/test/Order.kt", "app/src/androidTest/pkg/Order.kt", "shared-test/src/main/Order.kt",
                 "app/src/main/OrderTest.kt", "app/src/main/OrderTest.java"]
        for path in tests:
            write(self.repo, path, "fun checkoutOrderTotal() = sumOrderPrices()\n")
        write(self.repo, "app/src/main/Order.kt", "fun checkoutOrderTotal() = sumOrderPrices()\n")
        write(self.repo, "app/src/main/RebatesTutorial.kt", "fun checkoutOrderTotal() = sumOrderPrices()\n")
        self.cli("index", "--repo", str(self.repo))
        question = ("search", "--repo", str(self.repo), "--json", "--k", "20", "checkout order total")
        every = {r["path"] for r in json.loads(self.cli(*question)[1])["results"]}
        self.assertTrue(set(tests) <= every)
        kept = {r["path"] for r in json.loads(self.cli(*question, "--no-tests")[1])["results"]}
        self.assertEqual({p for p in kept if p.startswith("app/") or p.startswith("shared-test/")},
                         {"app/src/main/Order.kt", "app/src/main/RebatesTutorial.kt"})

    def test_drop_removes_the_index(self):
        self.cli("index", "--repo", str(self.repo))
        self.assertTrue(cr.index_dir(self.repo.resolve()).exists())
        self.cli("drop", "--repo", str(self.repo))
        self.assertFalse(cr.index_dir(self.repo.resolve()).exists())


@unittest.skipUnless(HAVE_AST, "needs llama-index-core and tree-sitter-language-pack (the code-rag venv)")
class AstTest(unittest.TestCase):
    def test_kotlin_functions_are_chunked_with_correct_lines(self):
        body = "".join(f"    val v{i} = compute({i})\n" for i in range(30))
        text = "package demo\n\nclass A {\n    fun first(): Int {\n" + body + "        return 1\n    }\n\n" \
               "    fun second(): Int {\n" + body + "        return 2\n    }\n}\n"
        chunks, used_ast = cr.chunk_file("A.kt", text)
        self.assertTrue(used_ast)
        lines = text.splitlines()
        for start, end, piece in chunks:
            self.assertIn(piece.strip(), "\n".join(lines[start - 1:end]))
        self.assertTrue(any("fun second" in c[2] for c in chunks))

    def test_unknown_language_falls_back_to_lines(self):
        self.assertFalse(cr.chunk_file("a.unknownext", "hello\n")[1])


class SkillFilesTest(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[2]

    def frontmatter(self, skill):
        text = (self.ROOT / skill / "SKILL.md").read_text()
        return re.match(r"---\n(.*?)\n---\n", text, re.S).group(1)

    def test_neither_skill_declares_hooks(self):
        for skill in ("code-rag", "code-rag-setup"):
            front = self.frontmatter(skill)
            self.assertNotRegex(front, r"(?m)^hooks\s*:", skill)
            self.assertIn(f"name: {skill}", front)

    def test_code_rag_wrapper_exists_and_is_executable(self):
        wrapper = Path(__file__).resolve().parent / "code-rag"
        self.assertTrue(os.access(wrapper, os.X_OK))


if __name__ == "__main__":
    unittest.main()
