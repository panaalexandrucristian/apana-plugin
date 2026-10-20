import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logicEnabled } from "../check.mjs";

describe("APANA_LOGIC_TEST_DEBUG switch", () => {
  it("is on when the variable is absent (default on, unlike the opt-in JEV_FLOW)", () => {
    assert.equal(logicEnabled({}), true);
    assert.equal(logicEnabled(undefined), true);
    assert.equal(logicEnabled({ APANA_LOGIC_TEST_DEBUG: undefined }), true);
  });
  it("is on for on, 1 and true, trimmed and case-insensitive", () => {
    for (const value of ["on", "1", "true", "ON", " True ", "\tOn\n"]) assert.equal(logicEnabled({ APANA_LOGIC_TEST_DEBUG: value }), true, value);
  });
  it("reads the plugin configuration option when the legacy variable is absent", () => {
    assert.equal(logicEnabled({ CLAUDE_PLUGIN_OPTION_LOGIC_TEST_DEBUG: "on" }), true);
    assert.equal(logicEnabled({ CLAUDE_PLUGIN_OPTION_LOGIC_TEST_DEBUG: "off" }), false);
  });
  it("keeps an explicit legacy variable as the backwards-compatible override", () => {
    assert.equal(logicEnabled({ APANA_LOGIC_TEST_DEBUG: "off", CLAUDE_PLUGIN_OPTION_LOGIC_TEST_DEBUG: "on" }), false);
    assert.equal(logicEnabled({ APANA_LOGIC_TEST_DEBUG: "on", CLAUDE_PLUGIN_OPTION_LOGIC_TEST_DEBUG: "off" }), true);
  });
  it("is off for off, 0, false, an empty value and every unrecognised value", () => {
    for (const value of ["off", "0", "false", "OFF", " False ", "", "   ", "no", "yes", "enabled", "2", "garbage"]) {
      assert.equal(logicEnabled({ APANA_LOGIC_TEST_DEBUG: value }), false, JSON.stringify(value));
    }
  });
  it("does not depend on JEV_FLOW, JEV_FLOW_STRICT or the control mode", () => {
    for (const flow of [undefined, "on", "off", "1", "0"]) {
      assert.equal(logicEnabled({ JEV_FLOW: flow }), true);
      assert.equal(logicEnabled({ JEV_FLOW: flow, APANA_LOGIC_TEST_DEBUG: "off" }), false);
    }
    assert.equal(logicEnabled({ JEV_FLOW_STRICT: "1", JEV_CONTROL_THRESHOLD: "0.9" }), true);
  });
});
