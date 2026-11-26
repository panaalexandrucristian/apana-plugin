// OpenCode server plugin of opencode-shell-guard (OpenCode 2.4.2): refuses a shell command that runs grep and says why, through the
// permission.evaluate hook. A rule in "permissions" cannot carry a message, and one there that denies ends the check before any plugin
// hook runs, so the rules are applied here (scripts/rules.mjs). shell-guard.mjs links this folder into OpenCode's plugins/ folder; through
// the link, import.meta.url is the real path (measured for apana-auto), so the relative import finds the skill.
// A failure must not take OpenCode down: a fixed diagnostic, and nothing left registered.
export default {
  id: "opencode-shell-guard",
  async setup(ctx) {
    try {
      const { evaluate } = await import("../scripts/rules.mjs");
      const hook = await ctx.permission.hook("evaluate", evaluate);
      return () => hook.dispose();
    } catch {
      console.warn("[opencode-shell-guard] the permission hook could not be registered, so grep is not refused in shell commands");
    }
  },
};
