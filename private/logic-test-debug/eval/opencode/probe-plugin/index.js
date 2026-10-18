// Test-only plugin, loaded AFTER the plugin under test so its `context` hook sees the system prompt the model will get.
// It records, per model request of the main agent, only whether PROBE_DIRECTIVE is in the system prompt and how many system
// entries there are: never any prompt text. It also records the method, URL and status of the provider's HTTP calls (never headers
// or bodies), to tell a routing error from a refusal. Output: one JSON line per event in PROBE_LOG.
import { appendFileSync } from "node:fs";

const LOG = process.env.PROBE_LOG;
const DIRECTIVE = process.env.PROBE_DIRECTIVE ?? "";
const log = (line) => {
  try {
    if (LOG) appendFileSync(LOG, `${JSON.stringify(line)}\n`);
  } catch {
    // The probe must never break a session.
  }
};

export default {
  id: "ltd-probe",
  async setup(ctx) {
    await ctx.session.hook("context", (input) => {
      const system = Array.isArray(input?.system) ? input.system : [];
      const present = DIRECTIVE.length > 0 && system.some((part) => typeof part?.text === "string" && part.text.includes(DIRECTIVE));
      log({ at: "context", agent: input?.agent ?? null, systemEntries: system.length, directive: present });
    });
    for (const providerID of (process.env.PROBE_PROVIDERS ?? "").split(",").filter(Boolean)) {
      try {
        await ctx.session.hook("http.request", (input) => { log({ at: "http.request", method: input?.request?.method ?? null, url: String(input?.request?.url ?? "").slice(0, 200) }); }, { providerID });
        await ctx.session.hook("http.response", (input) => { log({ at: "http.response", status: input?.response?.status ?? null, url: String(input?.request?.url ?? "").slice(0, 200) }); }, { providerID });
      } catch {
        // A version without these hooks simply records nothing.
      }
    }
  },
};
