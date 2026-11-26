// OpenCode server plugin of opencode-shell-guard (OpenCode 2.4.2): refuses a shell command that runs grep and says why, through the
// permission.evaluate hook. A rule in "permissions" cannot carry a message, and one there that denies ends the check before any plugin
// hook runs, so the rules are applied here (scripts/rules.mjs). shell-guard.mjs links this folder into OpenCode's plugins/ folder; OpenCode
// 2.4.2 loads it through the link and keeps the link's path in import.meta.url (seen live), so the rules are imported from the real path.
// A failure must not take OpenCode down: a fixed diagnostic, and nothing left registered.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export default {
  id: "opencode-shell-guard",
  async setup(ctx) {
    try {
      const here = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));
      const { evaluate } = await import(new URL("../scripts/rules.mjs", here).href);
      const hook = await ctx.permission.hook("evaluate", evaluate);
      return () => hook.dispose();
    } catch {
      console.warn("[opencode-shell-guard] the permission hook could not be registered, so grep is not refused in shell commands");
    }
  },
};
