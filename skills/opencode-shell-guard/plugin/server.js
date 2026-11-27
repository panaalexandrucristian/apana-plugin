// OpenCode server plugin of opencode-shell-guard (OpenCode 2.4.2): refuses a shell command that runs grep and says why, through the
// permission.evaluate hook. A rule in "permissions" cannot carry a message, and one there that denies ends the check before any plugin
// hook runs, so the rules are applied here (scripts/rules.mjs). shell-guard.mjs links this folder into OpenCode's plugins/ folder; OpenCode
// 2.4.2 loads it through the link and keeps the link's path in import.meta.url (seen live), so the rules are read from the real path.
// When this file changes, OpenCode reloads it and drops from Bun's module cache only the files it imports by a literal path. Bun keys
// that cache by path without the query (seen live: `rules.mjs?v=<mtime>` brought back the old rules), so the rules are imported as a
// data: URL of their text, which takes changed rules at every reload, in Bun as in Node.
// A failure must not take OpenCode down: a fixed diagnostic, and nothing left registered.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export default {
  id: "opencode-shell-guard",
  async setup(ctx) {
    try {
      const here = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));
      const rules = readFileSync(new URL("../scripts/rules.mjs", here));
      const { evaluate } = await import(`data:text/javascript;base64,${rules.toString("base64")}`);
      const hook = await ctx.permission.hook("evaluate", evaluate);
      return () => hook.dispose();
    } catch {
      console.warn("[opencode-shell-guard] the permission hook could not be registered, so grep is not refused in shell commands");
    }
  },
};
