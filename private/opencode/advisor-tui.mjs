import { advisorRPC } from "./advisor-rpc.mjs";

export function setupAdvisorTui(context) {
  const currentSession = () => {
    const route = context.ui.router.current();
    return route?.type === "session" ? route.sessionID : undefined;
  };
  const notify = (message, variant = "info") => context.ui.toast.show({ title: "Advisor", message, variant });
  const rpc = () => context.client.rpc(advisorRPC);
  const selecting = new Set();

  async function consult(question) {
    const sessionID = currentSession();
    if (!sessionID || selecting.has(sessionID)) return;
    selecting.add(sessionID);
    try {
      const { models } = await rpc().options({ sessionID });
      if (!models.length) {
        notify("No configured text model supports the Advisor's read tools.", "warning");
        return;
      }
      if (currentSession() !== sessionID) return;
      const key = ({ providerID, id }) => `${providerID}/${id}`;
      const modelKey = await context.ui.dialog.select({
        title: "Advisor model",
        current: key(models[0]),
        options: models.map((model, i) => ({
          title: `${model.name} · ${key(model)}`,
          value: key(model),
          ...(i === 0 ? { description: "Recommended" } : {}),
        })),
      });
      if (modelKey === undefined || currentSession() !== sessionID) return;
      const model = models.find((candidate) => key(candidate) === modelKey);
      if (!model) return;
      const recommend = model.variants.indexOf("high") + 1;
      const effort = await context.ui.dialog.select({
        title: "Advisor effort",
        current: recommend,
        options: ["Default", ...model.variants].map((title, value) => ({
          title, value, ...(value === recommend ? { description: "Recommended" } : {}),
        })),
      });
      if (effort === undefined || currentSession() !== sessionID) return;
      const variant = model.variants[effort - 1];
      notify("Consulting. Use /apana:advisor-cancel to stop.");
      const result = await rpc().consult({
        sessionID, providerID: model.providerID, modelID: model.id, question: question ?? "",
        ...(variant === undefined ? {} : { variant }),
      });
      if (!result.ok) notify(result.message, "warning");
    } catch {
      notify("Advisor is unavailable. Check that the Apana server plugin is loaded in this project.", "error");
    } finally {
      selecting.delete(sessionID);
    }
  }

  async function cancel() {
    const sessionID = currentSession();
    if (!sessionID) return;
    try {
      if (!(await rpc().cancel({ sessionID })).cancelled) notify("No advisor is running for this session.");
    } catch {
      notify("Could not reach the Advisor server plugin.", "error");
    }
  }

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      { id: "apana.advisor", title: "Consult Advisor", group: "Apana", palette: true,
        slash: { name: "apana:advisor", arguments: true }, enabled: () => Boolean(currentSession()),
        run: consult },
      { id: "apana.advisor.cancel", title: "Cancel Advisor", group: "Apana", palette: true,
        slash: { name: "apana:advisor-cancel" }, enabled: () => Boolean(currentSession()),
        run: cancel },
    ],
  }));
}
