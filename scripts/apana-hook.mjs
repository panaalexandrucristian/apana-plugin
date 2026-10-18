#!/usr/bin/env node
// Claude Code hook adapter of the apana plugin. Usage (from hooks/hooks.json):
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/apana-hook.mjs" <EventName>  < hook-input.json
// Prints the hook JSON output (if any) and always exits 0: an internal error yields one stderr diagnostic and no output.
// Two features add context and never decide anything. Each is loaded by a guarded dynamic import, so a failure, even at
// load time, leaves the output of the other unchanged.
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  const name = process.argv[2] ?? input.hook_event_name;
  let output = null;
  // logic-test-debug (default on, APANA_LOGIC_TEST_DEBUG=off turns it off) adds its own directive on code prompts only.
  try {
    if (name === "UserPromptSubmit") {
      const logic = await import("../private/logic-test-debug/hook.mjs");
      output = logic.composeOutput(output, logic.handleLogicHook(name, input, process.env));
    }
  } catch {
    process.stderr.write("[logic-test-debug] activation unavailable\n");
  }
  // class-graph nudge (default on, APANA_CLASS_GRAPH_NUDGE=off turns it off): records a bare /apana:class-graph for the session,
  // then reminds on later prompts and notes a Bash or Grep-tool text search for a class or member name. Context only, never a decision.
  // Loaded only for the events and tool it reads, so no other call pays for loading it.
  try {
    if (name === "UserPromptSubmit" || (name === "PreToolUse" && (input?.tool_name === "Bash" || input?.tool_name === "Grep"))) {
      const nudge = await import("../private/class-graph-nudge/hook.mjs");
      output = nudge.composeNudge(output, nudge.handleNudgeHook(name, input, process.env));
    }
  } catch {
    process.stderr.write("[class-graph-nudge] unavailable\n");
  }
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`[apana] hook error: ${String(error?.message ?? error)}\n`);
}
process.exitCode = 0;
