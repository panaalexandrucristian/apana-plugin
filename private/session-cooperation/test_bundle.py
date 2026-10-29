"""The shipped bundle, not only the private registry, must implement the native RPCs."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ROOT / "skills/install-claude-auto/assets/cooperation"
PRIVATE = Path(__file__).with_name("registry.py")


class BundleTests(unittest.TestCase):
    def test_bundled_registry_is_byte_identical_to_authoritative_source(self):
        self.assertEqual((BUNDLE / "scripts/registry.py").read_bytes(), PRIVATE.read_bytes())

    def test_native_test_command_targets_repository_tests(self):
        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(package["scripts"]["test:cooperation-native"],
                         "claude plugin test skills/install-claude-auto/assets/cooperation")
        self.assertTrue(list(BUNDLE.glob("*.test.ts")))

    def test_bundled_cli_supports_revision_fenced_publish_withdraw_and_finish(self):
        with tempfile.TemporaryDirectory() as temp:
            db = Path(temp) / "registry.sqlite"
            member, session = str(uuid.uuid4()), str(uuid.uuid4())

            def call(op, **fields):
                request = {"op": op, "member": member, "generation": 1, **fields}
                process = subprocess.run([sys.executable, "-I", str(BUNDLE / "scripts/registry.py"), str(db)],
                                         input=json.dumps(request), text=True, capture_output=True,
                                         cwd=temp, timeout=15, check=True)
                self.assertEqual(process.stderr, "")
                return json.loads(process.stdout)

            self.assertTrue(call("register", session=session, cwd=temp, provider="test")["ok"])
            self.assertTrue(call("prompt", text="Private fixture prompt")["ok"])
            published = call("publish", title="Bounded", instructions="Explicit public evidence", expected_revision=1)
            self.assertTrue(published["ok"], published)
            task = published["task"]["task"]
            self.assertFalse(call("idle", expected_revision=1)["ok"])
            withdrawn = call("withdraw", task=task, reason="Do locally", expected_revision=1)
            self.assertTrue(withdrawn["ok"], withdrawn)
            self.assertEqual(withdrawn["task"]["state"], "withdrawn")
            self.assertTrue(call("idle", expected_revision=1)["ok"])
            self.assertTrue(call("prompt", text="Replacement private fixture")["ok"])
            for op, fields in (("idle", {}), ("publish", {"title": "Stale", "instructions": "Old scope"}),
                               ("withdraw", {"task": task, "reason": "Stale"}),
                               ("decide", {"task": task, "decision": "accept", "rationale": "Stale"})):
                response = call(op, expected_revision=1, **fields)
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"], "stale owner revision")
            self.assertTrue(call("idle", expected_revision=2)["ok"])


if __name__ == "__main__":
    unittest.main()
