// TUI entry of apana-auto (OpenCode 2.3.0): marks the sessions of a TUI that `opencode-auto` started and follows them to the new session after a handoff.
// Thin on purpose, like server.js: the logic is in private/opencode-auto/tui.mjs, and a failure is a fixed diagnostic with no raw error text.
// The id differs from the server entry's, as in the probe that was measured.
export default {
  id: "apana-auto.tui",
  async setup(context) {
    try {
      const { setupAutoTui } = await import("../private/opencode-auto/tui.mjs");
      const auto = await setupAutoTui(context, process.env);
      return () => auto.dispose();
    } catch {
      console.warn("[apana-auto] the TUI part is unavailable; the handoff still runs, but this window will not move to the new session by itself");
    }
  },
};
