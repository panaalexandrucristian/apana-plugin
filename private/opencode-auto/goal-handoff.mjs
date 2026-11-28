import { randomUUID } from "node:crypto";

const PREFIX = "goal-handoff/";
const MARKER_NAME = "apana-goal-handoff.txt";
const INTERRUPTED = "Stopped by the user";
const GOAL_RPC = {
  id: "opencode.goal",
  methods: {
    get: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] },
      output: { type: ["object", "null"] },
    },
  },
  events: {},
};

const keyOf = (sourceID) => PREFIX + sourceID;
const markerURI = (id) => `data:text/plain;base64,${Buffer.from(id).toString("base64")}`;
const owns = (session, entry) =>
  session?.id === entry.destinationID && session.metadata?.apana?.goalHandoff?.id === entry.id &&
  session.metadata.apana.goalHandoff.sourceID === entry.sourceID;

export function sameGoal(left, right) {
  return left?.id === right?.id && left?.objective === right?.objective;
}

export function samePause(paused, current) {
  return current?.status === "paused" && sameGoal(paused, current) &&
    paused.reason === current.reason && paused.updatedAt === current.updatedAt;
}

export function pausedByInterrupt(before, after) {
  return after?.status === "paused" && after.reason === INTERRUPTED && sameGoal(before, after);
}

export function goalHandoff(ctx) {
  const storage = ctx.storage;
  const durable = ["get", "set", "scan", "remove"].every((name) => typeof storage?.[name] === "function");
  const supported = durable && typeof ctx.session?.hook === "function" && typeof ctx.session?.context === "function" &&
    typeof ctx.session?.instructions?.entry?.put === "function" && typeof ctx.session?.command === "function";

  async function read(sessionID, optional = false) {
    if (typeof ctx.rpc !== "function" && optional) return null;
    try {
      return await ctx.rpc(GOAL_RPC).get({ sessionID });
    } catch (error) {
      if (optional && error?.type === "rpc.unavailable") return null;
      throw new Error("could not read the native goal", { cause: error });
    }
  }

  function save(entry, phase) {
    return storage.set(keyOf(entry.sourceID), { ...entry, phase });
  }

  async function* pending() {
    if (!durable) return;
    let after;
    do {
      const page = await storage.scan({ prefix: PREFIX, after, limit: 100 });
      for (const { value } of page.entries) yield value;
      after = page.next;
    } while (after !== undefined);
  }

  async function destination(entry) {
    let session;
    try {
      session = await ctx.session.get({ sessionID: entry.destinationID });
    } catch (error) {
      if (error?._tag === "Session.NotFoundError") return null;
      throw error;
    }
    if (!owns(session, entry)) throw new Error("destination does not match the goal handoff journal");
    return session;
  }

  async function discard(entry) {
    if (!await destination(entry)) return;
    if ((await ctx.session.context({ sessionID: entry.destinationID })).length) {
      throw new Error("the provisional destination already has messages");
    }
    await ctx.session.remove({ sessionID: entry.destinationID });
  }

  async function admitted(entry) {
    if (!await destination(entry)) throw new Error("the journaled goal destination is missing");
    if (entry.phase === "accepted") return true;
    const messages = await ctx.session.context({ sessionID: entry.destinationID });
    return messages.some(({ type, metadata }) => type === "user" && metadata?.source === "goal" &&
      metadata.apanaGoalHandoff === entry.id && typeof metadata.goalID === "string");
  }

  // Force the native goal's kickoff through durable prompt admission so its message can carry the transfer ID.
  // The marker is removed before OpenCode resolves attachments and is never part of the model input.
  async function markPrompt(event) {
    if (event.metadata?.source !== "goal" || typeof event.metadata.goalID !== "string") return;
    const files = event.prompt.files;
    if (files?.length !== 1 || files[0].name !== MARKER_NAME) return;
    const session = await ctx.session.get({ sessionID: event.sessionID });
    const marker = session.metadata?.apana?.goalHandoff;
    if (!marker || files[0].uri !== markerURI(marker.id)) return;
    const entry = await storage.get(keyOf(marker.sourceID));
    if (entry?.phase !== "submitting" || !owns(session, entry)) throw new Error("no matching goal handoff submission");
    event.prompt.files = [];
    event.metadata = { ...event.metadata, apanaGoalHandoff: entry.id };
  }

  return {
    supported,
    read,
    pending,
    get: (sessionID) => durable ? storage.get(keyOf(sessionID)) : undefined,
    reserve: (sourceID, directory) => ({ sourceID, directory, id: randomUUID(), destinationID: `ses_${randomUUID()}` }),
    save,
    remove: (entry) => storage.remove(keyOf(entry.sourceID)),
    discard,
    admitted,
    markPrompt,
    async submit(entry, objective) {
      try {
        await ctx.session.command({
          sessionID: entry.destinationID,
          name: "goal",
          text: `"${objective}"`, // OpenCode strips one outer pair, preserving the stored objective inside it.
          files: [{ name: MARKER_NAME, mime: "text/plain", uri: markerURI(entry.id) }],
        });
      } catch {
        throw new Error("the native goal command did not confirm admission");
      }
      await save(entry, "accepted");
    },
  };
}
