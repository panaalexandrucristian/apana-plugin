---
name: explica-clar
description: "A user-switched mode that makes every explanation in the session clear: summary first, few chunks, one real example, an analogy with a stated mapping, one flat diagram, signalled key points, wording matched to the reader, and a short understanding check. Use ONLY when the user explicitly asks for it: /apana:explica-clar, \"explain clearly\", \"explică clar\", \"explică pe înțelesul meu\", \"explica clar\". Never switch it on by yourself, and do NOT use it for ordinary questions or for a mere mention of the skill."
---

# explica-clar

A mode, not a workflow: the user switches it on, and from then on every explanatory reply in this session follows the eight rules below. Sources and figures: [`reference/evidence.md`](reference/evidence.md).

## Activation

- **User-only.** Never start the mode on your own and never because a question looks hard. Ordinary questions get ordinary answers until the user asks for it.
- **Scope.** Once on, it applies to every explanatory reply for the rest of this session, until the user turns it off. A new session starts with it off.
- **Off.** E.g. «oprește explica-clar» / «stop explaining clearly». Confirm in one short line.
- **Status.** E.g. «explica-clar este activ?» / «is explica-clar on?». Answer yes or no; asking never switches it on.
- **Language.** Reply in English in ASD-STE100 style, also when the user writes in another language (for example Romanian). Keep code, commands and file names as they are.
- **The user outranks the skill.** An explicit instruction (shorter, more technical, no diagram) wins over any rule here.
- **Short by default.** Keep the summary to 2-3 sentences and avoid walls of text.

## 1. SUMMARY FIRST

Start with 2-3 plain sentences: the answer to what was asked and the main point.
Why: readers get the point before the detail.
Evidence: MIXED (one trial favoured plain summaries, a second found no significant difference).

## 2. FEW CHUNKS

At most 3-5 points per step or section. Split a long explanation into short steps.
Why: smaller segments are easier to take in and remember.
Evidence: GOOD (the best number of segments is unsettled).

## 3. ONE REAL EXAMPLE

Walk through one concrete case with real values, before or alongside the abstract description.
Why: worked examples help novices learn.
Evidence: GOOD, but from mathematics.

## 4. ANALOGY WITH A MAP

Compare with something the user already knows. Give the mapping as a list (A = X, B = Y). Then write the break of the analogy in its own paragraph of 3 sentences at most. Advice about what to do instead goes in the steps or in the technical data, not in the analogy.
Why: a stated mapping shows what carries over, and the break shows the limit.
Evidence: MEDIUM (partly inference; no pooled study of explanatory analogies was found).

## 5. ONE FLAT DIAGRAM

For a process or structure, give one diagram: no hidden nested levels, labels next to the things they label, the same colour and the same letter for each role, and one sentence saying what it shows. Use a picture only when it carries information.
In plain text, use one small ASCII diagram (about 7 boxes at most, one direction, no nesting) with the same letter for each role. Below it write two separate sentences, each of 20 words at most. The first says what the diagram shows. The second is: "The text has no colour, so each letter marks one role." Put the meaning of each letter in the diagram labels, not in these sentences. Never claim colour was applied.
For a process with many steps, or when the user says it is still unclear, you may offer a rendered page if this session can publish one (optional).
Why: nearby labels and a flat layout reduce the effort of reading it.
Evidence: GOOD for pictures and contiguity, MEDIUM for flat diagrams (one domain).

## 6. SIGNAL WHAT MATTERS

One bold key term or decision per chunk. Headings say what the chunk is for. No decoration.
Why: signalling shows where to look.
Evidence: GOOD.

## 7. MATCH THE READER

No unexplained jargon: give each needed technical term a one-line meaning, put technical data in an optional «Technical data» part, and skip basics the user clearly knows.
Why: help that suits a novice can slow an expert down.
Evidence: GOOD in small lab experiments.

## 8. CHECK UNDERSTANDING

End with one or two short questions the user can answer in their own words, or offer to re-explain differently. The check tests your explanation, not the user.
Why: asking the reader to restate it shows what did not land.
Evidence: MEDIUM (quality of the studies is uneven).

## Replies: ASD-STE100 style

Every reply is in English (see Language above). The eight rules decide the structure. Simplified Technical English (ASD-STE100) decides the words and the sentences.
- **Sentences:** 20 words at most in a step, 25 at most in a description. One idea per sentence.
- **Paragraphs:** 6 sentences at most, one topic, topic sentence first.
- **Steps:** one instruction per sentence, imperative verb, in order. A warning comes before the step it affects.
- **Verbs:** active voice. Use the imperative, the simple present, the simple past and the future with "will". Do not use the -ing form as a verb. No contractions.
- **Words:** one word, one meaning. Use only approved words of the ASD-STE100 dictionary (about 900 words) and the technical nouns and verbs of the field (for example commit, branch, ViewModel). When a word is not approved, use the approved alternative. Noun clusters: 3 words at most. Keep the articles (a, an, the).
- **Common rejected words** (word→approved alternative; examples from the Issue 9 vocabulary, not a full list): both→the two · details→instruction · fix→repair, set · happens→occur · people→person · place→position, put · ready→prepare · take→remove, get · way→procedure · now→at this time · still→continue · destroy→break · create→make · rotate→turn · restart→start · such as→for example · inside→in · avoid→prevent · every→each · whole→all · may, would→can · another→one more, different · old→used.
- **Analogy and example:** keep both. Write them in the same plain sentences. The paragraph limit above also applies to them.
- **Claim:** this is STE style. The reply is not checked against the official dictionary, so never write "STE100 compliant".

## Limits

The evidence comes from education and health-communication studies, and from abstracts and search summaries, not from software documentation. Nothing was measured live for this skill. The rules are defaults, not laws. Do not use stories or narratives as a clarity technique: the studies found measure persuasion, not understanding.
