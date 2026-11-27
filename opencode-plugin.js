// OpenCode server entry of apana (OpenCode 2.4.x; Claude Code uses its own manifest and hooks, see .claude-plugin/ and hooks/).
// logic-test-debug is set up on its own: a failure of the larger integration below must not take it away, and the other way round.
// A failure is isolated in each part: a separate dynamic import, a fixed diagnostic and no raw error text.
export default {
  id: "apana",
  async setup(ctx) {
    try {
      const { setupLogicTestDebug } = await import("./private/logic-test-debug/opencode.mjs");
      await setupLogicTestDebug(ctx, process.env);
    } catch {
      console.warn("[logic-test-debug] activation unavailable");
    }
    try {
      const { setupApana } = await import("./private/opencode/plugin.mjs");
      const apana = await setupApana(ctx, process.env);
      return () => apana.dispose();
    } catch {
      // setupApana has already undone what it registered: no skill is left without the hooks it needs.
      console.warn("[apana] the OpenCode integration is unavailable; nothing of it was left registered");
    }
  },
};
