// Scores a headless transcript (one JSON event per line, as written by `claude -p --output-format stream-json`).
// Event shapes used: assistant messages with content blocks {type:"tool_use", id, name, input}, user messages with
// {type:"tool_result", tool_use_id, is_error?} blocks, and a final {type:"result", subtype}. The Skill and Read
// shapes were checked against real Claude Code transcripts (input.skill / input.file_path); the `result` event and
// its subtypes are NOT yet confirmed on this CLI version (INFERENCE) until the first smoke run shows them.
// Loading, application and correctness are separate observations. The Scope/Method/Result record proves
// application only, never loading: the directive text itself tells the agent to write that record.
import { EARLIER_DIRECTIVES, LOGIC_DIRECTIVE } from "../../check.mjs";

// The current directive and the earlier ones: runs made under an older plugin version are scored with the text they were given.
const DIRECTIVES = [LOGIC_DIRECTIVE, ...EARLIER_DIRECTIVES];
const SKILL_NAMES = new Set(["logic-test-debug", "apana:logic-test-debug"]);
const SKILL_FILE = /(^|\/)skills\/logic-test-debug\/SKILL\.md$/;

export function parseTranscript(input) {
  const text = Array.isArray(input) ? input.join("\n") : String(input);
  const rawLines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const events = [];
  let broken = false;
  rawLines.forEach((line, index) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      if (index === rawLines.length - 1) broken = true;
      else events.push({ type: "unparsed" });
    }
  });
  return { events, broken, raw: text };
}

const blocks = (event) => (Array.isArray(event?.message?.content) ? event.message.content : []);

export function scoreTranscript(input, { limitExit = false } = {}) {
  const { events, broken, raw } = parseTranscript(input);
  const uses = [];
  const results = new Map();
  const texts = [];
  let resultEvent = null;
  let bashRuns = 0;
  for (const event of events) {
    if (event?.type === "result") resultEvent = event;
    for (const block of blocks(event)) {
      if (block?.type === "tool_use") {
        uses.push(block);
        if (block.name === "Bash") bashRuns += 1;
      } else if (block?.type === "tool_result") results.set(block.tool_use_id, block);
      else if (block?.type === "text" && event.type === "assistant" && typeof block.text === "string") texts.push(block.text);
    }
  }

  const attempts = uses.filter(
    (use) => (use.name === "Skill" && SKILL_NAMES.has(String(use.input?.skill ?? ""))) || (use.name === "Read" && SKILL_FILE.test(String(use.input?.file_path ?? ""))),
  );
  const succeeded = attempts.filter((use) => results.has(use.id) && results.get(use.id).is_error !== true);
  const complete = resultEvent !== null && !broken;
  const limit = limitExit || /max_turns|timeout|time_limit/i.test(String(resultEvent?.subtype ?? ""));
  const loaded = succeeded.length > 0 ? "loaded" : complete && !limit ? "not_loaded" : "unknown";

  const finalText = typeof resultEvent?.result === "string" ? resultEvent.result : (texts.at(-1) ?? "");
  const all = [...texts, finalText].join("\n");
  // Markdown emphasis around the label ("**Scope:**", "**Scope**:") still counts: the live sessions wrote the record both ways.
  const field = (name) => all.match(new RegExp(`^\\s*[*_]{0,2}${name}[*_]{0,2}:[*_]{0,2}\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
  const record = { scope: field("Scope"), method: field("Method"), result: field("Result") };
  const resultText = record.result ?? "";
  // Heuristic (guessed): a Result line that claims a check succeeded, without any command having been run. A statement that
  // nothing was run ("no tests or code run", "read the file only") is not a claim.
  const claimsChecks = /\b(?:tests?|checks?)\s+(?:all\s+)?pass(?:ed|es)?\b|\ball\s+(?:tests?\s+)?pass(?:ed)?\b|\bverified\b|\bexecuted\b|\bran\b|\bpass(?:ed|es)\b/i.test(resultText) &&
    !/\bno (?:tests?|code|commands?|checks?)\b|\bnot (?:run|executed|tested|verified)\b|\bnothing (?:was )?(?:run|executed)\b|dry-?run|by hand|traced|unverified|could not|unavailable|read the file only|\bno (?:\w+ )?run\b/i.test(resultText);

  return {
    loaded,
    loadAttempts: attempts.length,
    failedLoadAttempts: attempts.length - succeeded.length,
    complete,
    limitExit: limit,
    record: { ...record, present: Boolean(record.scope && record.method && record.result) },
    directiveSeen: DIRECTIVES.some((text) => raw.includes(text) || raw.includes(JSON.stringify(text).slice(1, -1))),
    // Delivered by a hook: the directive text inside a `system` event (hook lifecycle events need --include-hook-events).
    directiveDelivered: events.some((event) => event?.type === "system" && DIRECTIVES.some((text) => JSON.stringify(event).includes(JSON.stringify(text).slice(1, -1)))),
    commandsRun: bashRuns,
    unsupportedCheckClaim: claimsChecks && bashRuns === 0,
    finalText,
  };
}
