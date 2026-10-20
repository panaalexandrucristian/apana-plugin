import importlib.util
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("claude_scope.py")
spec = importlib.util.spec_from_file_location("claude_scope", MODULE_PATH)
claude_scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(claude_scope)


class ManifestPolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name).resolve()
        for rel in ("src/auth.js", "test/auth.test.js", "src/existing.js"):
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("// fixture\n")
        self.manifest = {
            "task_type": "feature",
            "summary": "auth change",
            "production_changes": [
                {"path": "src/auth.js", "symbols": ["login"], "reason": "requested behavior"}
            ],
            "test_changes": [
                {
                    "path": "test/auth.test.js",
                    "production_paths": ["src/auth.js"],
                    "behaviors": ["reject invalid domain"],
                    "reason": "regression",
                }
            ],
            "support_changes": [],
            "forbidden_examples": ["README.md"],
            "test_commands": [["npm", "test", "--", "test/auth.test.js"]],
            "test_command_paths": ["test/auth.test.js"],
            "red_signatures": [["regression"]],
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_accepts_exact_production_to_test_mapping(self):
        got = claude_scope.validate_manifest(self.manifest, self.root)
        self.assertEqual(got["production_changes"][0]["path"], "src/auth.js")
        self.assertEqual(got["test_changes"][0]["production_paths"], ["src/auth.js"])

    def test_rejects_globs_absolute_paths_and_traversal(self):
        for bad in ("src/**", "/etc/passwd", "../outside.js", "src/[ab].js"):
            data = json.loads(json.dumps(self.manifest))
            data["production_changes"][0]["path"] = bad
            with self.subTest(path=bad), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)

    def test_rejects_symlink_escape_and_new_file_under_symlink(self):
        outside = self.root.parent / (self.root.name + "-outside")
        outside.mkdir(exist_ok=True)
        self.addCleanup(lambda: outside.rmdir() if outside.exists() else None)
        (self.root / "escape").symlink_to(outside, target_is_directory=True)
        data = json.loads(json.dumps(self.manifest))
        data["production_changes"][0]["path"] = "escape/new.js"
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_rejects_unmapped_or_unknown_production_test(self):
        for production_paths in ([], ["src/existing.js"]):
            data = json.loads(json.dumps(self.manifest))
            data["test_changes"][0]["production_paths"] = production_paths
            with self.subTest(paths=production_paths), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)

    def test_test_path_detection_rejects_substring_false_positive_and_accepts_android_conventions(self):
        bad = json.loads(json.dumps(self.manifest))
        bad["task_type"] = "tests-only"
        bad["production_changes"] = []
        bad["test_changes"] = [{"path": "src/contest_helper.py", "production_paths": ["src/existing.js"],
                                 "behaviors": ["existing"], "reason": "not actually a test"}]
        bad["test_commands"] = [["python3", "-m", "unittest", "src.contest_helper"]]
        bad["test_command_paths"] = ["src/contest_helper.py"]
        bad["red_signatures"] = []
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(bad, self.root)
        for path, fqcn in (("app/src/androidTest/java/com/acme/ExampleInstrumentedTest.kt", "com.acme.ExampleInstrumentedTest"),
                           ("src/integrationTest/java/com/acme/FooTest.java", "com.acme.FooTest")):
            data = json.loads(json.dumps(self.manifest))
            data["task_type"] = "tests-only"
            data["production_changes"] = []
            data["test_changes"] = [{"path": path, "production_paths": ["src/existing.js"],
                                      "behaviors": ["existing"], "reason": "standard test path"}]
            data["test_commands"] = [["./gradlew", ":app:test", "--tests", fqcn]]
            data["test_command_paths"] = [path]
            data["red_signatures"] = []
            with self.subTest(path=path):
                self.assertEqual(claude_scope.validate_manifest(data, self.root)["test_changes"][0]["path"], path)

    def test_tests_only_rejects_production_path_disguised_as_test(self):
        data = json.loads(json.dumps(self.manifest))
        data["task_type"] = "tests-only"
        data["production_changes"] = []
        data["test_changes"] = [{"path": "src/existing.js", "production_paths": ["src/auth.js"],
                                  "behaviors": ["existing"], "reason": "disguised"}]
        data["test_commands"] = [["node", "--test", "src/existing.js"]]
        data["test_command_paths"] = ["src/existing.js"]
        data["red_signatures"] = []
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_all_task_types_bind_exactly_one_command_per_test_path(self):
        data = json.loads(json.dumps(self.manifest))
        data["task_type"] = "tests-only"
        data["production_changes"] = []
        data["test_changes"][0]["production_paths"] = ["src/existing.js"]
        data["red_signatures"] = []
        data["test_commands"].append(["npm", "test", "--", "test/auth.test.js"])
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)
        data = json.loads(json.dumps(self.manifest))
        data["task_type"] = "refactor"
        data["test_changes"] = []
        data["test_command_paths"] = []
        data["red_signatures"] = []
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_tests_only_is_the_explicit_exception(self):
        data = json.loads(json.dumps(self.manifest))
        data["task_type"] = "tests-only"
        data["production_changes"] = []
        data["red_signatures"] = []
        data["test_changes"][0]["production_paths"] = ["src/existing.js"]
        got = claude_scope.validate_manifest(data, self.root)
        self.assertEqual(got["task_type"], "tests-only")
        data["production_changes"] = self.manifest["production_changes"]
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_rejects_duplicate_categories_and_unknown_test_binary(self):
        data = json.loads(json.dumps(self.manifest))
        data["support_changes"] = [{"path": "src/auth.js", "reason": "duplicate"}]
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)
        data = json.loads(json.dumps(self.manifest))
        data["test_commands"] = [["curl", "https://example.com"]]
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_rejects_code_eval_test_commands(self):
        for command in (["python3", "-c", "print('pwn')"], ["node", "-e", "process.exit()"],
                        ["npx", "anything"], ["npm", "exec", "anything"]):
            data = json.loads(json.dumps(self.manifest))
            data["test_commands"] = [command]
            with self.subTest(command=command), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)

    def test_rejects_non_runner_and_preload_test_commands(self):
        for command in (
            ["node", "test/auth.test.js"],
            ["node", "--require", "./test/auth.test.js", "--test", "test/auth.test.js"],
            ["python3", "-m", "http.server", "test.auth.test"],
            ["npm", "run", "lint", "--", "test/auth.test.js"],
        ):
            data = json.loads(json.dumps(self.manifest))
            data["test_commands"] = [command]
            with self.subTest(command=command), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)

    def test_rejects_runner_options_that_load_or_execute_code(self):
        t = "test/auth.test.js"
        bad = [
            ["python3", "-m", "pytest", "-c", "evil.ini", t], ["pytest", "-cevil.ini", t],
            ["pytest", "--config-file=e", t], ["python3", "-m", "pytest", "--rootdir=/x", "-p", "evil", t],
            ["node", "--test", "--require=./e.js", t], ["node", "--test", "--import=./e.mjs", t],
            ["go", "test", "-exec", "./evil", t], ["go", "test", "-toolexec=./e", t],
            ["cargo", "test", "--config", "build.rustc-wrapper=x", t],
            ["./gradlew", "--init-script", "e.gradle", "test", "--tests", t], ["./gradlew", "-I", "e.gradle", "test", t],
            ["mvn", "-s", "e.xml", "test", t], ["npm", "test", "--script-shell=./e", "--", t],
            ["npm", "test", "--prefix=/x", "--", t], ["./gradlew", "test", "-Dfoo=" + t],
        ]
        for command in bad:
            data = json.loads(json.dumps(self.manifest))
            data["test_commands"] = [command]
            with self.subTest(command=command), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)

    def test_accepts_the_plain_runner_forms_used_in_practice(self):
        t = "test/auth.test.js"
        for command in (["npm", "test", "--", t], ["node", "--test", t], ["python3", "-m", "pytest", "-q", t],
                        ["./gradlew", ":app:testDebugUnitTest", "--tests", t]):
            data = json.loads(json.dumps(self.manifest))
            data["test_commands"] = [command]
            with self.subTest(command=command):
                claude_scope.validate_manifest(data, self.root)

    def test_refactor_regression_test_must_not_be_a_production_file_or_untracked(self):
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "src/auth.js", "test/auth.test.js"], cwd=self.root, check=True)
        base = {"task_type": "refactor", "summary": "r", "test_changes": [], "support_changes": [],
                "forbidden_examples": [], "red_signatures": []}
        ok = dict(base, production_changes=[{"path": "src/auth.js", "symbols": ["login"], "reason": "r"}],
                  test_commands=[["node", "--test", "test/auth.test.js"]], test_command_paths=["test/auth.test.js"])
        claude_scope.validate_manifest(ok, self.root)
        (self.root / "test/untracked.test.js").write_text("// x\n")
        untracked = dict(ok, test_commands=[["node", "--test", "test/untracked.test.js"]],
                         test_command_paths=["test/untracked.test.js"])
        (self.root / "test/prod.test.js").write_text("// x\n")
        subprocess.run(["git", "add", "test/prod.test.js"], cwd=self.root, check=True)
        prod = dict(ok, production_changes=[{"path": "test/prod.test.js", "symbols": ["x"], "reason": "r"}],
                    test_commands=[["node", "--test", "test/prod.test.js"]], test_command_paths=["test/prod.test.js"])
        for label, data in (("untracked", untracked), ("production", prod)):
            with self.subTest(label), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)

    def test_review3_argsfiles_and_node_script_mode_are_rejected(self):
        t = "test/auth.test.js"
        for command in (["pytest", t, "@args.txt"], ["python3", "-m", "pytest", t, "@args.txt"],
                        ["node", t, "--test"], ["node", "--test-name-pattern", "x", t, "--test"]):
            data = json.loads(json.dumps(self.manifest)); data["test_commands"] = [command]
            with self.subTest(command=command), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)

    def test_review3_precise_and_equals_forms_are_accepted(self):
        t = "test/auth.test.js"
        py = "tests/test_a.py"
        kt = "app/src/test/java/com/x/FooTest.kt"
        cases = [
            (t, ["node", "--test", "--test-name-pattern=foo", t]),
            (t, ["node", "--test", "--test-name-pattern", "foo", t]),
            (py, ["pytest", py + "::test_x", "-q"]),
            (py, ["python3", "-m", "pytest", py + "::Cls::test_x"]),
            (kt, ["./gradlew", ":app:testDebugUnitTest", "--tests=com.x.FooTest"]),
            (kt, ["./gradlew", ":app:testDebugUnitTest", "--tests", "com.x.FooTest#bar"]),
            (kt, ["./gradlew", ":app:testDebugUnitTest", "--tests", "com.x.FooTest.bar"]),
            (kt, ["mvn", "test", "-Dtest=com.x.FooTest#bar"]),
            (kt, ["mvn", "test", "-Dtest=FooTest"]),
            ("tests/foo.rs", ["cargo", "test", "--test", "foo"]),
        ]
        for path, command in cases:
            data = json.loads(json.dumps(self.manifest))
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True); target.write_text("// x\n")
            data["test_changes"][0]["path"] = path
            data["test_command_paths"] = [path]
            data["test_commands"] = [command]
            with self.subTest(command=command):
                claude_scope.validate_manifest(data, self.root)

    def test_review3_a_different_method_target_is_still_rejected(self):
        kt = "app/src/test/java/com/x/FooTest.kt"
        (self.root / kt).parent.mkdir(parents=True, exist_ok=True); (self.root / kt).write_text("// x\n")
        data = json.loads(json.dumps(self.manifest))
        data["test_changes"][0]["path"] = kt; data["test_command_paths"] = [kt]
        data["test_commands"] = [["./gradlew", ":app:testDebugUnitTest", "--tests", "com.x.OtherTest#bar"]]
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_feature_requires_production_tests_commands_and_red_signatures(self):
        for key in ("production_changes", "test_changes", "test_commands", "test_command_paths", "red_signatures"):
            data = json.loads(json.dumps(self.manifest))
            data[key] = []
            with self.subTest(key=key), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)

    def test_support_cannot_hide_code_or_tests_and_tests_only_has_no_support(self):
        for path in ("src/existing.js", "test/auth.test.js"):
            data = json.loads(json.dumps(self.manifest))
            data["support_changes"] = [{"path": path, "reason": "laundered"}]
            if path == "test/auth.test.js":
                data["test_changes"] = []
            with self.subTest(path=path), self.assertRaises(claude_scope.ManifestError):
                claude_scope.validate_manifest(data, self.root)
        data = json.loads(json.dumps(self.manifest))
        data["task_type"] = "tests-only"
        data["production_changes"] = []
        data["red_signatures"] = []
        data["test_changes"][0]["production_paths"] = ["src/existing.js"]
        data["support_changes"] = [{"path": "package.json", "reason": "not allowed"}]
        (self.root / "package.json").write_text("{}")
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)
        data = json.loads(json.dumps(self.manifest))
        data["support_changes"] = [{"path": "README.md", "reason": "not part of code/test task"}]
        (self.root / "README.md").write_text("docs")
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_rejects_canonical_alias_across_categories(self):
        alias = self.root / "alias"
        alias.symlink_to(self.root / "src", target_is_directory=True)
        data = json.loads(json.dumps(self.manifest))
        data["support_changes"] = [{"path": "alias/auth.js", "reason": "alias"}]
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_rejects_case_alias_when_filesystem_resolves_same_inode(self):
        upper = self.root / "src/CaseAlias.js"
        upper.write_text("// alias\n")
        lower = self.root / "src/casealias.js"
        if not lower.exists() or not os.path.samefile(upper, lower):
            self.skipTest("filesystem is case-sensitive")
        data = json.loads(json.dumps(self.manifest))
        data["production_changes"].append({"path": "src/CaseAlias.js", "symbols": ["a"], "reason": "one"})
        data["test_changes"][0]["production_paths"].append("src/CaseAlias.js")
        data["production_changes"].append({"path": "src/casealias.js", "symbols": ["b"], "reason": "alias"})
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_each_test_command_must_name_its_corresponding_test_file(self):
        (self.root / "src/other.js").write_text("export const other = 1;\n")
        (self.root / "test/other.test.js").write_text("// other\n")
        data = json.loads(json.dumps(self.manifest))
        data["production_changes"].append({"path": "src/other.js", "symbols": ["other"], "reason": "other"})
        data["test_changes"].append({"path": "test/other.test.js", "production_paths": ["src/other.js"],
                                     "behaviors": ["other"], "reason": "other test"})
        data["test_commands"].append(["npm", "test", "--", "test/auth.test.js"])
        data["test_command_paths"].append("test/other.test.js")
        data["red_signatures"].append(["other"])
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(data, self.root)

    def test_classifies_only_exact_canonical_targets(self):
        got = claude_scope.validate_manifest(self.manifest, self.root)
        self.assertEqual(claude_scope.classify_target(got, self.root, self.root / "src/auth.js"), "production")
        self.assertEqual(claude_scope.classify_target(got, self.root, "test/auth.test.js"), "test")
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.classify_target(got, self.root, self.root / "src/existing.js")


class TrustedCommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name).resolve()
        self.plugin = self.root / "plugin"
        self.script_dir = self.plugin / "skills/class-graph/scripts"
        self.script_dir.mkdir(parents=True)
        for name in ("class-graph.mjs", "find-usages.mjs", "find-def.mjs"):
            (self.script_dir / name).write_text("// fixture\n")
        self.repo = self.root / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_allows_exact_class_graph_invocation_for_this_worktree(self):
        cmd = f"node {self.script_dir / 'class-graph.mjs'} OrderRepository --root {self.repo} --up 1 --down 0"
        self.assertTrue(claude_scope.trusted_analysis_command(cmd, self.repo, [self.plugin]))

    def test_rejects_other_scripts_roots_and_shell_syntax(self):
        allowed = self.script_dir / "class-graph.mjs"
        cases = [
            f"node {allowed} X --root {self.root}",
            f"node {self.root / 'other.mjs'} X --root {self.repo}",
            f"node {allowed} X --root {self.repo} | head",
            f"node {allowed} X --root {self.repo}; touch pwned",
            f"node {allowed} X --root $(pwd)",
            f"node {allowed} X",
            f"node {allowed} X --root {self.repo} --out /tmp/pwned",
            f"node {allowed} X --root {self.repo} --cache-dir /tmp/cache",
            f"node {allowed} X --root {self.repo} --clear-cache",
            f"node {allowed} X --root {self.repo} --rebuild",
            f"node {allowed} X --root {self.repo} --root {self.repo}",
        ]
        for cmd in cases:
            with self.subTest(command=cmd):
                self.assertFalse(claude_scope.trusted_analysis_command(cmd, self.repo, [self.plugin]))


class PlannerAndGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name).resolve()
        (self.root / "src").mkdir()
        (self.root / "test").mkdir()
        (self.root / "src/auth.js").write_text("export const login = () => true;\n")
        (self.root / "test/auth.test.js").write_text("// test\n")
        self.valid = {
            "task_type": "bugfix",
            "summary": "fix login",
            "production_changes": [{"path": "src/auth.js", "symbols": ["login"], "reason": "bug"}],
            "test_changes": [{"path": "test/auth.test.js", "production_paths": ["src/auth.js"], "behaviors": ["regression"], "reason": "test"}],
            "support_changes": [],
            "forbidden_examples": [],
            "test_commands": [["npm", "test", "--", "test/auth.test.js"]],
            "test_command_paths": ["test/auth.test.js"],
            "red_signatures": [["regression"]],
        }

    def tearDown(self):
        self.tmp.cleanup()

    def fake_claude(self, payload):
        path = self.root / "fake-claude"
        log = self.root / "args.json"
        body = "#!/usr/bin/env python3\nimport json,sys\nopen(%r,'w').write(json.dumps(sys.argv[1:]))\nprint(json.dumps(%r))\n" % (str(log), payload)
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path, log

    def test_planner_is_read_only_and_parses_structured_manifest(self):
        fake, log = self.fake_claude({"structured_output": self.valid, "total_cost_usd": 0.01})
        manifest, meta = claude_scope.run_planner(str(fake), "Fix login", self.root, model="haiku", budget=0.2)
        args = json.loads(log.read_text())
        self.assertEqual(manifest["summary"], "fix login")
        self.assertEqual(meta["total_cost_usd"], 0.01)
        self.assertIn("--json-schema", args)
        self.assertIn("never use an ambiguous task such as testDebugUnitTest", args[1])
        self.assertIn("Prefer a test class or method identifier", args[1])
        self.assertIn("project-qualified", args[1])
        self.assertEqual(args[args.index("--tools") + 1], "Read,Glob,Grep")
        self.assertEqual(args[args.index("--allowedTools") + 1], "Read,Glob,Grep")
        self.assertEqual(args[args.index("--permission-mode") + 1], "dontAsk")
        self.assertIn("--restricted", args)
        self.assertNotIn("project", args)
        self.assertNotIn("Edit", args[args.index("--tools") + 1])

    def test_planner_fails_closed_on_bad_json_or_manifest(self):
        fake, _ = self.fake_claude({"structured_output": {"task_type": "feature"}})
        with self.assertRaises(claude_scope.WorkflowError):
            claude_scope.run_planner(str(fake), "task", self.root)
        fake.write_text("#!/bin/sh\nprintf 'not-json\\n'\n")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        with self.assertRaises(claude_scope.WorkflowError):
            claude_scope.run_planner(str(fake), "task", self.root)

    def test_generated_settings_persist_frozen_state_and_fail_closed_command_guard(self):
        manifest = claude_scope.validate_manifest(self.valid, self.root)
        state = self.root / "state.json"
        settings = claude_scope.guard_settings(
            manifest, "Fix login", state, MODULE_PATH, [self.root / "plugin"]
        )
        groups = settings["hooks"]["PreToolUse"]
        self.assertEqual(len(groups), 1)
        command = groups[0]["hooks"][0]
        self.assertEqual(command["args"][-2:], ["__hook", str(state)])
        self.assertEqual(command["onFailure"], "block")
        self.assertEqual(command["type"], "command")
        persisted = json.loads(state.read_text())
        self.assertEqual(persisted["manifest"]["summary"], "fix login")

    def test_hook_allows_manifest_path_and_denies_other_path_or_shell(self):
        manifest = claude_scope.validate_manifest(self.valid, self.root)
        state = self.root / "state.json"
        state.write_text(json.dumps({"root": str(self.root), "manifest": manifest, "plugin_roots": []}))
        allowed = {"hook_event_name": "PreToolUse", "tool_name": "Edit", "cwd": str(self.root), "tool_input": {"file_path": str(self.root / "src/auth.js")}}
        denied = {"hook_event_name": "PreToolUse", "tool_name": "Edit", "cwd": str(self.root), "tool_input": {"file_path": str(self.root / "README.md")}}
        shell = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": str(self.root), "tool_input": {"command": "touch README.md"}}
        self.assertEqual(claude_scope.evaluate_hook(allowed, state)["hookSpecificOutput"]["permissionDecision"], "allow")
        self.assertIn("permissionDecision", claude_scope.evaluate_hook(denied, state)["hookSpecificOutput"])
        self.assertEqual(claude_scope.evaluate_hook(shell, state)["hookSpecificOutput"]["permissionDecision"], "deny")


class WorktreeExecutorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / "repo"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        (self.root / "src").mkdir(); (self.root / "test").mkdir()
        (self.root / "src/value.js").write_text("export const value = 1;\n")
        (self.root / "test/value.test.js").write_text("// baseline\n")
        (self.root / "README.md").write_text("baseline\n")
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=f@example.com", "commit", "-qm", "base"], cwd=self.root, check=True)
        self.manifest = {
            "task_type": "feature", "summary": "value",
            "production_changes": [{"path": "src/value.js", "symbols": ["value"], "reason": "task"}],
            "test_changes": [{"path": "test/value.test.js", "production_paths": ["src/value.js"], "behaviors": ["value two"], "reason": "test"}],
            "support_changes": [], "forbidden_examples": ["README.md"],
            "test_commands": [["node", "--test", "test/value.test.js"]],
            "test_command_paths": ["test/value.test.js"],
            "red_signatures": [["value two"]],
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_refuses_dirty_repository_before_planning(self):
        (self.root / "src/value.js").write_text("dirty\n")
        with self.assertRaises(claude_scope.WorkflowError):
            claude_scope.require_clean_repository(self.root)

    def test_temporary_worktree_is_isolated_and_removed(self):
        state = pathlib.Path(self.tmp.name) / "state"
        with claude_scope.isolated_worktree(self.root, state) as worktree:
            (worktree / "src/value.js").write_text("changed\n")
            self.assertEqual((self.root / "src/value.js").read_text(), "export const value = 1;\n")
            path = worktree
        self.assertFalse(path.exists())
        self.assertNotIn(str(path), subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=self.root, text=True, capture_output=True).stdout)

    def test_audit_accepts_only_manifest_files_and_catches_untracked(self):
        manifest = claude_scope.validate_manifest(self.manifest, self.root)
        (self.root / "src/value.js").write_text("export const value = 2;\n")
        self.assertEqual(claude_scope.audit_changed_paths(self.root, manifest), ["src/value.js"])
        (self.root / "README.md").write_text("scope creep\n")
        with self.assertRaises(claude_scope.WorkflowError):
            claude_scope.audit_changed_paths(self.root, manifest)
        (self.root / "new.txt").write_text("untracked\n")
        with self.assertRaises(claude_scope.WorkflowError):
            claude_scope.audit_changed_paths(self.root, manifest)

    def test_executor_prompt_brokers_only_single_trusted_analysis_commands(self):
        prompt = claude_scope.executor_prompt(
            "inspect OrderService", self.manifest,
            pathlib.Path("/tmp/worktree"), pathlib.Path("/tmp/plugin"),
        )
        self.assertTrue(prompt.startswith("Implement code changes in src/value.js and test/value.test.js."))
        self.assertIn("one script invocation per Bash call", prompt)
        self.assertIn(str(pathlib.Path("/tmp/plugin").resolve() / "skills/class-graph/scripts/class-graph.mjs"), prompt)
        self.assertIn("--root %s" % pathlib.Path("/tmp/worktree").resolve(), prompt)
        self.assertIn("Never use Bash for ls, git, tests", prompt)
        self.assertIn("Do not rewrite comments", prompt)

    def test_executor_receives_generated_settings_and_plugin(self):
        fake = pathlib.Path(self.tmp.name) / "fake-claude"
        log = pathlib.Path(self.tmp.name) / "exec-args.json"
        fake.write_text("#!/usr/bin/env python3\nimport json,sys\nopen(%r,'w').write(json.dumps(sys.argv[1:]))\nprint(json.dumps({'type':'result','subtype':'success','total_cost_usd':0.02}))\n" % str(log))
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        settings = pathlib.Path(self.tmp.name) / "settings.json"; settings.write_text("{}")
        plugin = pathlib.Path(self.tmp.name) / "plugin"; plugin.mkdir()
        (plugin / "scripts").mkdir()
        (plugin / "scripts/apana-hook.mjs").write_text(
            "import{mkdirSync,writeFileSync}from'node:fs';"
            "mkdirSync(process.env.APANA_CLASS_GRAPH_STATE_DIR,{recursive:true});"
            "writeFileSync(process.env.APANA_CLASS_GRAPH_STATE_DIR+'/active.json','{}');\n"
        )
        meta = claude_scope.run_executor(str(fake), "task", self.root, settings, plugin, model="haiku", budget=0.3)
        args = json.loads(log.read_text())
        self.assertEqual(meta["subtype"], "success")
        self.assertEqual(pathlib.Path(args[args.index("--settings") + 1]), settings.resolve())
        self.assertEqual(pathlib.Path(args[args.index("--plugin-dir") + 1]), plugin.resolve())
        self.assertEqual(args[args.index("--permission-mode") + 1], "dontAsk")
        self.assertIn("--restricted", args)
        self.assertNotIn("project", args)
        self.assertIn("--include-hook-events", args)


class TestProvenanceGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = pathlib.Path(self.tmp.name) / "repo"; self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        (self.repo / "src").mkdir(); (self.repo / "test").mkdir()
        (self.repo / "src/value.py").write_text("def value():\n    return 1\n")
        (self.repo / "src/other.py").write_text("def other():\n    return 5\n")
        (self.repo / "test/__init__.py").write_text("")
        (self.repo / "test/test_value.py").write_text("import unittest\nfrom src.value import value\nclass T(unittest.TestCase):\n    def test_value(self): self.assertEqual(value(), 1)\n")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=f@example.com", "commit", "-qm", "base"], cwd=self.repo, check=True)

    def tearDown(self): self.tmp.cleanup()

    def manifest(self, task_type="bugfix", test_path="test/test_value.py"):
        production = [] if task_type == "tests-only" else [{"path": "src/value.py", "symbols": ["value"], "reason": "task"}]
        mapped = ["src/value.py"]
        test_changes = [] if task_type == "refactor" else [{"path": test_path, "production_paths": mapped, "behaviors": ["value behavior"], "reason": "test"}]
        commands = [["python3", "-m", "unittest", test_path.replace("/", ".").removesuffix(".py")]]
        return claude_scope.validate_manifest({
            "task_type": task_type, "summary": "value",
            "production_changes": production,
            "test_changes": test_changes,
            "support_changes": [], "forbidden_examples": [],
            "test_commands": commands,
            "test_command_paths": [test_path],
            "red_signatures": [["AssertionError"]] if task_type in {"feature", "bugfix"} else [],
        }, self.repo)

    def test_accepts_test_that_is_red_on_baseline_and_green_with_production(self):
        state = pathlib.Path(self.tmp.name) / "state"
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    return 2\n")
            (worktree / "test/test_value.py").write_text("import unittest\nfrom src.value import value\nclass T(unittest.TestCase):\n    def test_value(self): self.assertEqual(value(), 2)\n")
            result = claude_scope.validate_test_provenance(self.repo, worktree, self.manifest(), state)
            self.assertTrue(result["red"])
            self.assertTrue(result["green"])

    def test_rejects_opportunistic_test_that_passes_on_baseline(self):
        state = pathlib.Path(self.tmp.name) / "state"
        manifest = self.manifest(test_path="test/test_other.py")
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    return 2\n")
            (worktree / "test/test_other.py").write_text("import unittest\nfrom src.other import other\nclass T(unittest.TestCase):\n    def test_other(self): self.assertEqual(other(), 5)\n")
            with self.assertRaises(claude_scope.WorkflowError):
                claude_scope.validate_test_provenance(self.repo, worktree, manifest, state)

    def test_tests_only_allows_green_test_for_existing_code(self):
        state = pathlib.Path(self.tmp.name) / "state"
        manifest = self.manifest(task_type="tests-only", test_path="test/test_existing.py")
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "test/test_existing.py").write_text("import unittest\nfrom src.value import value\nclass T(unittest.TestCase):\n    def test_existing(self): self.assertEqual(value(), 1)\n")
            result = claude_scope.validate_test_provenance(self.repo, worktree, manifest, state)
            self.assertIsNone(result["red"])
            self.assertTrue(result["green"])

    def test_failing_test_run_reports_the_command_output(self):
        state = pathlib.Path(self.tmp.name) / "state-diag"
        manifest = self.manifest(task_type="refactor")
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    raise RuntimeError('DIAG-MARKER-123')\n")
            with self.assertRaises(claude_scope.WorkflowError) as ctx:
                claude_scope.validate_test_provenance(self.repo, worktree, manifest, state)
        self.assertIn("DIAG-MARKER-123", str(ctx.exception))
        self.assertIn("exit", str(ctx.exception))

    def test_refactor_rejects_test_edits(self):
        state = pathlib.Path(self.tmp.name) / "state"
        manifest = self.manifest(task_type="refactor")
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    result = 1\n    return result\n")
            (worktree / "test/test_value.py").write_text((worktree / "test/test_value.py").read_text() + "\n# unnecessary edit\n")
            with self.assertRaises(claude_scope.WorkflowError):
                claude_scope.validate_test_provenance(self.repo, worktree, manifest, state)

    def test_refactor_requires_and_runs_an_existing_narrow_regression_test(self):
        state = pathlib.Path(self.tmp.name) / "state-refactor"
        manifest = self.manifest(task_type="refactor")
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    result = 1\n    return result\n")
            result = claude_scope.validate_test_provenance(self.repo, worktree, manifest, state)
        self.assertIsNone(result["red"])
        self.assertTrue(result["green"])

        invalid = json.loads(json.dumps(manifest))
        invalid["test_commands"] = []
        invalid["test_command_paths"] = []
        with self.assertRaises(claude_scope.ManifestError):
            claude_scope.validate_manifest(invalid, self.repo)

    def test_rejects_when_any_planned_production_file_is_unchanged(self):
        state = pathlib.Path(self.tmp.name) / "state-production-completeness"
        manifest = self.manifest()
        manifest["production_changes"].append(
            {"path": "src/other.py", "symbols": ["other"], "reason": "also required"}
        )
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    return 2\n")
            (worktree / "test/test_value.py").write_text("import unittest\nfrom src.value import value\nclass T(unittest.TestCase):\n    def test_value(self): self.assertEqual(value(), 2)\n")
            with self.assertRaises(claude_scope.WorkflowError):
                claude_scope.validate_test_provenance(self.repo, worktree, manifest, state)

    def test_rejects_red_for_wrong_reason_and_unchanged_planned_test(self):
        state = pathlib.Path(self.tmp.name) / "state-reason"
        manifest = self.manifest()
        manifest["red_signatures"] = [["expected-domain-signature"]]
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    return 2\n")
            (worktree / "test/test_value.py").write_text("import unittest\nfrom src.value import value\nclass T(unittest.TestCase):\n    def test_value(self): self.assertEqual(value(), 2)\n")
            with self.assertRaises(claude_scope.WorkflowError):
                claude_scope.validate_test_provenance(self.repo, worktree, manifest, state)
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    return 2\n")
            with self.assertRaises(claude_scope.WorkflowError):
                claude_scope.validate_test_provenance(self.repo, worktree, self.manifest(), state)

    def test_isolated_copy_has_an_independent_git_directory(self):
        state = pathlib.Path(self.tmp.name) / "state-clone"
        original_common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=self.repo,
                                         text=True, capture_output=True, check=True).stdout.strip()
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            clone_common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=worktree,
                                          text=True, capture_output=True, check=True).stdout.strip()
            self.assertEqual(clone_common, ".git")
            self.assertNotEqual(pathlib.Path(original_common).resolve(), (worktree / clone_common).resolve())

    def test_export_applies_only_validated_patch_and_refuses_dirty_target(self):
        state = pathlib.Path(self.tmp.name) / "state-export"
        manifest = self.manifest()
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    return 2\n")
            (worktree / "test/test_value.py").write_text("import unittest\nfrom src.value import value\nclass T(unittest.TestCase):\n    def test_value(self): self.assertEqual(value(), 2)\n")
            changed = claude_scope.export_validated_patch(self.repo, worktree, manifest)
        self.assertEqual(changed, ["src/value.py", "test/test_value.py"])
        self.assertIn("return 2", (self.repo / "src/value.py").read_text())

        subprocess.run(["git", "checkout", "--", "."], cwd=self.repo, check=True)
        with claude_scope.isolated_worktree(self.repo, state) as worktree:
            (worktree / "src/value.py").write_text("def value():\n    return 3\n")
            (self.repo / "README.md").write_text("user changed this during run\n")
            with self.assertRaises(claude_scope.WorkflowError):
                claude_scope.export_validated_patch(self.repo, worktree, manifest)
            self.assertIn("return 1", (self.repo / "src/value.py").read_text())

    def test_linux_sandbox_uses_private_namespaces_and_no_host_root_bind(self):
        sandbox = pathlib.Path(self.tmp.name) / "linux-sandbox"; sandbox.mkdir()
        with mock.patch.object(claude_scope.sys, "platform", "linux"), \
             mock.patch.object(claude_scope.shutil, "which", side_effect=lambda name: "/usr/bin/bwrap" if name == "bwrap" else "/usr/bin/python3"):
            command, overrides = claude_scope._sandbox_command(
                self.repo, sandbox, ["python3", "-m", "unittest", "test.test_value"]
            )
        self.assertIn("--unshare-all", command)
        self.assertIn("--new-session", command)
        self.assertIn("--proc", command)
        self.assertIn("--dev", command)
        self.assertNotIn(["--ro-bind", "/", "/"], [command[i:i + 3] for i in range(len(command) - 2)])
        self.assertEqual(overrides["HOME"], "/sandbox/home")

    @unittest.skipUnless(sys.platform == "darwin", "sandbox-exec profile is macOS-only")
    @unittest.skipUnless(shutil.which("java"), "needs a JVM")
    def test_macos_sandbox_jvm_uses_loopback_but_cannot_reach_outside(self):
        # Gradle's daemon binds and connects over loopback. Without the IPv4
        # stack a JVM uses IPv4-mapped IPv6 sockets that no localhost filter
        # matches, so the profile would have to stay open to the whole network.
        (self.repo / "B.java").write_text(
            "import java.net.*;\n"
            "public class B{public static void main(String[] a)throws Exception{\n"
            "ServerSocket s=new ServerSocket(0,50,InetAddress.getLoopbackAddress());\n"
            "new Socket(InetAddress.getLoopbackAddress(),s.getLocalPort()).close();\n"
            "try{Socket c=new Socket();c.connect(new InetSocketAddress(\"192.0.2.1\",9),2000);System.exit(3);}\n"
            "catch(SocketTimeoutException e){System.exit(4);}\n"
            "catch(SocketException e){System.exit(0);}}}\n"
        )
        result = claude_scope.run_test_commands(self.repo, [["java", "B.java"]], timeout=60)[0]
        self.assertEqual(result["returncode"], 0, result["stdout"] + result["stderr"])

    @unittest.skipUnless(sys.platform == "darwin", "sandbox-exec is macOS-only")
    def test_macos_sandbox_allows_loopback_but_blocks_non_local_outbound(self):
        (self.repo / "probe_loopback.py").write_text(
            "import socket\n"
            "s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(1)\n"
            "c = socket.create_connection(s.getsockname(), timeout=3); a, _ = s.accept()\n"
            "c.sendall(b'x'); assert a.recv(1) == b'x'\n"
        )
        # 192.0.2.1 is TEST-NET-1: it is never routable, so only the sandbox can
        # make this fail with EPERM instead of a timeout/unreachable error.
        (self.repo / "probe_external.py").write_text(
            "import socket, sys\n"
            "try:\n"
            "    socket.create_connection(('192.0.2.1', 9), timeout=2)\n"
            "except PermissionError:\n"
            "    sys.exit(0)\n"
            "except OSError as exc:\n"
            "    print('reached the network layer:', exc); sys.exit(1)\n"
            "sys.exit(1)\n"
        )
        loop, external = claude_scope.run_test_commands(
            self.repo, [["python3", "probe_loopback.py"], ["python3", "probe_external.py"]], timeout=30
        )
        self.assertEqual(loop["returncode"], 0, loop["stderr"])
        self.assertEqual(external["returncode"], 0, external["stdout"] + external["stderr"])

    def test_test_command_timeout_is_long_enough_for_a_cold_gradle_build_and_configurable(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_SCOPE_TEST_TIMEOUT", None)
            self.assertGreaterEqual(claude_scope._test_timeout(), 1200)
            os.environ["CLAUDE_SCOPE_TEST_TIMEOUT"] = "45"
            self.assertEqual(claude_scope._test_timeout(), 45)
            os.environ["CLAUDE_SCOPE_TEST_TIMEOUT"] = "junk"
            self.assertGreaterEqual(claude_scope._test_timeout(), 1200)

    def test_gradle_test_commands_disable_persistent_daemons(self):
        self.assertEqual(
            claude_scope._effective_test_argv(["./gradlew", "app:testDebugUnitTest"]),
            ["./gradlew", "app:testDebugUnitTest", "--no-daemon"],
        )
        self.assertEqual(
            claude_scope._effective_test_argv(["./gradlew", "app:testDebugUnitTest", "--no-daemon"]),
            ["./gradlew", "app:testDebugUnitTest", "--no-daemon"],
        )

    def test_sandbox_blocks_test_write_outside_isolated_clone(self):
        outside = pathlib.Path(self.tmp.name) / "outside.txt"
        (self.repo / "test/test_escape.py").write_text(
            "import pathlib,unittest\nclass T(unittest.TestCase):\n"
            "    def test_escape(self): pathlib.Path(%r).write_text('pwned')\n" % str(outside)
        )
        result = claude_scope.run_test_commands(
            self.repo, [["python3", "-m", "unittest", "test.test_escape"]]
        )[0]
        self.assertNotEqual(result["returncode"], 0)
        self.assertFalse(outside.exists())

    def test_version_gate_requires_fail_closed_hook_support(self):
        old = pathlib.Path(self.tmp.name) / "old-claude"
        old.write_text("#!/bin/sh\necho '2.1.294 (Claude Code)'\n")
        old.chmod(old.stat().st_mode | stat.S_IXUSR)
        with self.assertRaises(claude_scope.WorkflowError):
            claude_scope.ensure_claude_version(str(old))
        old.write_text("#!/bin/sh\necho '2.1.295 (Claude Code)'\n")
        self.assertEqual(claude_scope.ensure_claude_version(str(old)), (2, 1, 295))

    def test_semantic_audit_is_mandatory_and_fail_closed(self):
        fake = pathlib.Path(self.tmp.name) / "semantic-claude"
        fake.write_text("#!/usr/bin/env python3\nimport json\nprint(json.dumps({'structured_output':{'approved':False,'reason':'unrelated cleanup'}}))\n")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        with self.assertRaises(claude_scope.WorkflowError):
            claude_scope.run_semantic_audit(str(fake), "task", self.manifest(), "patch", self.repo)
        fake.write_text("#!/usr/bin/env python3\nimport json\nprint(json.dumps({'structured_output':{'approved':True,'reason':'exact scope'}}))\n")
        result = claude_scope.run_semantic_audit(str(fake), "task", self.manifest(), "patch", self.repo)
        self.assertTrue(result["approved"])

    def test_export_rejects_clean_repository_at_a_different_head(self):
        state = pathlib.Path(self.tmp.name) / "state-head"
        manifest = self.manifest()
        base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True,
                              capture_output=True, check=True).stdout.strip()
        with claude_scope.isolated_worktree(self.repo, state, base) as clone:
            (clone / "src/value.py").write_text("def value():\n    return 2\n")
            patch_text = claude_scope.diff_for_paths(clone, ["src/value.py"])
            (self.repo / "README.md").write_text("new base\n")
            subprocess.run(["git", "add", "README.md"], cwd=self.repo, check=True)
            subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=f@example.com",
                            "commit", "-qm", "other"], cwd=self.repo, check=True)
            with self.assertRaises(claude_scope.WorkflowError):
                claude_scope.export_validated_patch(self.repo, clone, manifest,
                                                     expected_base=base, patch=patch_text)
            self.assertIn("return 1", (self.repo / "src/value.py").read_text())

    def test_full_fake_workflow_plans_executes_validates_and_exports(self):
        subprocess.run(["git", "checkout", "--", "."], cwd=self.repo, check=True)
        fake = pathlib.Path(self.tmp.name) / "fake-claude-workflow"
        manifest = self.manifest()
        body = '''#!/usr/bin/env python3
import json,pathlib,sys
args=sys.argv[1:]
if args == ['--version']:
    print('2.1.295 (Claude Code)')
elif '--json-schema' in args and 'approved' in args[args.index('--json-schema') + 1]:
    print(json.dumps({'structured_output': {'approved': True, 'reason': 'exact scope'}}))
elif '--json-schema' in args:
    print(json.dumps({'structured_output': %s, 'total_cost_usd': 0.01}))
else:
    root=pathlib.Path.cwd()
    (root/'src/value.py').write_text('def value():\\n    return 2\\n')
    (root/'test/test_value.py').write_text("import unittest\\nfrom src.value import value\\nclass T(unittest.TestCase):\\n    def test_value(self): self.assertEqual(value(), 2)\\n")
    print(json.dumps({'type':'result','subtype':'success','total_cost_usd':0.02}))
''' % repr(manifest)
        fake.write_text(body); fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        plugin = pathlib.Path(self.tmp.name) / "plugin"; (plugin / ".claude-plugin").mkdir(parents=True); (plugin / ".claude-plugin/plugin.json").write_text("{}")
        (plugin / "scripts").mkdir()
        (plugin / "scripts/apana-hook.mjs").write_text(
            "import{mkdirSync,writeFileSync}from'node:fs';"
            "mkdirSync(process.env.APANA_CLASS_GRAPH_STATE_DIR,{recursive:true});"
            "writeFileSync(process.env.APANA_CLASS_GRAPH_STATE_DIR+'/active.json','{}');\n"
        )
        state = pathlib.Path(self.tmp.name) / "workflow-state"
        report = claude_scope.run_workflow("Change value to two and test it", cwd=self.repo,
                                           claude=str(fake), plugin_root=plugin, state_dir=state,
                                           planner_model="haiku", executor_model="haiku")
        self.assertEqual(report["changed_paths"], ["src/value.py", "test/test_value.py"])
        self.assertTrue(report["test_provenance"]["red"])
        self.assertIn("return 2", (self.repo / "src/value.py").read_text())
        self.assertTrue((state / "report.json").exists())


if __name__ == "__main__":
    unittest.main()
