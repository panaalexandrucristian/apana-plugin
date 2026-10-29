#!/usr/bin/env python3
"""Bounded newline-JSON MCP bridge for a launcher-owned local supervisor.

The CLI owns socket/token/generation. Model arguments never choose identities,
registry paths, providers or transport destinations. The supervisor authenticates
and authorizes every operation; this bridge neither grants permissions nor runs
models. A supervisor reply is an object with boolean ``ok``; failures also carry
an ``error`` string. Replies are returned as MCP text containing that JSON object.

No request is retried: losing a reply does not establish that a mutation failed.
Protocol shape: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
"""
import argparse
import json
import math
import os
import socket
import sys
import time


MAX_MESSAGE_BYTES = 262144  # Includes the newline, on each transport.
MAX_JSON_DEPTH = 64
SOCKET_TIMEOUT = 5.0
PROTOCOL_VERSION = "2025-06-18"
ACTIONS = ("status", "publish", "results", "decide", "withdraw", "finish")
COORDINATE_TOOL = {
    "name": "coordinate",
    "description": (
        "Coordinate the current owner's task with isolated local collaborators. "
        "Publish bounded tasks with evidence; status/results reads attributed results; "
        "decide accepts/rejects with rationale; withdraw cancels delegation; finish "
        "explicitly completes your task when no unresolved delegations remain. "
        "Peer agreement never grants user permissions. Helpers cannot run tools."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "title": {"type": "string"},
            "instructions": {"type": "string"},
            "task": {"type": "string"},
            "decision": {"type": "string", "enum": ["accept", "reject"]},
            "rationale": {"type": "string"},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("Nonfinite JSON number")


def encode(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False,
                       separators=(",", ":")) + "\n").encode("utf-8")


def decode(data):
    value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object,
                       parse_constant=_invalid_constant)
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > MAX_JSON_DEPTH:
            raise ValueError("JSON exceeds nesting limit")
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    # Reject overflowed floats and unpaired escaped surrogates as well as NaN.
    encode(value)
    return value


def rpc_error(identifier, code, message):
    return {"jsonrpc": "2.0", "id": identifier,
            "error": {"code": code, "message": message}}


def rpc_result(identifier, value):
    return {"jsonrpc": "2.0", "id": identifier, "result": value}


def tool_result(payload):
    return {"content": [{"type": "text", "text": encode(payload).decode("utf-8").rstrip("\n")}],
            "isError": payload["ok"] is False}


def tool_error(message):
    return tool_result({"ok": False, "error": message})


class Bridge:
    def __init__(self, socket_path, token, generation, *, timeout=SOCKET_TIMEOUT):
        if (not isinstance(socket_path, str) or not os.path.isabs(socket_path)
                or "\0" in socket_path):
            raise ValueError("Socket path must be absolute and contain no NUL")
        if not isinstance(token, str) or not token.strip() or "\0" in token or len(token.encode("utf-8")) > 4096:
            raise ValueError("Token must be nonempty bounded text")
        if type(generation) is not int or not 1 <= generation <= 9223372036854775807:
            raise ValueError("Generation must be a positive SQLite integer")
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Timeout must be positive and finite")
        self.socket_path = socket_path
        self.token = token
        self.generation = generation
        self.timeout = timeout
        self.initialized = False
        self.ready = False

    def _forward(self, name, arguments):
        outbound = encode({"token": self.token, "generation": self.generation,
                           "name": name, "arguments": arguments})
        if len(outbound) > MAX_MESSAGE_BYTES:
            return tool_error("Supervisor request exceeds byte limit; nothing was sent")
        deadline = time.monotonic() + self.timeout
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                def remaining():
                    seconds = deadline - time.monotonic()
                    if seconds <= 0:
                        raise TimeoutError("Supervisor deadline expired")
                    connection.settimeout(seconds)

                remaining()
                connection.connect(self.socket_path)
                remaining()
                connection.sendall(outbound)
                data = bytearray()
                while True:
                    remaining()
                    chunk = connection.recv(min(65536, MAX_MESSAGE_BYTES + 1 - len(data)))
                    if not chunk:
                        raise ValueError("Incomplete supervisor response")
                    data.extend(chunk)
                    newline = data.find(b"\n")
                    if 0 <= newline < MAX_MESSAGE_BYTES:
                        payload = decode(bytes(data[:newline]))
                        break
                    if len(data) >= MAX_MESSAGE_BYTES:
                        raise ValueError("Supervisor response exceeds byte limit")
            if not isinstance(payload, dict) or type(payload.get("ok")) is not bool:
                raise ValueError("Supervisor response lacks boolean ok")
            if payload["ok"] is False and (not isinstance(payload.get("error"), str) or not payload["error"].strip()):
                raise ValueError("Supervisor failure lacks error text")
            return tool_result(payload)
        except OSError:
            return tool_error("Supervisor unavailable or timed out; outcome unknown. Check status before retrying")
        except (ValueError, UnicodeError, RecursionError):
            return tool_error("Invalid supervisor response; outcome unknown. Check status before retrying")

    def _call_tool(self, identifier, params):
        # Extension point: add a documented tool definition in tools/list and an
        # explicit validation/dispatch branch here. Never forward arbitrary names.
        # Permission-prompt tool schemas are not established; none is exposed.
        if set(params) - {"name", "arguments", "_meta"} or params.get("name") != "coordinate":
            return rpc_error(identifier, -32602, "Unknown tool or invalid call parameters")
        arguments = params.get("arguments")
        properties = COORDINATE_TOOL["inputSchema"]["properties"]
        if (not isinstance(arguments, dict) or set(arguments) - set(properties)
                or arguments.get("action") not in ACTIONS
                or any(not isinstance(value, str) for value in arguments.values())
                or ("decision" in arguments and arguments["decision"] not in ("accept", "reject"))):
            return rpc_error(identifier, -32602, "Invalid coordinate arguments")
        return rpc_result(identifier, self._forward("coordinate", arguments))

    def handle(self, message):
        if (not isinstance(message, dict) or message.get("jsonrpc") != "2.0"
                or not isinstance(message.get("method"), str)
                or set(message) - {"jsonrpc", "id", "method", "params"}):
            return rpc_error(None, -32600, "Invalid request")
        if "id" in message and (type(message["id"]) not in (str, int)
                                or len(str(message["id"]).encode("utf-8")) > 1024):
            return rpc_error(None, -32600, "Invalid request identifier")
        method = message["method"]
        params = message.get("params", {})
        if "id" not in message:
            # A tools/call notification must never perform an unacknowledged write.
            if method == "notifications/initialized" and self.initialized and isinstance(params, dict):
                self.ready = True
            return None
        identifier = message["id"]
        if not isinstance(params, dict) or ("_meta" in params and not isinstance(params["_meta"], dict)):
            return rpc_error(identifier, -32602, "Parameters must be an object with object metadata")
        if method == "ping":
            return rpc_result(identifier, {})
        if method == "initialize":
            if self.initialized:
                return rpc_error(identifier, -32600, "Already initialized")
            info = params.get("clientInfo")
            if (not isinstance(params.get("protocolVersion"), str) or not params["protocolVersion"]
                    or not isinstance(params.get("capabilities"), dict)
                    or not isinstance(info, dict)
                    or any(not isinstance(info.get(key), str) or not info[key] for key in ("name", "version"))):
                return rpc_error(identifier, -32602, "Invalid initialization parameters")
            self.initialized = True
            return rpc_result(identifier, {"protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "apana-managed-cooperation", "version": "1.0.0"}})
        if method in ("tools/list", "tools/call"):
            if not self.ready:
                return rpc_error(identifier, -32002, "Server not initialized")
            if method == "tools/list":
                if set(params) - {"_meta"}:
                    return rpc_error(identifier, -32602, "This tool list is not paginated")
                return rpc_result(identifier, {"tools": [COORDINATE_TOOL]})
            return self._call_tool(identifier, params)
        return rpc_error(identifier, -32601, "Method not found")


def _write_response(output, response):
    data = encode(response)
    if len(data) > MAX_MESSAGE_BYTES:
        if "result" in response and "content" in response["result"]:
            response = rpc_result(response["id"], tool_error(
                "Supervisor result exceeds MCP byte limit; outcome unknown. Check status before retrying"))
        else:
            response = rpc_error(response.get("id"), -32603, "Response exceeds byte limit")
        data = encode(response)
    output.write(data)
    output.flush()


def serve(bridge, source, output):
    """Process framed messages; overlong input closes rather than parsing its tail."""
    while True:
        line = source.readline(MAX_MESSAGE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_MESSAGE_BYTES:
            _write_response(output, rpc_error(None, -32600, "Message exceeds byte limit"))
            return
        if not line.endswith(b"\n"):
            _write_response(output, rpc_error(None, -32700, "Incomplete JSON frame"))
            return
        try:
            message = decode(line)
        except (ValueError, UnicodeError, RecursionError):
            _write_response(output, rpc_error(None, -32700, "Invalid JSON"))
            continue
        response = bridge.handle(message)
        if response is not None:
            _write_response(output, response)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--generation", required=True, type=int)
    args = parser.parse_args(argv)
    try:
        bridge = Bridge(args.socket, args.token, args.generation)
    except (ValueError, UnicodeError) as error:
        parser.error(str(error))
    try:
        serve(bridge, sys.stdin.buffer, sys.stdout.buffer)
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
