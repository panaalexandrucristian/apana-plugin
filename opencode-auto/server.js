// Server entry of apana-auto (OpenCode 2.3.0): the plugin folder that `opencode-auto` registers, apart from the apana plugin (opencode-plugin.js).
// Thin on purpose: the logic is in private/opencode-auto/server.mjs. The folder may be reached through a link; import.meta.url is the real path
// of this file then (measured), so the relative import below finds the repository.
// A failure must not take OpenCode down: a fixed diagnostic, no raw error text, and setupAuto has already undone what it registered.
export default {
  id: "apana-auto",
  async setup(ctx) {
    try {
      const { setupAuto } = await import("../private/opencode-auto/server.mjs");
      const auto = await setupAuto(ctx, process.env);
      return () => auto.dispose();
    } catch {
      console.warn("[apana-auto] the automatic handoff is unavailable; nothing of it was left registered");
    }
  },
};
