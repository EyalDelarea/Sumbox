/**
 * attribution.ts — work out which message @Aida's answer came from, AFTER she
 * has written it.
 *
 * ── Why a second pass, and not [msg:N] in the answering prompt ───────────────
 *
 * The obvious design is generation-time citation: tag every message in the fence
 * and have her cite as she answers. It was built and measured on the golden set:
 *
 *     main (no ids, no rule)          false_denial_generation  0.13
 *     ids in fence + cite rule                                 0.38
 *     ids in fence, NO cite rule                               0.38
 *     ids at END of each line                                  0.38
 *
 * That looks damning, and it is NOT. Three further runs of main — same code,
 * same items — scored 0.50 / 0.25 / 0.13. At 8 items the harness cannot resolve
 * a 0.25 difference, so those numbers say nothing about the ids either way.
 * (This is the handoff's own warning: the noise floor is ±0.14 and power comes
 * from more ITEMS, not more reruns.)
 *
 * The conclusion runs the other direction instead: the harness cannot show the
 * ids are SAFE either, and the recency window (PR #49) exists precisely to keep
 * false denials down. A change we cannot measure, on the exact axis we care most
 * about, is not one to make on faith.
 *
 * So the answering prompt stays byte-identical to the one that has been measured
 * for months, and attribution happens here — after the answer exists, unable to
 * influence a word of it. Not "measured safe": incapable of the failure. That is
 * worth ~2.5s (measured) per answered reply, and nothing on a refusal.
 *
 * This is the literature's "P-Cite" (post-hoc) rather than "G-Cite"
 * (generation-time); a head-to-head evaluation (arXiv 2509.21557) measures
 * P-Cite at higher answer correctness (78% vs 69%) and recommends it by default,
 * reserving G-Cite for strict claim verification.
 *
 * ── The honest caveat ────────────────────────────────────────────────────────
 *
 * Post-hoc attribution can rationalise: this pass reports the message that best
 * SUPPORTS her answer, which is not provably the one she actually attended to.
 * For pinning a reply to its source that is the right question anyway — the
 * reader wants "where is this in the chat", not a token-attention trace — but it
 * is a weaker claim than a true citation, and worth remembering before this
 * number is used as evidence of grounding.
 */

import { type LanguageModel, generateText as sdkGenerateText } from "ai";
import { matchAskTrigger } from "../collector/ask-trigger.js";
import type { RetrievedMessage } from "../db/repositories/message-embeddings.js";
import { resolveSenderName } from "../summarization/sender-name.js";
import { parseCitedIds } from "./citations.js";
import { citeTag, NOT_IN_CHAT, NOT_INDEXED, neutralizeFence, OFF_TOPIC } from "./prompt.js";

type GenerateFn = (opts: Parameters<typeof sdkGenerateText>[0]) => Promise<{ text: string }>;

export type AttributionDeps = {
  model: LanguageModel;
  /** Injectable for tests; defaults to the AI SDK. */
  generate?: GenerateFn;
};

/**
 * A matching task, deliberately narrow: it is given the messages and an answer,
 * and returns ids. It never judges, never answers, and cannot refuse on the
 * asker's behalf — so the failure modes of the answer path do not exist here.
 */
const ATTRIBUTE_SYSTEM = [
  "You match an answer back to the exact chat message it came from.",
  "You are given numbered messages and an answer someone wrote about them.",
  "Reply with ONLY the id(s) of the message(s) the answer is based on, like [msg:123].",
  "Cite the single best message when one message carries the answer.",
  // Measured live: the answer restates the question's words, so the question
  // "matches" textually and got cited alongside the real source — which turned
  // a one-source answer into a no-pin multi-cite. Tagged questions are filtered
  // out before the model ever sees them; this line covers untagged ones.
  "The question itself is NEVER a source — cite the message that ANSWERS it, not a message that asks it.",
  "If the answer draws on several messages, give each. If none match, reply NONE.",
  "Output ids only. No words, no explanation.",
].join("\n");

/** The exact strings the answer prompt uses to decline. */
const REFUSALS = [NOT_IN_CHAT, NOT_INDEXED, OFF_TOPIC];

/** Cap the answer we quote back — an id-matching task needs the claim, not an essay. */
const MAX_ANSWER_CHARS = 400;
/** Cap each candidate line; long messages would crowd out the rest of the list. */
const MAX_LINE_CHARS = 120;

/**
 * The ids `answer` rests on, drawn from `candidates`.
 *
 * Returns [] — never throws — whenever attribution can't be had: a refusal (no
 * source exists to point at), no candidates, an empty answer, an unparseable
 * reply, or a model error. Losing the pin costs the source link; it must never
 * cost the answer, which by this point has already been written.
 */
export async function attributeSources(
  deps: AttributionDeps,
  input: { question: string; answer: string; candidates: RetrievedMessage[] },
): Promise<number[]> {
  const answer = input.answer.trim();
  if (answer.length === 0 || input.candidates.length === 0) return [];

  // A refusal has no source by definition, and asking anyway would invite the
  // matcher to invent support for "I didn't find it". Skipping also saves the
  // whole round-trip on exactly the replies that need it least.
  if (REFUSALS.some((r) => answer.includes(r))) return [];

  // Two kinds of candidate can never be a source, filtered deterministically —
  // not left to the prompt:
  //  - a question addressed to her (every tagged trigger, including the very
  //    question being answered — it sits in the recency window by the time she
  //    replies). Untagged reply-thread questions are the prompt's job.
  //  - her OWN past replies. An echo of someone's words matches the new answer
  //    at least as well as the original (measured live: asked twice, the second
  //    answer cited the first), and pinning an echo credits the words to the
  //    owner's account. Primary sources only.
  const candidates = input.candidates.filter(
    (m) => m.isAida !== true && matchAskTrigger(m.content) === null,
  );
  if (candidates.length === 0) return [];

  const valid = new Set(candidates.map((m) => m.messageId));
  const lines = candidates.map(
    (m) =>
      `${citeTag(m.messageId)} ${neutralizeFence(resolveSenderName(m.sender))}: ${neutralizeFence(
        m.content,
      ).slice(0, MAX_LINE_CHARS)}`,
  );

  const generate = deps.generate ?? (sdkGenerateText as unknown as GenerateFn);
  try {
    const { text } = await generate({
      model: deps.model,
      system: ATTRIBUTE_SYSTEM,
      temperature: 0,
      prompt: [
        "Messages:",
        lines.join("\n"),
        "",
        // The question is untrusted chat text; it is context for the match only.
        `Question asked: ${neutralizeFence(input.question)}`,
        `Answer given: ${answer.slice(0, MAX_ANSWER_CHARS)}`,
        "",
        "Which message id(s) is that answer based on?",
      ].join("\n"),
    } as Parameters<typeof sdkGenerateText>[0]);
    return parseCitedIds(text ?? "", valid);
  } catch {
    return [];
  }
}
