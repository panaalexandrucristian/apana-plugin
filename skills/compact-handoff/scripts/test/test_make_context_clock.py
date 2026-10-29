"""Exercise the actual OpenCode selftest comparison under controlled child clocks."""
import contextlib
import traceback
import io
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "make_context.py"
# This script dispatches even on import. --marker only prints a fresh marker;
# it does not discover or read any real sessions.
with patch.object(sys, "argv", [str(SOURCE), "--marker"]), contextlib.redirect_stdout(io.StringIO()):
    SELFTEST = runpy.run_path(str(SOURCE))["selftest_opencode"]


class ComparisonReached(Exception):
    pass


class ClockBoundaryTest(unittest.TestCase):
    def check_pair(self, first, second, mutation=None):
        real_run, real_mkdtemp = subprocess.run, tempfile.mkdtemp
        calls = 0

        def controlled_run(command, **kwargs):
            nonlocal calls
            if calls == 2:
                # The actual equality assertion has now run; skip unrelated cases.
                raise ComparisonReached
            stamp = (first, second)[calls]
            calls += 1
            clock = (
                "import datetime, sys\n"
                f"_wall = datetime.datetime.fromisoformat({stamp!r})\n"
                "class WallClock(datetime.datetime):\n"
                "    @classmethod\n"
                "    def now(cls, tz=None):\n"
                "        return _wall if tz is None else _wall.astimezone(tz)\n"
                "datetime.datetime = WallClock\n"
            )
            command = list(command)
            if command[2] == "-c":
                command[3] = clock + command[3]
            else:
                command = command[:2] + ["-c", clock +
                    "import runpy\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name='__main__')\n"] + command[2:]
            result = real_run(command, **kwargs)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            if calls == 2 and mutation:
                handoff = Path(command[-1]) / "HANDOFF.md"
                text = handoff.read_text(encoding="utf-8")
                self.assertEqual(text.count(mutation), 1)
                handoff.write_text(text.replace(mutation, "DELIBERATELY CHANGED"), encoding="utf-8")
            return result

        with tempfile.TemporaryDirectory(prefix="handoff-clock-test-") as root:
            with patch.object(subprocess, "run", side_effect=controlled_run), patch.object(
                tempfile, "mkdtemp", side_effect=lambda: real_mkdtemp(dir=root)
            ):
                if mutation:
                    try:
                        SELFTEST()
                    except AssertionError as error:
                        # Reject failures elsewhere: this must be the byte comparison.
                        self.assertIn("md.replace(out1b, out)", traceback.extract_tb(error.__traceback__)[-1].line)
                    else:
                        self.fail("the byte comparison accepted a changed handoff")
                else:
                    with self.assertRaises(ComparisonReached):
                        SELFTEST()
                self.assertEqual(calls, 2)

    def test_clock_pairs(self):
        for first, second in (
            ("2026-10-29T17:57:58", "2026-10-29T17:57:59"),
            ("2026-10-29T17:57:59", "2026-10-29T17:58:00"),
            ("2026-10-29T23:59:59", "2026-10-30T00:00:00"),
        ):
            with self.subTest(first=first, second=second):
                self.check_pair(first, second)

    def test_unrelated_changes_still_fail(self):
        for mutation in ("Final answer text.", "## Cum citești fișierul"):
            with self.subTest(mutation=mutation):
                self.check_pair("2026-10-29T17:57:58", "2026-10-29T17:57:59", mutation)


if __name__ == "__main__":
    unittest.main()
