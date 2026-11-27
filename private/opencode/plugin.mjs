// apana on OpenCode: the skills and commands of catalog.mjs, the modes of modes.mjs and the compaction of compaction.mjs.
// Supports OpenCode 2.4.x (verified on 2.4.2; see PRIVATE.md, "OpenCode"). Setup is all or nothing for this part: every registration is
// remembered, and when one step fails the others are undone and the error is thrown, so that no skill that depends on a hook
// is ever offered without it. (opencode-plugin.js then leaves the independent logic-test-debug adapter running.)
import { loadCatalog } from "./catalog.mjs";
import { createCompaction } from "./compaction.mjs";
import { adapterEnv, createModes } from "./modes.mjs";

const REQUIRED = [
  "session.hook", "session.get", "session.prompt", "session.compact", "session.context", "session.synthetic", "tool.hook",
  "skill.transform", "skill.list", "command.transform", "storage.get", "storage.set", "storage.remove",
];
const MODE_OF = { scope: "scope", "jev-decision-loop": "jev" };
const SHORT = 160;

const has = (ctx, path) => typeof path.split(".").reduce((value, key) => value?.[key], ctx) === "function";
const bare = (list) => (Array.isArray(list) ? list : []).map(({ mention, ...rest }) => rest);
const brief = (text) => {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length <= SHORT ? line : `${line.slice(0, SHORT - 1).replace(/\s+\S*$/, "")}…`;
};

export async function setupApana(ctx, env = process.env, options = {}) {
  const registrations = [];
  const keep = async (pending) => {
    const registration = await pending;
    registrations.push(registration);
    return registration;
  };
  const compaction = createCompaction(ctx, options.compaction);
  const undo = async () => {
    compaction.dispose();
    await Promise.allSettled(registrations.splice(0).map((registration) => registration.dispose()));
  };
  try {
    for (const path of REQUIRED) if (!has(ctx, path)) throw new Error(`OpenCode does not offer ${path}`);
    const catalog = await (options.loadCatalog ?? loadCatalog)();
    const byId = new Map(catalog.skills.map((skill) => [skill.id, skill]));
    // Ownership is read when it is needed, never captured: another source may register the same id after this plugin.
    const owns = async (id) => {
      const skill = byId.get(id);
      const listed = (await ctx.skill.list())?.data ?? [];
      return skill !== undefined && listed.some((entry) => entry?.id === id && entry.path === skill.path);
    };
    const modes = createModes(ctx, { env: adapterEnv(env), owns });

    await keep(ctx.session.hook("prompt", modes.onPrompt));
    await keep(
      ctx.session.hook("context", async (event) => {
        const notes = await modes.onContext(event);
        const latest = event.messages.findLast((m) => m?.role === "user" && typeof m.id === "string")?.id;
        try {
          const report = await compaction.report(event.sessionID, latest);
          if (report) notes.push(`compact-session result (completed; do not rerun): ${report}`);
        } catch {
          // The report is guidance; the next request tries again.
        }
        for (const text of notes) event.system.push({ type: "text", text });
      }),
    );
    await keep(ctx.tool.hook("execute.before", modes.beforeTool));
    await keep(ctx.tool.hook("execute.after", modes.afterTool));
    await keep(ctx.session.hook("experimental.idle", modes.onIdle));
    await compaction.install(keep);

    // Skills that another source already registered, or that the logic-test-debug adapter registers, are not added again.
    const own = catalog.skills.filter((skill) => !skill.adapter);
    await keep(
      ctx.skill.transform((editor) => {
        for (const skill of own) {
          if (editor.get(skill.id)) continue;
          editor.add({ id: skill.id, name: skill.name, description: skill.description, path: skill.path, content: skill.content, autoinvoke: skill.autoinvoke });
        }
      }),
    );

    const listed = (await ctx.skill.list())?.data ?? [];
    const registered = catalog.skills.filter((skill) => listed.some((entry) => entry?.id === skill.id && entry.path === skill.path));
    const definitions = [
      ...registered.map((skill) => ({
        name: `apana:${skill.id}`,
        description: brief(skill.description),
        execute: async ({ sessionID, prompt, delivery }) => {
          if (!(await owns(skill.id))) throw new Error(`apana:${skill.id}: the skill id "${skill.id}" is used by another source in this session`);
          if (skill.id === "compact-session") {
            await compaction.request(sessionID, delivery);
            return;
          }
          const kind = MODE_OF[skill.id];
          const refused = kind ? await modes.refusal(kind, sessionID) : null;
          if (refused) throw new Error(refused);
          const args = typeof prompt.text === "string" ? prompt.text : "";
          // The text is the command as the user typed it, so the modes (and $ARGUMENTS) read the same thing in every client.
          const text = args.trim() ? `/apana:${skill.id} ${args}` : `/apana:${skill.id}`;
          const skills = bare(prompt.skills).filter((s) => s.id !== skill.id);
          await ctx.session.prompt({ sessionID, delivery, text, files: bare(prompt.files), agents: bare(prompt.agents), skills: [...skills, { id: skill.id }] });
        },
      })),
      ...catalog.commands.map((command) => ({
        name: command.name,
        description: command.description,
        execute: async ({ sessionID, prompt, delivery }) => {
          const text = command.content.replaceAll("$ARGUMENTS", () => (typeof prompt.text === "string" ? prompt.text : ""));
          await ctx.session.prompt({ sessionID, delivery, text, files: bare(prompt.files), agents: bare(prompt.agents), skills: bare(prompt.skills) });
        },
      })),
    ];
    await keep(
      ctx.command.transform((editor) => {
        for (const definition of definitions) editor.add(definition);
      }),
    );
    return { skills: registered.map((skill) => skill.id), commands: definitions.map((d) => d.name), dispose: () => compaction.dispose() };
  } catch (error) {
    await undo();
    throw error;
  }
}
