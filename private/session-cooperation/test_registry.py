"""Public API/CLI contract tests; all state is confined to temporary directories."""
from contextlib import closing
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid

sys.dont_write_bytecode = True
MODULE = Path(__file__).with_name("registry.py")
spec = importlib.util.spec_from_file_location("registry", MODULE)
registry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry)


def uid():
    return str(uuid.uuid4())


def concurrent_request(db, request, now, start, output):
    start.wait(15)
    output.put(registry.dispatch(db, request, clock=lambda: now))


def request_with_shared_clock(db, request, clock, sampled, output):
    def now():
        value = clock.value
        sampled.set()
        return value
    output.put(registry.dispatch(db, request, clock=now))


def claim_until_killed(db, member, now, pipe, stop):
    pipe.send(registry.dispatch(db, {"op": "claim", "member": member, "generation": 0},
                                clock=lambda: now))
    pipe.close()
    stop.wait(30)


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "private" / "coord.sqlite"
        self.now = 1000.0

    def call(self, op, member=None, generation=0, **fields):
        request = {"op": op, **fields}
        if member is not None:
            request.update(member=member, generation=generation)
        return registry.dispatch(self.db, request, clock=lambda: self.now)

    def good(self, op, member=None, generation=0, **fields):
        response = self.call(op, member, generation, **fields)
        self.assertTrue(response["ok"], response)
        return response

    def register(self, member=None, generation=0, **fields):
        member = member or uid()
        response = self.good("register", member, generation,
                             session=fields.pop("session", uid()),
                             cwd="/work/project", provider="local", **fields)
        return member, response["member"]

    def test_registration_is_durable_and_explicitly_active(self):
        member, state = self.register()
        self.assertEqual(state["member"], member)
        self.assertEqual(state["owner_state"], "active")
        self.assertEqual(state["owner_revision"], 0)
        self.assertEqual(state["generation"], 0)
        snapshot = self.good("snapshot")
        self.assertEqual(snapshot["members"], [state])
        self.assertEqual(snapshot["tasks"], [])

    def test_explicit_owner_and_helper_workflow_preserves_attribution(self):
        owner, _ = self.register()
        helper, helper_state = self.register()
        prompt = self.good("prompt", owner, text="Private user task; do not share")
        self.assertEqual(prompt["member"]["owner_revision"], 1)
        task = self.good("publish", owner, title="Investigate", instructions="Public scope only")["task"]
        self.assertFalse(self.call("idle", owner)["ok"])
        self.assertFalse(self.call("claim", helper)["ok"])
        self.good("idle", helper)
        claimed = self.good("claim", helper)["task"]
        self.assertEqual(claimed["task"], task["task"])
        self.assertEqual(claimed["owner"], owner)
        self.assertEqual(claimed["owner_revision"], 1)
        self.assertEqual(claimed["instructions"], "Public scope only")
        self.assertNotIn("Private user task", json.dumps(claimed))
        completed = self.good("complete", helper, task=task["task"],
                              lease=claimed["lease"], result="Evidence, not a permission")
        contribution = completed["contribution"]
        self.assertEqual(contribution["contributor"], helper)
        self.assertEqual(contribution["session"], helper_state["session"])
        self.assertEqual(contribution["generation"], 0)
        results = self.good("results", owner)
        self.assertEqual(results["tasks"][0]["contribution"], contribution)
        self.assertEqual(results["own_tasks"][0]["text"], "Private user task; do not share")
        self.assertEqual(results["summary"]["own_completed"], 1)
        self.assertEqual(self.good("results", helper)["summary"]["helped_completed"], 1)
        decision = self.good("decide", owner, task=task["task"], decision="accept",
                             rationale="Checked against own task")["decision"]
        self.assertEqual(decision["contributor"], helper)
        self.assertEqual(decision["verdict"], "accept")
        self.assertEqual(self.good("idle", owner)["member"]["owner_state"], "idle")
        snapshot = self.good("snapshot")
        self.assertEqual(snapshot["tasks"][0]["state"], "accepted")
        self.assertEqual(snapshot["own_tasks"][0]["state"], "done")
        self.assertEqual(snapshot["decisions"], [decision])

    def work(self):
        owner, _ = self.register()
        helper, _ = self.register()
        self.good("prompt", owner, text="Owner's private task")
        self.good("publish", owner, title="Public task", instructions="Explicit snapshot")
        self.good("idle", helper)
        return owner, helper, self.good("claim", helper)["task"]

    def test_user_prompt_preempts_help_and_invalidates_all_old_owner_work(self):
        owner, helper, claimed = self.work()
        self.good("prompt", helper, text="My new user task")
        self.assertFalse(self.call("complete", helper, task=claimed["task"],
                                   lease=claimed["lease"], result="late")["ok"])
        snapshot = self.good("snapshot")
        self.assertEqual(snapshot["tasks"][0]["state"], "queued")
        self.assertEqual(snapshot["contributions"][0]["state"], "cancelled")
        self.assertEqual(snapshot["contributions"][0]["reason"], "user-prompt")
        self.good("idle", helper)
        claimed_again = self.good("claim", helper)["task"]
        self.assertNotEqual(claimed["lease"], claimed_again["lease"])
        self.good("publish", owner, title="Other queued task", instructions="Separate scope")
        self.good("prompt", owner, text="Replacement owner task")
        snapshot = self.good("snapshot")
        self.assertTrue(all(t["state"] == "cancelled" for t in snapshot["tasks"]))
        self.assertTrue(all(c["state"] == "cancelled" for c in snapshot["contributions"]))
        self.assertFalse(self.call("complete", helper, task=claimed_again["task"],
                                   lease=claimed_again["lease"], result="obsolete")["ok"])
        owner_tasks = self.good("results", owner)["own_tasks"]
        self.assertEqual([t["state"] for t in owner_tasks], ["superseded", "active"])
        self.assertEqual(self.good("claim", helper)["task"], None)

    def test_generation_rotation_preserves_owned_work_and_fences_old_process(self):
        owner, helper, claimed = self.work()
        _, rotated = self.register(owner, generation=1)
        self.assertEqual(rotated["owner_revision"], 1)
        self.assertEqual(rotated["owner_state"], "active")
        self.good("complete", helper, task=claimed["task"], lease=claimed["lease"], result="Useful")
        _, rotated = self.register(owner, generation=2)
        results = self.good("results", owner, generation=2)
        self.assertEqual(results["tasks"][0]["contribution"]["result"], "Useful")
        self.assertEqual(results["own_tasks"][0]["text"], "Owner's private task")
        self.assertFalse(self.call("prompt", owner, generation=1, text="stale")["ok"])
        self.assertFalse(self.call("results", owner, generation=1)["ok"])
        self.assertFalse(self.call("register", owner, generation=1, session=uid(),
                                   cwd="/work/project", provider="local")["ok"])
        same = self.good("register", owner, generation=2, session=rotated["session"],
                         cwd="/work/project", provider="local")["member"]
        self.assertEqual(same, rotated)
        self.assertFalse(self.call("register", owner, generation=2, session=uid(),
                                   cwd="/work/project", provider="local")["ok"])
        self.good("decide", owner, generation=2, task=claimed["task"], decision="accept",
                  rationale="Reviewed after rotation")
        self.good("idle", owner, generation=2)
        self.good("prompt", helper, text="New own task")
        self.good("publish", helper, title="Help", instructions="Own scope")
        helping = self.good("claim", owner, generation=2)["task"]
        _, rotated = self.register(owner, generation=3)
        self.assertEqual(rotated["owner_state"], "idle")
        snapshot = self.good("snapshot")
        cancelled = [c for c in snapshot["contributions"] if c["lease"] == helping["lease"]][0]
        self.assertEqual(cancelled["reason"], "generation-rotated")
        for generation in (2, 3):
            self.assertFalse(self.call("complete", owner, generation=generation, task=helping["task"],
                                       lease=helping["lease"], result="late")["ok"])
        replacement = self.good("claim", owner, generation=3)["task"]
        self.assertNotEqual(replacement["lease"], helping["lease"])

    def test_heartbeat_renews_only_explicit_lease_and_expiry_reassigns(self):
        owner, helper, claimed = self.work()
        self.now += registry.LEASE_TTL / 2
        heartbeat = self.good("heartbeat", helper, lease=claimed["lease"])
        self.assertEqual(heartbeat["member"]["expires_at"], self.now + registry.MEMBERSHIP_TTL)
        self.assertEqual(heartbeat["task"]["expires_at"], self.now + registry.LEASE_TTL)
        self.now = heartbeat["task"]["expires_at"] - 1
        self.good("heartbeat", helper)
        self.good("heartbeat", owner)
        self.now += 1
        self.assertFalse(self.call("heartbeat", helper, lease=claimed["lease"])["ok"])
        self.assertFalse(self.call("complete", helper, task=claimed["task"],
                                   lease=claimed["lease"], result="too late")["ok"])
        replacement = self.good("claim", helper)["task"]
        self.assertEqual(replacement["task"], claimed["task"])
        self.assertNotEqual(replacement["lease"], claimed["lease"])
        cancelled = [c for c in self.good("snapshot")["contributions"] if c["lease"] == claimed["lease"]][0]
        self.assertEqual(cancelled["reason"], "lease-expired")

    def test_release_and_close_cancel_attempt_without_erasing_work(self):
        owner, helper, claimed = self.work()
        released = self.good("release", helper, task=claimed["task"], lease=claimed["lease"], reason="api-error")
        self.assertEqual(released["task"]["state"], "queued")
        self.assertEqual(released["contribution"]["reason"], "api-error")
        self.assertEqual(self.good("results", helper)["own_tasks"], [])
        self.assertFalse(self.call("complete", helper, task=claimed["task"],
                                   lease=claimed["lease"], result="late")["ok"])
        replacement = self.good("claim", helper)["task"]
        self.assertEqual(self.good("close", helper)["member"]["status"], "closed")
        self.assertEqual(self.good("snapshot")["tasks"][0]["state"], "queued")
        self.assertFalse(self.call("complete", helper, task=replacement["task"],
                                   lease=replacement["lease"], result="late")["ok"])
        self.assertFalse(self.call("heartbeat", helper)["ok"])
        self.register(helper, generation=1)
        replacement = self.good("claim", helper, generation=1)["task"]
        self.good("complete", helper, generation=1, task=replacement["task"],
                  lease=replacement["lease"], result="persist")
        self.good("close", owner)
        self.register(owner, generation=1)
        self.assertEqual(self.good("results", owner, generation=1)["tasks"][0]["contribution"]["result"], "persist")

    def test_tick_reaps_dead_members_and_new_generation_recovers_owned_tasks(self):
        owner, helper, claimed = self.work()
        self.now += registry.MEMBERSHIP_TTL
        tick = self.good("tick")
        self.assertEqual(tick["members_expired"], 2)
        self.assertEqual(tick["claims_released"], 1)
        self.assertEqual(self.good("tick")["claims_released"], 0)
        self.assertEqual({m["status"] for m in self.good("snapshot")["members"]}, {"expired"})
        self.assertFalse(self.call("heartbeat", helper)["ok"])
        helper_session = next(m["session"] for m in self.good("snapshot")["members"] if m["member"] == helper)
        self.assertFalse(self.call("register", helper, session=helper_session,
                                   cwd="/work/project", provider="local")["ok"])
        self.register(helper, generation=1)
        self.assertIsNone(self.good("claim", helper, generation=1)["task"])
        self.register(owner, generation=1)
        recovered = self.good("claim", helper, generation=1)["task"]
        self.assertEqual(recovered["task"], claimed["task"])
        self.assertNotEqual(recovered["lease"], claimed["lease"])
        self.assertEqual(self.good("results", owner, generation=1)["own_tasks"][0]["state"], "active")

    def cli(self, payload, *args):
        return subprocess.run([sys.executable, "-I", str(MODULE), *map(str, args)],
                              input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=15, cwd=self.temp.name)

    def test_isolated_cli_emits_one_json_response_for_success_and_errors(self):
        request = {"op": "register", "member": uid(), "generation": 0, "session": uid(),
                   "cwd": "/not/opened", "provider": "local"}
        process = self.cli(json.dumps(request).encode(), self.db)
        self.assertEqual(process.stderr, b"")
        self.assertEqual(process.returncode, 0)
        self.assertTrue(json.loads(process.stdout)["ok"])
        self.assertEqual(process.stdout.count(b"\n"), 1)
        for payload in (b"", b"{", b"[]", b"{} {}", b'\xff',
                        b'{"op":"snapshot","op":"tick"}',
                        b'{"op":"snapshot","x":NaN}', b" " * 262145):
            with self.subTest(payload=payload[:50]):
                process = self.cli(payload, self.db)
                self.assertEqual(process.stderr, b"")
                response = json.loads(process.stdout)
                self.assertFalse(response["ok"])
                self.assertIsInstance(response["error"], str)
        self.assertFalse(json.loads(self.cli(b"{}").stdout)["ok"])
        self.assertFalse(json.loads(self.cli(b"{}", self.db, "extra").stdout)["ok"])

    def test_snapshot_is_diagnostic_state_not_an_implicit_prompt_share(self):
        owner, _, _ = self.work()
        self.assertNotIn("Owner's private task", json.dumps(self.good("snapshot")))
        self.assertEqual(self.good("results", owner)["own_tasks"][0]["text"], "Owner's private task")

    def test_stale_generation_is_rejected_for_every_member_operation(self):
        owner, helper, claimed = self.work()
        self.register(helper, generation=1)
        requests = [
            ("prompt", {"text": "stale"}), ("idle", {}),
            ("publish", {"title": "stale", "instructions": "stale"}),
            ("claim", {}), ("heartbeat", {}), ("heartbeat", {"lease": claimed["lease"]}),
            ("complete", {"task": claimed["task"], "lease": claimed["lease"], "result": "stale"}),
            ("results", {}),
            ("decide", {"task": claimed["task"], "decision": "accept", "rationale": "stale"}),
            ("release", {"task": claimed["task"], "lease": claimed["lease"], "reason": "stale"}),
            ("close", {}),
            ("register", {"session": uid(), "cwd": "/work/project", "provider": "local"}),
        ]
        before = self.good("snapshot")
        for op, fields in requests:
            with self.subTest(op=op, fields=fields):
                self.assertFalse(self.call(op, helper, **fields)["ok"])
                self.assertEqual(self.good("snapshot"), before)

    def test_foreign_member_cannot_mutate_another_helpers_lease_or_owners_decision(self):
        owner, helper, claimed = self.work()
        intruder, _ = self.register()
        before = self.good("snapshot")
        for op, fields in [
            ("complete", {"task": claimed["task"], "lease": claimed["lease"], "result": "forged"}),
            ("release", {"task": claimed["task"], "lease": claimed["lease"], "reason": "forged"}),
            ("heartbeat", {"lease": claimed["lease"]}),
        ]:
            with self.subTest(op=op):
                self.assertFalse(self.call(op, intruder, **fields)["ok"])
                self.assertEqual(self.good("snapshot"), before)
        self.good("complete", helper, task=claimed["task"], lease=claimed["lease"], result="authentic")
        before = self.good("snapshot")
        self.assertFalse(self.call("decide", intruder, task=claimed["task"], decision="accept",
                                   rationale="not my decision")["ok"])
        self.assertEqual(self.good("snapshot"), before)
        self.assertEqual(self.good("results", intruder)["tasks"], [])
        self.assertEqual(self.good("results", intruder)["contributions"], [])
        self.assertEqual(self.good("results", intruder)["helped"], [])

    def test_new_prompt_invalidates_undecided_result_but_preserves_historical_contribution(self):
        owner, helper, claimed = self.work()
        self.good("complete", helper, task=claimed["task"], lease=claimed["lease"], result="historical")
        self.good("prompt", owner, text="Changed scope")
        results = self.good("results", owner)
        self.assertEqual(results["tasks"][0]["state"], "cancelled")
        self.assertEqual(results["tasks"][0]["contribution"]["result"], "historical")
        self.assertFalse(self.call("decide", owner, task=claimed["task"], decision="accept",
                                   rationale="must not accept stale revision")["ok"])
        self.assertEqual(self.good("results", helper)["summary"]["helped_completed"], 1)

    def test_decisions_are_final_and_rejection_is_not_a_permission_record(self):
        owner, helper, claimed = self.work()
        self.good("complete", helper, task=claimed["task"], lease=claimed["lease"], result="Check me")
        decision = self.good("decide", owner, task=claimed["task"], decision="reject",
                             rationale="Evidence incomplete")["decision"]
        self.assertEqual(decision["owner"], owner)
        self.assertEqual(decision["contributor"], helper)
        self.assertEqual(decision["rationale"], "Evidence incomplete")
        self.assertNotIn("permission", decision)
        self.assertFalse(self.call("decide", owner, task=claimed["task"], decision="accept",
                                   rationale="duplicate")["ok"])
        self.good("prompt", owner, text="Next task")
        self.assertEqual(self.good("snapshot")["tasks"][0]["state"], "rejected")
        self.assertEqual(self.good("snapshot")["decisions"], [decision])

    def test_idle_is_blocked_in_every_outstanding_task_state(self):
        owner, _ = self.register()
        helper, _ = self.register()
        self.good("prompt", owner, text="Active")
        task = self.good("publish", owner, title="Task", instructions="Scope")["task"]
        for state in ("queued", "claimed", "completed"):
            with self.subTest(state=state):
                self.assertEqual(self.good("snapshot")["tasks"][0]["state"], state)
                self.assertFalse(self.call("idle", owner)["ok"])
                self.assertFalse(self.call("claim", owner)["ok"])
                if state == "queued":
                    self.good("idle", helper)
                    claimed = self.good("claim", helper)["task"]
                elif state == "claimed":
                    self.good("complete", helper, task=task["task"], lease=claimed["lease"], result="Done")
        self.good("decide", owner, task=task["task"], decision="reject", rationale="Not useful")
        self.good("idle", owner)
        self.assertIsNone(self.good("claim", owner)["task"])

    def test_claim_is_idempotent_never_self_claims_and_does_not_infer_idle_from_time(self):
        owner, helper, claimed = self.work()
        another = self.good("publish", owner, title="Another", instructions="Separate scope")["task"]
        repeated = self.good("claim", helper)["task"]
        self.assertEqual(repeated, claimed)
        self.assertEqual(len(self.good("snapshot")["contributions"]), 1)
        self.assertFalse(self.call("publish", helper, title="No own task", instructions="No")["ok"])
        self.now += 1
        self.good("heartbeat", owner)
        self.assertFalse(self.call("claim", owner)["ok"])
        self.assertNotEqual(another["task"], claimed["task"])
        self.assertTrue(all(c["contributor"] != owner for c in self.good("snapshot")["contributions"]))

    def test_immutable_explicit_instructions_and_result_copies(self):
        owner, helper, claimed = self.work()
        claimed["instructions"] = "locally edited"
        self.assertEqual(self.good("claim", helper)["task"]["instructions"], "Explicit snapshot")
        self.good("complete", helper, task=claimed["task"], lease=claimed["lease"], result="Original report")
        self.assertFalse(self.call("complete", helper, task=claimed["task"], lease=claimed["lease"],
                                   result="Overwrite")["ok"])
        result = self.good("results", owner)
        result["tasks"][0]["contribution"]["result"] = "locally edited"
        self.assertEqual(self.good("results", owner)["tasks"][0]["contribution"]["result"], "Original report")

    def test_heartbeat_failure_rolls_back_membership_renewal(self):
        _, helper, _ = self.work()
        before = self.good("snapshot")
        self.now += 1
        self.assertFalse(self.call("heartbeat", helper, lease=uid())["ok"])
        self.assertEqual(self.good("snapshot"), before)

    def test_unavailable_owner_fences_work_and_claim_reaps_without_tick(self):
        owner, helper, claimed = self.work()
        self.good("close", owner)
        self.assertFalse(self.call("complete", helper, task=claimed["task"],
                                   lease=claimed["lease"], result="too late")["ok"])
        self.assertIsNone(self.good("claim", helper)["task"])
        snapshot = self.good("snapshot")
        self.assertEqual(snapshot["contributions"][0]["reason"], "owner-unavailable")
        self.assertEqual(snapshot["tasks"][0]["state"], "queued")
        self.register(owner, generation=1)
        self.assertEqual(self.good("claim", helper)["task"]["task"], claimed["task"])

    def test_expired_owner_cannot_be_renewed_by_a_helpers_heartbeat(self):
        owner, helper, claimed = self.work()
        for _ in range(3):
            self.now += registry.LEASE_TTL - 1
            self.good("heartbeat", helper, lease=claimed["lease"])
        self.now = 1000 + registry.MEMBERSHIP_TTL
        self.assertFalse(self.call("heartbeat", helper, lease=claimed["lease"])["ok"])
        self.assertFalse(self.call("complete", helper, task=claimed["task"],
                                   lease=claimed["lease"], result="late")["ok"])
        self.good("tick")
        self.assertEqual(next(m for m in self.good("snapshot")["members"] if m["member"] == owner)["status"], "expired")

    def test_bounded_pairwise_completion_interleavings(self):
        events = ("owner_prompt", "helper_prompt", "owner_rotate", "helper_rotate",
                  "owner_close", "helper_close", "release", "lease_expire", "member_expire",
                  "accept", "reject", "withdraw")
        for event in events:
            for completion_first in (False, True):
                with self.subTest(event=event, completion_first=completion_first):
                    self.db = Path(self.temp.name) / (event + str(completion_first)) / "db"
                    self.now = 1000.0
                    owner, helper, claimed = self.work()
                    def complete():
                        return self.call("complete", helper, task=claimed["task"],
                                         lease=claimed["lease"], result="Racing report")
                    def interrupt():
                        if event.endswith("prompt"):
                            self.good("prompt", owner if event == "owner_prompt" else helper, text="New task")
                        elif event.endswith("rotate"):
                            self.register(owner if event == "owner_rotate" else helper, generation=1)
                        elif event.endswith("close"):
                            self.good("close", owner if event == "owner_close" else helper)
                            self.good("tick")
                        elif event == "withdraw":
                            self.good("withdraw", owner, task=claimed["task"], reason="Do locally")
                        elif event == "release":
                            response = self.call("release", helper, task=claimed["task"],
                                                 lease=claimed["lease"], reason="api-error")
                            self.assertEqual(response["ok"], not completion_first)
                        elif event.endswith("expire"):
                            self.now += registry.LEASE_TTL if event == "lease_expire" else registry.MEMBERSHIP_TTL
                            self.good("tick")
                        else:
                            response = self.call("decide", owner, task=claimed["task"],
                                                 decision=event, rationale="Reviewed evidence")
                            self.assertEqual(response["ok"], completion_first)
                    if completion_first:
                        response = complete()
                        interrupt()
                    else:
                        interrupt()
                        response = complete()
                    should_complete = completion_first or event in ("owner_rotate", "accept", "reject")
                    self.assertEqual(response["ok"], should_complete)
                    snapshot = self.good("snapshot")
                    expected = "completed" if should_complete else "queued"
                    if event == "owner_prompt":
                        expected = "cancelled"
                    elif event == "withdraw":
                        expected = "withdrawn"
                    elif event in ("accept", "reject") and completion_first:
                        expected = "accepted" if event == "accept" else "rejected"
                    self.assertEqual(snapshot["tasks"][0]["state"], expected)
                    self.assertEqual(snapshot["contributions"][0]["state"],
                                     "completed" if should_complete else "cancelled")
                    self.assertEqual(len(snapshot["contributions"]), 1)

    def parallel_requests(self, requests):
        context = multiprocessing.get_context("spawn")
        start, output = context.Barrier(len(requests)), context.Queue()
        workers = [context.Process(target=concurrent_request,
                                  args=(self.db, request, self.now, start, output)) for request in requests]
        try:
            for worker in workers:
                worker.start()
            responses = [output.get(timeout=20) for _ in workers]
            for worker in workers:
                worker.join(20)
                self.assertEqual(worker.exitcode, 0)
            return responses
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate()
                    worker.join(5)
            output.close()
            output.join_thread()

    def test_multiprocess_atomic_claims_have_no_duplicate_task_or_helper(self):
        for iteration in range(3):
            with self.subTest(iteration=iteration):
                self.db = Path(self.temp.name) / str(iteration) / "db"
                owner, _ = self.register()
                for title in ("A", "B", "C"):
                    self.good("publish", owner, title=title, instructions="Explicit scope")
                helpers = [self.register()[0] for _ in range(8)]
                for helper in helpers:
                    self.good("idle", helper)
                responses = self.parallel_requests([{"op": "claim", "member": helper, "generation": 0}
                                                    for helper in helpers])
                self.assertTrue(all(r["ok"] for r in responses), responses)
                claimed = [r["task"] for r in responses if r["task"] is not None]
                self.assertEqual(len(claimed), 3)
                self.assertEqual(len({t["task"] for t in claimed}), 3)
                self.assertEqual(len({t["lease"] for t in claimed}), 3)
                contributions = self.good("snapshot")["contributions"]
                self.assertEqual(len({c["contributor"] for c in contributions}), 3)

    def test_multiprocess_duplicate_claim_requests_share_single_attempt(self):
        owner, helper, original = self.work()
        self.good("release", helper, task=original["task"], lease=original["lease"], reason="reset")
        responses = self.parallel_requests([{"op": "claim", "member": helper, "generation": 0}] * 8)
        self.assertTrue(all(r["ok"] for r in responses), responses)
        self.assertEqual(len({r["task"]["lease"] for r in responses}), 1)
        self.assertEqual(len(self.good("snapshot")["contributions"]), 2)

    def test_multiprocess_first_open_is_safe(self):
        requests = [{"op": "register", "member": uid(), "generation": 0, "session": uid(),
                     "cwd": "/never/opened", "provider": "local"} for _ in range(8)]
        responses = self.parallel_requests(requests)
        self.assertTrue(all(r["ok"] for r in responses), responses)
        self.assertEqual(len(self.good("snapshot")["members"]), 8)

    def test_multiprocess_prompt_completion_race_is_serializable(self):
        for iteration in range(4):
            with self.subTest(iteration=iteration):
                self.db = Path(self.temp.name) / str(iteration) / "db"
                owner, helper, claimed = self.work()
                responses = self.parallel_requests([
                    {"op": "prompt", "member": owner, "generation": 0, "text": "New scope"},
                    {"op": "complete", "member": helper, "generation": 0, "task": claimed["task"],
                     "lease": claimed["lease"], "result": "Racing"},
                ])
                self.assertTrue(any(r["ok"] and "member" in r for r in responses))
                completed = any(r["ok"] and "contribution" in r for r in responses)
                snapshot = self.good("snapshot")
                self.assertEqual(snapshot["tasks"][0]["state"], "cancelled")
                self.assertEqual(snapshot["contributions"][0]["state"], "completed" if completed else "cancelled")
                self.assertEqual(len(snapshot["contributions"]), 1)

    def test_killed_helper_leaves_durable_attempt_that_is_reassigned_after_deadline(self):
        owner, helper, first = self.work()
        self.good("release", helper, task=first["task"], lease=first["lease"], reason="reset")
        context = multiprocessing.get_context("spawn")
        receive, send = context.Pipe(duplex=False)
        stop = context.Event()
        process = context.Process(target=claim_until_killed, args=(self.db, helper, self.now, send, stop))
        process.start()
        send.close()
        try:
            self.assertTrue(receive.poll(15))
            claimed = receive.recv()["task"]
        finally:
            process.terminate()
            process.join(10)
            receive.close()
        replacement, _ = self.register()
        self.good("idle", replacement)
        self.assertIsNone(self.good("claim", replacement)["task"])
        self.now += registry.LEASE_TTL
        reclaimed = self.good("claim", replacement)["task"]
        self.assertEqual(reclaimed["task"], claimed["task"])
        self.assertNotEqual(reclaimed["lease"], claimed["lease"])
        self.assertFalse(self.call("complete", helper, task=claimed["task"], lease=claimed["lease"],
                                   result="Zombie response")["ok"])

    def test_new_database_and_all_new_parents_are_private_even_with_open_umask(self):
        self.db = Path(self.temp.name) / "outer" / "inner" / "db"
        old = os.umask(0)
        try:
            self.register()
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(self.db.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.db.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.db.parent.parent.stat().st_mode), 0o700)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            db.execute("BEGIN IMMEDIATE")
            for suffix in ("-wal", "-shm"):
                sidecar = Path(str(self.db) + suffix)
                if sidecar.exists():
                    self.assertEqual(stat.S_IMODE(sidecar.stat().st_mode), 0o600)
            db.rollback()

    def test_unsafe_database_files_are_rejected_without_modifying_target(self):
        target = Path(self.temp.name) / "target"
        target.write_text("untouched")
        target.chmod(0o600)
        self.db.parent.mkdir()
        self.db.symlink_to(target)
        self.assertFalse(self.call("snapshot")["ok"])
        self.assertEqual(target.read_text(), "untouched")
        self.db.unlink()
        self.db.write_text("untouched")
        self.db.chmod(0o644)
        self.assertFalse(self.call("snapshot")["ok"])
        self.assertEqual(self.db.read_text(), "untouched")
        self.db.chmod(0o600)
        self.assertFalse(self.call("snapshot")["ok"])
        self.assertEqual(self.db.read_text(), "untouched")

    def test_invalid_fields_are_bounded_and_do_not_create_database(self):
        base = {"op": "register", "member": uid(), "generation": 0, "session": uid(),
                "cwd": "/not/opened", "provider": "local"}
        invalid = [None, [], "snapshot", {}, {"op": []}, {"op": "DROP TABLE members"},
                   {"op": "snapshot", "db_path": "/elsewhere"},
                   {**base, "generation": True}, {**base, "generation": -1},
                   {**base, "generation": 1.0}, {**base, "generation": 2 ** 63},
                   {**base, "member": "../escape"}, {**base, "session": "not-a-uuid"},
                   {**base, "member": base["member"].upper()},
                   {**base, "cwd": "relative"}, {**base, "cwd": "/x\0y"},
                   {**base, "provider": " "}, {**base, "provider": "x" * 65},
                   {**base, "provider": "\ud800"}, {**base, "extra": "ignored?"},
                   {"op": "prompt", "member": uid(), "generation": 0, "text": "x" * 65537},
                   {"op": "publish", "member": uid(), "generation": 0, "title": "x", "instructions": "é" * 8193},
                   {"op": "decide", "member": uid(), "generation": 0, "task": uid(), "decision": "approve", "rationale": "x"}]
        for request in invalid:
            with self.subTest(request=str(request)[:100]):
                response = registry.dispatch(self.db, request, clock=lambda: self.now)
                self.assertFalse(response["ok"], response)
                self.assertIsInstance(response["error"], str)
                self.assertFalse(self.db.exists())
        self.assertFalse(registry.dispatch(self.db, {"op": "snapshot"}, clock=lambda: float("nan"))["ok"])
        self.assertFalse(self.db.exists())

    def test_text_at_utf8_bounds_is_accepted_and_sql_is_only_data(self):
        owner, _ = self.register()
        self.good("prompt", owner, text="x" * 65536)
        published = self.good("publish", owner, title="'; DROP TABLE members;--",
                              instructions="é" * 8192)["task"]
        self.assertEqual(published["instructions"], "é" * 8192)
        self.assertEqual(len(self.good("snapshot")["members"]), 1)
        self.assertFalse(self.call("publish", owner, title="x" * 257, instructions="x")["ok"])

    def test_cli_rejects_sqlite_memory_sentinel_instead_of_silently_losing_state(self):
        response = json.loads(self.cli(b'{"op":"snapshot"}', ":memory:").stdout)
        self.assertFalse(response["ok"])
        self.assertFalse((Path(self.temp.name) / ":memory:").exists())

    def test_results_attach_latest_attempt_even_when_reassigned_at_same_clock_time(self):
        owner, helper, claimed = self.work()
        current = self.good("results", owner)["tasks"][0]["contribution"]
        self.assertEqual(current["state"], "claimed")
        self.assertEqual(current["lease"], claimed["lease"])
        self.good("release", helper, task=claimed["task"], lease=claimed["lease"], reason="api-error")
        current = self.good("results", owner)["tasks"][0]["contribution"]
        self.assertEqual(current["state"], "cancelled")
        self.assertEqual(current["reason"], "api-error")
        claimed_again = self.good("claim", helper)["task"]
        current = self.good("results", owner)["tasks"][0]["contribution"]
        self.assertEqual(current["state"], "claimed")
        self.assertEqual(current["lease"], claimed_again["lease"])
        self.assertNotEqual(current["lease"], claimed["lease"])

    def test_completion_deadline_is_checked_after_waiting_for_transaction_lock(self):
        _, helper, claimed = self.work()
        context = multiprocessing.get_context("spawn")
        sampled, output = context.Event(), context.Queue()
        clock = context.Value("d", self.now)
        request = {"op": "complete", "member": helper, "generation": 0,
                   "task": claimed["task"], "lease": claimed["lease"], "result": "Delayed"}
        worker = context.Process(target=request_with_shared_clock,
                                 args=(self.db, request, clock, sampled, output))
        lock = sqlite3.connect(self.db)
        try:
            lock.execute("BEGIN IMMEDIATE")
            worker.start()
            self.assertTrue(sampled.wait(15))
            clock.value = claimed["expires_at"]
            lock.rollback()
            response = output.get(timeout=15)
            worker.join(15)
            self.assertEqual(worker.exitcode, 0)
            self.assertFalse(response["ok"], response)
            self.assertEqual(self.good("snapshot")["contributions"][0]["state"], "claimed")
        finally:
            lock.close()
            if worker.is_alive():
                worker.terminate()
                worker.join(5)
            output.close()
            output.join_thread()

    def test_owner_can_withdraw_each_outstanding_state_without_finishing_own_task(self):
        for state in ("queued", "claimed", "completed"):
            with self.subTest(state=state):
                self.db = Path(self.temp.name) / state / "db"
                owner, _ = self.register()
                helper, _ = self.register()
                self.good("prompt", owner, text="Still my active task")
                task = self.good("publish", owner, title="Delegate", instructions="Explicit scope")["task"]
                if state != "queued":
                    self.good("idle", helper)
                    claimed = self.good("claim", helper)["task"]
                    if state == "completed":
                        self.good("complete", helper, task=task["task"], lease=claimed["lease"], result="Historical report")
                response = self.good("withdraw", owner, task=task["task"], reason="I will do this locally")
                self.assertEqual(response["task"]["state"], "withdrawn")
                withdrawal = response["withdrawal"]
                self.assertEqual(withdrawal["owner"], owner)
                self.assertEqual(withdrawal["generation"], 0)
                self.assertEqual(withdrawal["owner_revision"], 1)
                self.assertEqual(withdrawal["reason"], "I will do this locally")
                results = self.good("results", owner)
                self.assertEqual(results["tasks"][0]["withdrawal"], withdrawal)
                self.assertEqual(results["own_tasks"][0]["state"], "active")
                self.assertEqual(results["summary"]["own_outstanding"], 0)
                snapshot = self.good("snapshot")
                self.assertEqual(snapshot["withdrawals"], [withdrawal])
                self.assertEqual(next(m for m in snapshot["members"] if m["member"] == owner)["owner_state"], "active")
                if state == "claimed":
                    self.assertEqual(snapshot["contributions"][0]["state"], "cancelled")
                    self.assertEqual(snapshot["contributions"][0]["reason"], "I will do this locally")
                    self.assertFalse(self.call("complete", helper, task=task["task"], lease=claimed["lease"], result="Late")["ok"])
                elif state == "completed":
                    self.assertEqual(snapshot["contributions"][0]["state"], "completed")
                    self.assertEqual(snapshot["contributions"][0]["result"], "Historical report")
                    self.assertFalse(self.call("decide", owner, task=task["task"], decision="accept", rationale="Withdrawn")["ok"])
                self.good("idle", owner)

    def test_withdrawal_is_owner_fenced_and_idempotent_without_rewriting_history(self):
        owner, helper, claimed = self.work()
        before = self.good("snapshot")
        self.assertFalse(self.call("withdraw", helper, task=claimed["task"], reason="Not my task")["ok"])
        self.assertEqual(self.good("snapshot"), before)
        response = self.good("withdraw", owner, task=claimed["task"], reason="Requirements changed")
        self.assertEqual(self.good("withdraw", owner, task=claimed["task"], reason="Repeated request"), response)
        self.register(owner, generation=1)
        self.assertFalse(self.call("withdraw", owner, task=claimed["task"], reason="Stale process")["ok"])
        self.assertEqual(self.good("withdraw", owner, generation=1, task=claimed["task"], reason="After rotation"), response)
        self.good("prompt", owner, generation=1, text="New revision")
        self.assertFalse(self.call("withdraw", owner, generation=1, task=claimed["task"], reason="Old revision")["ok"])
        self.assertEqual(self.good("snapshot")["withdrawals"], [response["withdrawal"]])
        self.assertEqual(self.good("snapshot")["tasks"][0]["state"], "withdrawn")

    def test_owner_cannot_withdraw_already_decided_results(self):
        for decision in ("accept", "reject"):
            with self.subTest(decision=decision):
                self.db = Path(self.temp.name) / decision / "db"
                owner, helper, claimed = self.work()
                self.good("complete", helper, task=claimed["task"], lease=claimed["lease"], result="Evidence")
                self.good("decide", owner, task=claimed["task"], decision=decision, rationale="Final review")
                before = self.good("snapshot")
                self.assertFalse(self.call("withdraw", owner, task=claimed["task"], reason="Too late")["ok"])
                self.assertEqual(self.good("snapshot"), before)

    def test_expected_revision_fences_all_owner_actions_after_new_prompt(self):
        for op in ("publish", "idle", "decide", "withdraw"):
            with self.subTest(op=op):
                self.db = Path(self.temp.name) / op / "db"
                owner, helper, _ = self.work()
                self.good("prompt", owner, text="New user task")
                fields = {}
                if op == "publish":
                    fields = {"title": "New task", "instructions": "Fresh scope"}
                elif op in ("decide", "withdraw"):
                    task = self.good("publish", owner, title="New task", instructions="Fresh scope")["task"]
                    fields = {"task": task["task"]}
                    if op == "decide":
                        claimed = self.good("claim", helper)["task"]
                        self.good("complete", helper, task=task["task"], lease=claimed["lease"], result="Fresh result")
                        fields.update(decision="accept", rationale="Reviewed current result")
                    else:
                        fields["reason"] = "Do it locally"
                before = self.good("snapshot")
                self.assertFalse(self.call(op, owner, expected_revision=1, **fields)["ok"])
                self.assertEqual(self.good("snapshot"), before)
                self.good(op, owner, expected_revision=2, **fields)

    def test_prompt_and_revision_fenced_finish_publish_have_safe_both_orderings(self):
        for op in ("idle", "publish"):
            for prompt_first in (False, True):
                with self.subTest(op=op, prompt_first=prompt_first):
                    self.db = Path(self.temp.name) / (op + str(prompt_first)) / "db"
                    owner, _ = self.register()
                    self.good("prompt", owner, text="Original task")
                    fields = {"title": "Original delegation", "instructions": "Original scope"} if op == "publish" else {}
                    if prompt_first:
                        self.good("prompt", owner, text="New task")
                    response = self.call(op, owner, expected_revision=1, **fields)
                    self.assertEqual(response["ok"], not prompt_first)
                    if not prompt_first:
                        self.good("prompt", owner, text="New task")
                    snapshot = self.good("snapshot")
                    self.assertEqual(snapshot["members"][0]["owner_revision"], 2)
                    self.assertEqual(snapshot["members"][0]["owner_state"], "active")
                    self.assertEqual(snapshot["own_tasks"][-1]["state"], "active")
                    if op == "publish" and not prompt_first:
                        self.assertEqual(snapshot["tasks"][0]["state"], "cancelled")
                    else:
                        self.assertEqual(snapshot["tasks"], [])

    def test_expected_revision_is_optional_but_strictly_validated(self):
        owner, _ = self.register()
        for revision in (-1, True, 1.0, "0", 2 ** 63):
            with self.subTest(revision=revision):
                before = self.good("snapshot")
                self.assertFalse(self.call("idle", owner, expected_revision=revision)["ok"])
                self.assertEqual(self.good("snapshot"), before)
        self.good("idle", owner, expected_revision=0)
        self.assertFalse(self.call("heartbeat", owner, expected_revision=0)["ok"])
        self.good("idle", owner)


if __name__ == "__main__":
    unittest.main()
