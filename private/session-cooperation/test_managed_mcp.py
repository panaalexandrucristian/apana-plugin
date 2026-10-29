"""Offline bridge tests: real AF_UNIX transport, never a model or live peer.

Interaction model (INFERENCE): targeted t=2 covers action x malformed field,
readiness x method, and response framing x payload validity. Separate cases
exercise byte bounds, elapsed timeout and untrusted notification side effects;
this is not a claim of exhaustive protocol or structural coverage.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest


SOURCE = (Path(__file__).resolve().parents[2] /
          "skills/install-claude-auto/assets/cooperation/scripts/managed_mcp.py")
spec = importlib.util.spec_from_file_location("managed_mcp", SOURCE)
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)


def request(method, params=None, identifier=1):
    result = {"jsonrpc": "2.0", "id": identifier, "method": method}
    if params is not None:
        result["params"] = params
    return result


def initialization(version="2025-06-18"):
    return request("initialize", {"protocolVersion": version, "capabilities": {},
                                 "clientInfo": {"name": "test", "version": "fixture"}})


def frame(value):
    return (json.dumps(value) + "\n").encode()


class ManagedMCPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="amcp-")
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "s")
        self.token = "private-supervisor-token"
        self.bridge = mcp.Bridge(self.path, self.token, 7, timeout=0.15)

    def ready(self):
        response = self.bridge.handle(initialization())
        self.assertIn("result", response)
        self.assertIsNone(self.bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def call(self, arguments, name="coordinate"):
        return self.bridge.handle(request("tools/call", {"name": name, "arguments": arguments}, "call"))

    @contextlib.contextmanager
    def supervisor(self, response, *, stall=False, drip=False):
        """An owned disposable socket; failures in the serving thread reach the test."""
        received, errors = [], []
        stop = threading.Event()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(self.path)
            listener.listen(1)
            listener.settimeout(2)

            def serve():
                try:
                    with listener.accept()[0] as connection:
                        connection.settimeout(2)
                        with connection.makefile("rb") as stream:
                            received.append(json.loads(stream.readline()))
                        if stall:
                            stop.wait(2)
                        elif drip:
                            for byte in response:
                                if stop.wait(0.04):
                                    break
                                connection.sendall(bytes([byte]))
                        else:
                            connection.sendall(response)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Expected when the bounded reader rejects a reply.
                except Exception as error:
                    errors.append(error)

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            try:
                yield received
            finally:
                stop.set()
                thread.join(3)
                self.assertFalse(thread.is_alive(), "fake supervisor did not stop")
                self.assertEqual(errors, [])
                Path(self.path).unlink(missing_ok=True)

    def assert_tool_error(self, response):
        self.assertEqual(response["id"], "call")
        result = response["result"]
        self.assertTrue(result["isError"], result)
        self.assertEqual(result["content"][0]["type"], "text")
        payload = json.loads(result["content"][0]["text"])
        self.assertIs(payload["ok"], False)
        self.assertIsInstance(payload["error"], str)
        self.assertNotIn(self.token, json.dumps(response))
        self.assertNotIn(self.path, json.dumps(response))

    def test_initialize_negotiates_and_advertises_only_coordinate(self):
        for version in ("2025-06-18", "unrecognized-future-version"):
            with self.subTest(version=version):
                self.bridge = mcp.Bridge(self.path, self.token, 7)
                response = self.bridge.handle(initialization(version))
                self.assertEqual(response["result"]["protocolVersion"], "2025-06-18")
                self.assertEqual(response["result"]["capabilities"], {"tools": {}})
                self.assertIsNone(self.bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
                listing = self.bridge.handle(request("tools/list"))["result"]["tools"]
                self.assertEqual([tool["name"] for tool in listing], ["coordinate"])
                schema = listing[0]["inputSchema"]
                self.assertEqual(schema["required"], ["action"])
                self.assertFalse(schema["additionalProperties"])
                self.assertEqual(set(schema["properties"]),
                                 {"action", "title", "instructions", "task", "decision", "rationale"})
                self.assertEqual(set(schema["properties"]["action"]["enum"]),
                                 {"status", "publish", "results", "decide", "withdraw", "finish"})
                self.assertNotIn(self.token, json.dumps(listing))
                self.assertNotIn(self.path, json.dumps(listing))

    def test_readiness_gates_tools_but_ping_is_always_safe(self):
        for stage in ("new", "initialized", "ready"):
            self.bridge = mcp.Bridge(self.path, self.token, 7)
            if stage != "new":
                self.bridge.handle(initialization())
            if stage == "ready":
                self.bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
            with self.subTest(stage=stage):
                self.assertEqual(self.bridge.handle(request("ping", identifier=0))["result"], {})
                for message in (request("tools/list"), request("tools/call", {"name": "coordinate", "arguments": {"action": "status"}})):
                    if stage != "ready":
                        self.assertEqual(self.bridge.handle(message)["error"]["code"], -32002)

    def test_bad_initialization_does_not_enable_tools(self):
        for params in ({}, {"protocolVersion": 3}, {"protocolVersion": "2025-06-18", "capabilities": [], "clientInfo": {}},
                       {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test"}}):
            with self.subTest(params=params):
                response = self.bridge.handle(request("initialize", params))
                self.assertEqual(response["error"]["code"], -32602)
                self.bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
                self.assertEqual(self.bridge.handle(request("tools/list"))["error"]["code"], -32002)

    def test_notifications_never_forward_tool_calls_or_initialize(self):
        self.assertIsNone(self.bridge.handle({"jsonrpc": "2.0", "method": "initialize", "params": initialization()["params"]}))
        self.assertEqual(self.bridge.handle(request("tools/list"))["error"]["code"], -32002)
        self.ready()
        for method in ("tools/call", "notifications/cancelled", "unrecognized"):
            message = {"jsonrpc": "2.0", "method": method, "params": {"name": "coordinate", "arguments": {"action": "finish"}}}
            self.assertIsNone(self.bridge.handle(message))
        self.assertFalse(Path(self.path).exists())

    def test_invalid_envelopes_and_unknown_methods_fail_closed(self):
        invalid = ([], None, True, {}, {"jsonrpc": "1.0", "id": 1, "method": "ping"},
                   {"jsonrpc": "2.0", "id": True, "method": "ping"},
                   {"jsonrpc": "2.0", "id": None, "method": "ping"},
                   {"jsonrpc": "2.0", "id": {}, "method": "ping"},
                   {"jsonrpc": "2.0", "id": 1, "method": 5},
                   {"jsonrpc": "2.0", "id": 1, "method": "ping", "result": {}})
        for message in invalid:
            with self.subTest(message=message):
                self.assertEqual(self.bridge.handle(message)["error"]["code"], -32600)
        self.assertEqual(self.bridge.handle(request("unexpected"))["error"]["code"], -32601)
        self.assertEqual(self.bridge.handle(request("ping", []))["error"]["code"], -32602)

    def test_all_actions_use_launcher_identity_and_return_json_text(self):
        self.ready()
        cases = ({"action": "status"}, {"action": "results"}, {"action": "finish"},
                 {"action": "publish", "title": "Review", "instructions": "Explicit evidence"},
                 {"action": "decide", "task": "task-id", "decision": "accept", "rationale": "Checked"},
                 {"action": "withdraw", "task": "task-id", "rationale": "Superseded"})
        for arguments in cases:
            with self.subTest(action=arguments["action"]):
                payload = {"ok": True, "detail": "rationale\nUnicode: \u00e9", "tasks": []}
                with self.supervisor(frame(payload)) as received:
                    response = self.call(arguments)
                self.assertEqual(received, [{"token": self.token, "generation": 7,
                                             "name": "coordinate", "arguments": arguments}])
                self.assertIs(response["result"]["isError"], False)
                self.assertEqual(json.loads(response["result"]["content"][0]["text"]), payload)

    def test_schema_invalid_arguments_never_reach_transport(self):
        self.ready()
        invalid = [None, [], {}, {"action": "register"}, {"action": False},
                   {"action": "decide", "decision": "approve"}]
        for action in ("status", "publish", "results", "decide", "withdraw", "finish"):
            for key, value in (("socket", "/tmp/other"), ("token", "attacker"), ("generation", 99),
                               ("db", "/tmp/db"), ("model", "other"), ("title", []),
                               ("instructions", {}), ("task", 5), ("rationale", None)):
                invalid.append({"action": action, key: value})
        for arguments in invalid:
            with self.subTest(arguments=arguments):
                self.assertEqual(self.call(arguments)["error"]["code"], -32602)
        self.assertFalse(Path(self.path).exists())
        self.assertEqual(self.call({"action": "status"}, "permission")["error"]["code"], -32602)
        self.assertEqual(self.bridge.handle(request("tools/call", {"name": "coordinate", "arguments": {"action": "status"}, "token": "injected"}))["error"]["code"], -32602)

    def test_supervisor_error_is_a_tool_error_without_a_retry(self):
        self.ready()
        with self.supervisor(frame({"ok": False, "error": "Stale generation"})) as received:
            response = self.call({"action": "finish"})
        self.assert_tool_error(response)
        self.assertEqual(len(received), 1)
        self.assertEqual(json.loads(response["result"]["content"][0]["text"])["error"], "Stale generation")

    def test_malformed_supervisor_reply_is_never_success(self):
        self.ready()
        cases = (b"not JSON\n", b"\xff\n", b"{}\n", b"[]\n", b'{"ok":1}\n',
                 b'{"ok":true,"ok":false}\n', b'{"ok":true,"number":NaN}\n',
                 b'{"ok":true,"number":1e999}\n', b'{"ok":false}\n',
                 b'{"ok":true}', b'', b'{"ok":true} trailing\n',
                 b'x' * (mcp.MAX_MESSAGE_BYTES + 1))
        for reply in cases:
            with self.subTest(reply=reply[:60]):
                with self.supervisor(reply):
                    self.assert_tool_error(self.call({"action": "status"}))

    def test_unavailable_and_stalled_socket_are_bounded_tool_errors(self):
        self.ready()
        self.assert_tool_error(self.call({"action": "status"}))
        for options in ({"stall": True}, {"drip": True}):
            with self.subTest(options=options):
                with self.supervisor(frame({"ok": True, "long": "x" * 50}), **options):
                    started = time.monotonic()
                    self.assert_tool_error(self.call({"action": "status"}))
                    self.assertLess(time.monotonic() - started, 1.5)

    def test_std_io_handles_malformed_frames_and_keeps_following_requests(self):
        malformed = (b'{broken}\n', b'\xff\n', b'{"id":1,"id":2}\n',
                     b'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"n":NaN}}\n',
                     b'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"n":1e999}}\n',
                     b'[' * 2000 + b']' * 2000 + b'\n',
                     b'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"s":"\\ud800"}}\n')
        for prefix in malformed:
            with self.subTest(prefix=prefix[:30]):
                out = io.BytesIO()
                mcp.serve(self.bridge, io.BytesIO(prefix + frame(request("ping", identifier="after"))), out)
                replies = [json.loads(line) for line in out.getvalue().splitlines()]
                self.assertEqual(replies[0]["error"]["code"], -32700)
                self.assertEqual(replies[1], {"jsonrpc": "2.0", "id": "after", "result": {}})

    def test_oversized_stdin_frame_closes_without_executing_following_data(self):
        out = io.BytesIO()
        source = io.BytesIO(b'x' * (mcp.MAX_MESSAGE_BYTES + 1) + b'\n' + frame(request("ping")))
        mcp.serve(self.bridge, source, out)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["error"]["code"], -32600)
        self.assertLessEqual(len(out.getvalue()), mcp.MAX_MESSAGE_BYTES)

    def test_unterminated_stdin_frame_is_not_executed(self):
        out = io.BytesIO()
        mcp.serve(self.bridge, io.BytesIO(frame(request("ping"))[:-1]), out)
        self.assertEqual(json.loads(out.getvalue())["error"]["code"], -32700)

    def test_exact_byte_limit_frames_are_accepted_without_losing_next_message(self):
        self.ready()
        prefix = b'{"ok":true}'
        reply = prefix + b' ' * (mcp.MAX_MESSAGE_BYTES - len(prefix) - 1) + b'\n'
        with self.supervisor(reply):
            self.assertFalse(self.call({"action": "status"})["result"]["isError"])
        incoming = b'{}' + b' ' * (mcp.MAX_MESSAGE_BYTES - 3) + b'\n'
        output = io.BytesIO()
        mcp.serve(self.bridge, io.BytesIO(incoming + frame(request("ping", identifier="next"))), output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(replies[0]["error"]["code"], -32600)
        self.assertEqual(replies[1]["id"], "next")
        self.assertEqual(replies[1]["result"], {})

    def test_outgoing_request_limit_counts_utf8_and_never_connects(self):
        self.ready()
        self.assert_tool_error(self.call({"action": "publish", "instructions": "é" * (mcp.MAX_MESSAGE_BYTES // 2)}))
        self.assertFalse(Path(self.path).exists())

    def test_json_nesting_limit_has_an_explicit_boundary(self):
        permitted = b'[' * mcp.MAX_JSON_DEPTH + b'0' + b']' * mcp.MAX_JSON_DEPTH
        self.assertIsInstance(mcp.decode(permitted), list)
        with self.assertRaises(ValueError):
            mcp.decode(b'[' + permitted + b']')

    def test_reinitialization_and_invalid_metadata_do_not_reset_identity(self):
        self.ready()
        self.assertEqual(self.bridge.handle(initialization())["error"]["code"], -32600)
        for params in ({"name": "coordinate", "arguments": {"action": "status"}, "_meta": []},
                       {"name": "coordinate", "arguments": {"action": "status"}, "extra": True}):
            self.assertEqual(self.bridge.handle(request("tools/call", params))["error"]["code"], -32602)
        self.assertEqual(self.bridge.handle(request("tools/list", {"cursor": "unsupported"}))["error"]["code"], -32602)
        self.assertIn("result", self.bridge.handle(request("tools/list", {"_meta": {}})))
        self.assertEqual(self.bridge.handle(request("ping", identifier="x" * 1025))["error"]["code"], -32600)

    def test_response_encoding_is_bounded(self):
        self.ready()
        payload = {"ok": True, "text": '"' * (mcp.MAX_MESSAGE_BYTES // 3)}
        raw = frame(payload)
        self.assertLess(len(raw), mcp.MAX_MESSAGE_BYTES)
        incoming = frame(request("tools/call", {"name": "coordinate", "arguments": {"action": "status"}}, "call"))
        output = io.BytesIO()
        with self.supervisor(raw):
            mcp.serve(self.bridge, io.BytesIO(incoming), output)
        self.assertLessEqual(len(output.getvalue()), mcp.MAX_MESSAGE_BYTES)
        self.assert_tool_error(json.loads(output.getvalue()))

    def test_cli_real_stdio_round_trip_and_no_stdout_diagnostics(self):
        messages = [initialization(), {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    request("tools/list", identifier=2),
                    request("tools/call", {"name": "coordinate", "arguments": {"action": "results"}}, 3),
                    request("ping", identifier=4)]
        with self.supervisor(frame({"ok": True, "tasks": []})) as received:
            process = subprocess.run([sys.executable, "-I", "-B", str(SOURCE), "--socket", self.path,
                                      "--token", self.token, "--generation", "7"],
                                     input=b''.join(frame(item) for item in messages), capture_output=True, timeout=5)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stderr, b'')
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([reply["id"] for reply in replies], [1, 2, 3, 4])
        self.assertFalse(replies[2]["result"]["isError"])
        self.assertEqual(received[0]["generation"], 7)
        self.assertNotIn(self.token.encode(), process.stdout)

    def test_invalid_cli_configuration_never_writes_stdout(self):
        base = [sys.executable, "-I", "-B", str(SOURCE)]
        cases = (["--socket", "relative", "--token", "secret", "--generation", "1"],
                 ["--socket", self.path, "--token", "", "--generation", "1"],
                 ["--socket", self.path, "--token", "secret", "--generation", "0"],
                 ["--socket", self.path, "--token", "secret", "--generation", "bad"])
        for args in cases:
            with self.subTest(args=args):
                result = subprocess.run(base + args, input=b'', capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'')
                self.assertNotIn(b'Traceback', result.stderr)


if __name__ == "__main__":
    unittest.main()
