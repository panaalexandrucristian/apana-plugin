import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

describe("logic-test-debug is wired into the plugin", () => {
  it("both manifests carry 0.1.6 and the plugin declares no MCP server", () => {
    const plugin = JSON.parse(read(".claude-plugin", "plugin.json"));
    const market = JSON.parse(read(".claude-plugin", "marketplace.json"));
    assert.equal(plugin.version, "0.1.6");
    assert.equal(market.plugins.find((p) => p.name === "apana").version, "0.1.6");
    assert.equal(plugin.name, "apana");
    assert.equal(plugin.mcpServers, undefined, "no Jev MCP server entry");
    assert.deepEqual(plugin.userConfig?.logic_test_debug, {
      type: "string",
      title: "Logic test and debug guidance",
      description: "Add logic-test-debug guidance automatically to code prompts.",
      options: ["on", "off"],
      default: "on",
    });
    assert.deepEqual(plugin.userConfig?.class_graph_nudge, {
      type: "string",
      title: "Class graph reminders",
      description: "After /apana:class-graph, remind Claude to use the relationship tools instead of text search.",
      options: ["both", "nudge-only", "reminder-only", "off"],
      default: "both",
    });
  });
  it("calls the adapter from hooks/hooks.json: one UserPromptSubmit entry, the command and the 10 s timeout", () => {
    const hooks = JSON.parse(read("hooks", "hooks.json")).hooks;
    assert.equal(hooks.UserPromptSubmit.length, 1);
    const [entry] = hooks.UserPromptSubmit[0].hooks;
    assert.equal(entry.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/apana-hook.mjs" UserPromptSubmit');
    assert.equal(entry.timeout, 10);
    assert.ok(!read("hooks", "hooks.json").includes("logic-test-debug\""), "no second hook command, no SessionStart notice");
  });
  it("loads the hook by a guarded dynamic import on UserPromptSubmit only, never statically", () => {
    const script = read("scripts", "apana-hook.mjs");
    assert.ok(!/^import .*logic-test-debug/m.test(script), "no static import");
    const block = script.match(/try \{\s*if \(name === "UserPromptSubmit"\) \{[\s\S]*?\} catch \{[\s\S]*?\}/);
    assert.ok(block, "guarded block");
    assert.match(block[0], /await import\("\.\.\/private\/logic-test-debug\/hook\.mjs"\)/);
    assert.match(block[0], /\[logic-test-debug\] activation unavailable/);
  });
  it("sets the OpenCode extension up in its own try/catch, without a static import", () => {
    const plugin = read("opencode-plugin.js");
    assert.ok(!/^import .*logic-test-debug/m.test(plugin));
    assert.match(plugin, /try \{\s*const \{ setupLogicTestDebug \} = await import\("\.\/private\/logic-test-debug\/opencode\.mjs"\);\s*await setupLogicTestDebug\(ctx, process\.env\);\s*\} catch \{\s*console\.warn\("\[logic-test-debug\] activation unavailable"\);/);
  });
  it("documents the switch, the bounds and what was and was not checked on OpenCode in PRIVATE.md", () => {
    const doc = read("PRIVATE.md");
    assert.match(doc, /APANA_LOGIC_TEST_DEBUG/);
    assert.match(doc, /logic-test-debug/);
    assert.match(doc, /64 KiB/);
    assert.match(doc, /\*\*OpenCode, checked on 2\.0\.22 \(2026-10-10\), and not checked\.\*\*/);
    assert.match(doc, /node --test private\/logic-test-debug\/test\//);
    assert.match(doc, /`0\.10\.0` for the `logic-test-debug` skill/);
  });
});
