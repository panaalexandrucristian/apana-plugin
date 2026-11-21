import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL = join(ROOT, "skills", "review-plan", "SKILL.md");
const source = () => readFileSync(SKILL, "utf8");
// The text from a heading to the next heading of the same or a higher level.
const section = (heading) => {
  const text = source();
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, heading);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return end < 0 ? rest : rest.slice(0, end);
};

describe("review-plan skill", () => {
  it("exists and has the right frontmatter", () => {
    assert.ok(existsSync(SKILL));
    const match = source().match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, "frontmatter");
    assert.match(match[1], /^name: review-plan$/m);
    assert.match(match[1], /^argument-hint: \[plan-file\]$/m);
    assert.match(match[1], /^allowed-tools: Bash\(git log \*\) Bash\(git show \*\)$/m);
    assert.match(match[1], /description: "Review a plan before implementation, using a fresh reviewer subagent without the planning conversation:/);
    assert.match(match[1], /have four subagents run first/);
    assert.match(match[1], /one finds the most recently introduced comparable implementations using git log/);
    assert.match(match[1], /one maps the application's layers/);
  });

  it("asks what plan to review when it gets no argument, and reviews nothing before the answer", () => {
    const text = source();
    assert.match(text, /If `\$ARGUMENTS` is empty, review nothing yet/);
    assert.match(text, /"What plan should I review\?"/);
    for (const choice of ["the plan of this session", "a file (its path)", "something else"]) {
      assert.ok(text.includes(choice), choice);
    }
    assert.match(text, /then stop and wait for the next prompt/);
  });

  it("leaves the step and result lists to the reviewer and hands over a chat-only requirement verbatim", () => {
    const intake = section("## What to review");
    assert.match(intake, /Do not derive the numbered steps or the result list in the main agent/);
    assert.match(intake, /quote only the owner's request and their decisions verbatim, marking each decision as an owner decision/);
    assert.match(intake, /Do not paraphrase, supply planning rationale, include rejected options, or ask for routine confirmation/);
  });

  it("requires readable Git history, run as plain read-only git log commands, before Part A", () => {
    const git = section("## Git history required");
    assert.match(git, /^\nAfter the main agent identifies the plan and application checkout, use the shell/);
    assert.match(git, /one plain command that starts with `git log`/);
    assert.match(git, /with no `\$VAR`, `;`, `&&` or pipe/);
    assert.match(git, /Run `git log -1 --format='%H %cI' HEAD` before starting the helpers/);
    assert.match(git, /report the blocker, ask for access or a checkout with history, and stop before Part A without editing the plan/);
    assert.match(git, /Do not substitute file order or modification times for Git history/);
    assert.ok(source().indexOf("## Git history required") < source().indexOf("## Agents before the review"));
  });

  it("starts the helpers before Part A, each read-only and reporting as text, and reuses their reports", () => {
    const text = source();
    const agents = section("## Agents before the review");
    for (const role of ["**Standards agent.**", "**Practices agent.**", "**Precedents agent.**", "**Architecture/Layers agent.**"]) {
      assert.ok(agents.includes(role), role);
    }
    assert.match(agents, /starts each helper listed under Agents before the review in one message, in parallel/);
    assert.match(agents, /Wait for every helper report before starting the reviewer/);
    assert.match(agents, /Reuse those reports without restarting the helpers on later passes/);
    assert.match(agents, /Do not give any helper the planning conversation, a main-agent step list, proposed verdicts/);
    assert.match(agents, /Tell each not to edit any file or start another subagent; the skill cannot enforce this/);
    assert.match(agents, /If delegation is unavailable, use the inline fallback under Each pass/);
    assert.ok(text.indexOf("## Agents before the review") < text.indexOf("### Part A"));
    for (const file of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING*", ".editorconfig"]) assert.ok(text.includes(`\`${file}\``), file);
    assert.match(text, /text in its final message, not a file/);
    assert.match(text, /If it finds none, it says so and lists what it looked for/);
  });

  it("dates a precedent by the commit that adds the implementation, across modules, with the limits of history", () => {
    const agents = section("## Agents before the review");
    assert.match(agents, /3\. \*\*Precedents agent\.\*\* For each implementation decision in the plan,/);
    assert.match(agents, /including outside the target module/);
    assert.match(agents, /Search for abstractions the plan may have bypassed/);
    assert.match(agents, /git log --no-ext-diff --no-textconv --format='%H %ct %cI' -L '<first>,<last>:<path>' HEAD/);
    assert.match(agents, /Confirm that the patch adds the implementation, rather than merely editing it, adding its enclosing file earlier, or moving it/);
    assert.match(agents, /Do not use `-1` or select the oldest displayed commit without reading its patch/);
    assert.match(agents, /The most recently introduced comparable implementation is the precedent; one is enough/);
    assert.match(agents, /--follow -p/);
    assert.match(agents, /-G '<distinctive-declaration-regex>'/);
    assert.match(agents, /Squashed or shallow history cannot recover a hidden introduction order/);
    assert.match(agents, /report the evidence gap and ask before rewriting that decision/);
    assert.match(agents, /The helpers' output is context, not evidence/);
    assert.match(agents, /Confirm the selected precedent's comparability and introduction from `git log`/);
    assert.match(agents, /cite the introducing commit separately/);
  });

  it("gives the Architecture/Layers agent its own brief after the dating procedure", () => {
    const agents = section("## Agents before the review");
    assert.ok(agents.indexOf("**Dating a precedent.**") < agents.indexOf("**Architecture/Layers agent.**"));
    assert.ok(agents.indexOf("**Architecture/Layers agent.**") < agents.indexOf("The helpers' output is context, not evidence"));
    assert.match(agents, /from written architecture or dependency rules and from how the code actually works/);
    assert.match(agents, /Use the project's own names and boundaries, not a fixed layer list/);
    assert.match(agents, /the actual consumer and provider at each relevant boundary/);
    assert.match(agents, /Separate the written architecture from code that does not follow it/);
    assert.match(agents, /Do not decide alignment or fix the plan/);
  });

  it("starts a fresh non-fork reviewer per pass with a fixed brief and three return headings", () => {
    const text = source();
    const reviewer = section("### Start a fresh reviewer");
    assert.match(reviewer, /In Claude Code it must be a non-fork subagent: a fork inherits the whole conversation/);
    assert.match(reviewer, /Start the brief with `Independent review pass: review the current plan\.`/);
    assert.match(reviewer, /Give it the current plan verbatim and the plan path if there is one, the requirement text, the application checkout/);
    assert.match(reviewer, /the owner's answers and approvals so far quoted verbatim and marked as owner decisions, and each helper report verbatim/);
    assert.match(reviewer, /Do not send the parent conversation, its reasoning, rejected options, earlier reviewer reports/);
    assert.match(reviewer, /Tell the reviewer not to edit any file, run a build or tests, ask the owner, or start any subagent/);
    assert.match(reviewer, /The reviewer's first job is to list the plan's steps in order/);
    assert.match(reviewer, /Treat the helper reports as leads, not evidence\. For each verdict read the relevant `file:line` yourself/);
    for (const heading of ["`## Review report`", "`## Proposed plan edits`", "`## Questions for the owner`"]) assert.ok(reviewer.includes(heading), heading);
    assert.match(reviewer, /Relay only the reviewer's questions to the owner, without answering them yourself/);
    const pass = text.indexOf("## Each pass");
    const partA = text.indexOf("### Part A");
    for (const sub of ["### Who runs each pass", "### Start a fresh reviewer", "### Inline fallback"]) {
      const at = text.indexOf(sub);
      assert.ok(pass < at && at < partA, sub);
    }
  });

  it("retries a failed reviewer once, then runs inline without bypassing Git or permissions", () => {
    const fallback = section("### Inline fallback");
    assert.match(fallback, /run the entire review and each helper job in the main agent/);
    assert.match(fallback, /start one fresh reviewer once more for the same pass with the same inputs/);
    assert.match(fallback, /an explicit prerequisite blocker with its owner question is usable even without table rows/);
    assert.match(fallback, /Do not apply replacements from an unusable result/);
    assert.match(fallback, /Do not use the fallback to bypass the Git history requirement or any tool or file permission/);
  });

  it("maps proposals to layers from rules and code, in proportion, and asks once when no layers can be established", () => {
    const text = source();
    const map = section("### Map proposals to application layers");
    assert.ok(text.indexOf("### Inline fallback") < text.indexOf("### Map proposals to application layers"));
    assert.ok(text.indexOf("### Map proposals to application layers") < text.indexOf("### Part A"));
    assert.match(section("## Each pass"), /^\nOn each pass, map the proposals to the affected application layers before Part A/);
    assert.match(map, /the written architecture governs what is allowed; show the difference and use the actual code to assess what a change would affect/);
    assert.match(map, /Include any layer or mapper required by the governing written rule or verified comparable path even when the original proposal bypasses it/);
    assert.match(map, /Use the actual consumer or caller as the side above and the actual provider or dependency as the side below/);
    assert.match(map, /Stop following a branch at an unchanged contract/);
    assert.match(map, /For a one-layer plan in a layered application, check that layer and its relevant immediate boundaries only/);
    assert.ok(map.includes('ask the owner this once per review: "I could not establish distinct application layers from the project. Which layer boundaries should this review check, or should I treat the application as a single layer for this plan?"'));
    assert.match(map, /On the independent path, the reviewer returns this question and the main agent asks it/);
    assert.match(map, /Use the answer before giving a layer verdict, and keep it for later passes without asking again/);
    assert.match(map, /If the owner confirms a single layer, review that layer/);
    assert.match(map, /starts a fresh reviewer with the usual inputs and the answer quoted verbatim, scoped to the layer-dependent checks/);
    assert.match(map, /do not resume the previous child or resend its findings/);
    assert.match(map, /mark the layer check as blocked, and continue only checks and plan fixes that do not depend on the answer/);
    assert.match(map, /Do not invent layers, silently skip the blocked check, or report it as passed/);
  });

  it("asks six questions about every step and five checks about what the plan leaves out", () => {
    const text = source();
    for (const label of [
      "**Why** do we do this step?",
      "**Is it strictly necessary?**",
      "**Is it aligned with the project standard?**",
      "**Does it hold?**",
      "**Is it in the right place?**",
      "**Is it the most optimal solution?**",
      "**Coverage.**",
      "**Order and dependencies.**",
      "**Verification.**",
      "**Hard to undo.**",
      "**Unevidenced assumptions and open questions.**",
    ]) {
      assert.ok(text.includes(label), label);
    }
  });

  it("compares each implementation decision with the rule or newest precedent and catches an omitted abstraction", () => {
    const partA = section("### Part A: every step");
    assert.match(partA, /compare what the plan would do with the applicable written rule or, when there is none, the most recently introduced verified comparable implementation/);
    assert.match(partA, /Check whether the step bypasses or omits a model, helper or other abstraction used for the same job, even if the plan adds no class or file/);
    assert.match(partA, /If the step proposes no implementation decision, say "not applicable"/);
    const partB = section("### Part B: every new class or file");
    assert.match(partB, /Use the same evidence and precedence rules as in Part A for this class or file/);
  });

  it("checks each affected layer and both boundaries, and treats an established layer violation as not aligned", () => {
    const partA = section("### Part A: every step");
    for (const label of ["**What already exists here?**", "**Does the proposal follow it?**", "**What happens at the boundaries?**"]) {
      assert.ok(partA.includes(label), label);
    }
    assert.match(partA, /Distinguish an artifact that can be reused from a design to follow/);
    assert.match(partA, /compare an implementation of that responsibility within the same layer, even if it lives in another module/);
    assert.match(partA, /compare an equivalent handoff between corresponding provider and consumer layers/);
    assert.match(partA, /select the most recently introduced verified comparable implementation for the applicable comparison, using "Dating a precedent"/);
    assert.match(partA, /moving a responsibility across it, bypassing a required layer or mapper, or passing a type across it contrary to that standard is "not aligned"/);
    assert.match(partA, /A violation of an established layer boundary is an alignment finding, not a place question/);
    assert.match(partA, /do not change the proposed location without the owner's agreement/);
    const partB = section("### Part B: every new class or file");
    assert.match(partB, /identify each proposed class or file's owning layer/);
    assert.match(partB, /For a bridge, name both sides and check which one owns the translation/);
    assert.match(partB, /If no new class or file is proposed, Part A still checks whether the plan omits or bypasses one needed at a boundary/);
    const partC = section("### Part C: what the plan leaves out");
    assert.match(partC, /Reconcile each changed boundary across steps/);
    assert.match(partC, /Do not require changes on the other side of an unchanged contract/);
    assert.match(partC, /Reuse an existing criterion that demonstrates the result; do not require a test merely because a boundary was inspected/);
  });

  it("fixes only the plan: the reviewer proposes exact replacements, the main agent applies them verbatim", () => {
    const text = source();
    const fixes = section("## Where fixes go");
    assert.match(text, /Never edit code, never run a build or tests, never start carrying the plan out, never stage or commit/);
    assert.match(fixes, /edit no file: assemble the revised plan in memory from the exact replacements and print it in full at the end/);
    assert.match(fixes, /The reviewer proposes exact plan replacements; it does not edit any file\. Apply them verbatim in the main agent/);
    assert.match(fixes, /Report an edit as not applied if the old text does not match, is ambiguous, or write permission is unavailable/);
    assert.match(fixes, /Do not improvise a replacement or apply it to another file/);
    assert.match(text, /The plan is the only thing this skill edits, and only the main agent may edit it/);
  });

  it("treats a rule of the project's own files as a finding and a contradicting web practice as an observation", () => {
    const text = source();
    assert.match(text, /A rule in the project's own files that a step breaks is a finding/);
    assert.match(text, /A web practice that contradicts the project standard is an observation; it does not trigger a fix by itself/);
    assert.match(text, /If an applicable written standard and code disagree, the written standard wins/);
    assert.match(text, /If written standards are silent on the decision, use the most recently introduced comparable implementation as the standard even if standards files exist for other topics/);
  });

  it("reshapes an unsupported departure from a precedent and asks the owner to approve a repository-backed one", () => {
    const fix = section("### After a fix");
    assert.match(fix, /An unsupported departure from an applicable code precedent is "not aligned": reshape the affected plan text to match the precedent/);
    assert.match(fix, /If the plan gives a repository-backed reason to depart and no written rule forbids it, ask the owner to approve the departure before keeping it/);
    assert.match(fix, /mark the decision as blocked and do not rewrite or approve that decision while waiting/);
    assert.match(fix, /This exception does not override a written rule/);
    assert.match(fix, /Fix an established layer violation in the plan: put the work in the governing layer, restore the required intermediate layer or mapper/);
    assert.match(fix, /never move or edit application code during the review/);
    const place = section("## Place questions");
    assert.match(place, /Change that proposed location only if the owner agrees/);
    assert.match(place, /Do not put an established layer violation in this list: fix it as "not aligned"/);
  });

  it("stops after 3 passes and starts the report with the standards files found", () => {
    const text = source();
    assert.match(text, /after 3 passes/);
    assert.match(text, /Start with the standards files found \(path and what each governs\), or "none found"/);
  });

  it("counts review passes, and completes a deferred layer check once without adding a full pass", () => {
    const stop = section("## Stop");
    assert.match(stop, /The main agent counts review passes, not launch attempts/);
    assert.match(stop, /Preserve earlier reports for the user, not as inputs to a later reviewer/);
    assert.match(stop, /complete the pending layer check once with that answer even if the preceding pass changed nothing or was the last allowed full pass/);
    assert.match(stop, /This completes a deferred check, not another full pass/);
    assert.match(stop, /report it as incomplete; do not approve the plan on that basis/);
  });

  it("lists the results the requirement asks for and asks for a criterion for each, with four parts", () => {
    const text = source();
    assert.match(text, /list the results the requirement asks for, one line each/);
    assert.match(text, /Every result the requirement asks for also needs an acceptance criterion in the plan; this holds for refactors, documentation and skills as well/);
    for (const part of ["**scenario**", "**observable result**", "**acceptance condition**", "**check and evidence**"]) {
      assert.ok(text.includes(part), part);
    }
    assert.match(text, /Criterion — result \/ steps: in situation X we observe Y; passes if Z\. Check: method\. Evidence: artefact or output\./);
  });

  it("keeps good criteria, follows the requirement and forces neither numbers nor screenshots", () => {
    const text = source();
    assert.match(text, /follows the requirement, not the number of files/);
    assert.match(text, /a criterion that is already good stays as it is/);
    assert.match(text, /A yes\/no condition is measurable: do not force percentages or scores/);
    assert.match(text, /do not ask for screenshots when there is nothing to look at/);
    assert.match(text, /Cover the error cases and limits the requirement names, and no more/);
  });

  it("asks a comparative gain for baseline, conditions, sample and threshold, and never invents a value", () => {
    const text = source();
    assert.match(text, /name the baseline, the conditions, the sample and a justified threshold/);
    assert.match(text, /A measurement nobody has taken becomes a measuring step; a threshold that is a product decision becomes a question for the user/);
    assert.match(text, /Never invent a value/);
  });

  it("repairs a missing criterion in the plan and asks, not guesses, when a decision is missing", () => {
    const text = source();
    assert.match(text, /A result with no criterion, or a criterion that lacks a part, is a gap: add or repair the criterion in the plan/);
    assert.match(text, /\(a threshold, an expected behaviour\), stop and ask instead of guessing; the report lists that criterion as blocked/);
  });

  it("keeps a planned check apart from a check that was run, and does not approve a plan that is still blocked", () => {
    const text = source();
    assert.match(text, /Mark every criterion "planned, not run", never "passes" or "verified"/);
    assert.match(text, /this review does not run the plan's checks and does not show that the plan works/);
    assert.match(text, /Stopping is not approval: a plan whose essential criteria are still blocked by a decision is not approved, and the report says so/);
    assert.match(text, /An alignment decision blocked by missing history or pending owner approval remains open; stopping does not approve it/);
  });

  it("reports criteria added, corrected, kept and blocked without copying them, with tables for Parts A and B only", () => {
    const text = source();
    assert.match(text, /one table for Part A and one for Part B/);
    assert.match(text, /Part C is a short list, not a table: check, finding, action/);
    assert.match(text, /which criteria you added or corrected, which you kept and which are blocked by a decision, each with where it is in the plan/);
    assert.match(text, /the full criteria stay in the plan, so do not copy them into the report/);
    assert.match(text, /The class table has a `correct` column after `optimal` and no `holds` column/);
  });

  it("cites precedents inline, keeps earlier findings and shows a blocked departure, in the existing tables", () => {
    const report = section("## Report");
    assert.match(report, /when using a precedent, cite its introducing commit hash and date separately/);
    assert.match(report, /In the `action` cell, retain the original finding and fix from an earlier pass even if the revised step now aligns/);
    assert.match(report, /For a blocked departure, show the outstanding approval question and its evidence/);
    assert.match(report, /do not report unverified alignment as a pass/);
    assert.equal((report.match(/^\| --- /gm) ?? []).length, 1);
  });

  it("relays each pass report verbatim with its mechanical status, and marks a review that was not independent", () => {
    const report = section("## Report");
    assert.match(report, /The main agent preserves the exact report text from each completed pass, labelled by pass/);
    assert.match(report, /The main agent relays each report verbatim: do not summarise, soften, drop or silently override a finding/);
    assert.match(report, /Append only the mechanical status \(pass, replacements applied or not applied, and fallback if used\) and the reviewer's owner questions/);
    assert.match(report, /under `## Requirement given to the reviewer`/);
    assert.ok(report.includes("the first line of the user-facing report is `Not independently reviewed: <reason>. This review ran in the conversation that produced the plan.`"));
  });

  it("adds a layers / boundaries column to both tables, without the scenario of the layers eval", () => {
    const text = source();
    const report = section("## Report");
    assert.match(report, /^\| step \| layers \/ boundaries \| why \|/m);
    assert.match(report, /Both tables have a `layers \/ boundaries` column immediately after the step or class/);
    assert.match(report, /One affected layer needs one brief entry and its boundary result; use "not applicable" for a proposal that changes no application implementation or contract, or "blocked" for a layer decision awaiting the owner/);
    assert.doesNotMatch(text, /offer/i);
    assert.doesNotMatch(text, /campaign_label/);
  });
});
