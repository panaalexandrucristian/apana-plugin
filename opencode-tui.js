export default {
  id: "apana.tui",
  async setup(context) {
    try {
      const { setupAdvisorTui } = await import("./private/opencode/advisor-tui.mjs");
      setupAdvisorTui(context);
    } catch {
      console.warn("[apana] the Advisor command is unavailable in this terminal");
    }
  },
};
