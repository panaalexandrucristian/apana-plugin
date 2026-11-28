const text = { type: "string" };
const strings = { type: "array", items: text };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });

// The OpenCode Promise SDK takes a structural RPC definition; no plugin runtime dependency.
export const advisorRPC = {
  id: "apana-advisor",
  methods: {
    options: {
      input: object({ sessionID: text }),
      output: object({ models: { type: "array", items: object({ providerID: text, id: text, name: text, variants: strings }) } }),
    },
    consult: {
      input: object({ sessionID: text, providerID: text, modelID: text, variant: text, question: text }, ["sessionID", "providerID", "modelID", "question"]),
      output: object({ message: text, ok: { type: "boolean" } }),
    },
    cancel: {
      input: object({ sessionID: text }),
      output: object({ cancelled: { type: "boolean" } }),
    },
  },
  events: {},
};
