// OpenCode plugin of apana. It only sets up logic-test-debug (default on, APANA_LOGIC_TEST_DEBUG=off turns it off).
// A failure is isolated here: a separate dynamic import, a fixed diagnostic and no raw error text.
export default {
  id: "apana",
  async setup(ctx) {
    try {
      const { setupLogicTestDebug } = await import("./private/logic-test-debug/opencode.mjs");
      await setupLogicTestDebug(ctx, process.env);
    } catch {
      console.warn("[logic-test-debug] activation unavailable");
    }
  },
};
