/**
 * suite-e.ts — end-to-end evaluation of @Aida's real answer path.
 *
 * Suite R proves whether the message was retrievable. This proves what she did
 * with it. The pairing is what makes a failure attributable rather than merely
 * visible — see the decomposition below.
 *
 * ── The headline metric is decomposed, not a score ───────────────────────────
 *
 *     refused ∧ gold ∉ retrieved  → RETRIEVAL bug   (she never saw it)
 *     refused ∧ gold ∈ retrieved  → GENERATION bug  (she saw it and denied)
 *
 * Measured 2026-07-16: gemma4 denies at 67–100% WITH the gold already in
 * context, so the second term is the live bug and the recency window alone will
 * not close it. That result is why this suite exists at all: the fix was not
 * predictable from reading the code.
 *
 * ── The D_absent pair is not optional ────────────────────────────────────────
 * `false_affirmation` over items whose answer genuinely is NOT in the chat is
 * the mirror of `false_denial`. Optimising denial down without it just teaches
 * her to hallucinate agreement — the two must move together or the number lies.
 *
 * ── No LLM judge ─────────────────────────────────────────────────────────────
 * Every evaluator here is a pure function over (answer, retrieved ids, gold
 * ids). Nothing calls a model. That is both a privacy requirement (Langfuse has
 * no allowlist for LLM connections, so a managed judge cannot be *guaranteed*
 * local) and independently the more reliable choice for Hebrew.
 */

import { ungroundedNumerals } from "../ask/groundedness.js";
import { detectRefusal } from "./denial.js";
import type { GoldenItem } from "./golden.js";

/**
 * What the task hands each evaluator. Resolution of gold external_ids → local
 * ids happens in the TASK, which has the pool, so evaluators stay pure and
 * unit-testable with no DB and no model.
 */
export type TaskOutput = {
  answer: string;
  /** Every message id surfaced across all search_chat calls, deduped. */
  retrievedIds: number[];
  /** Gold ids resolved for this item. Empty for D_absent. */
  goldIds: number[];
  /** How many times search_chat ran. Zero is a distinct, deterministic bug. */
  toolCalls: number;
  /**
   * The message ids she cited, already validated against what the fence showed
   * her.
   *
   * There is deliberately NO citation-validity metric: extractCitations drops an
   * unknown id before it ever reaches here, so any such score would read 1.00 by
   * construction and measure our own filter rather than her behaviour — the same
   * trap `searched_on_own_initiative` fell into when it counted the pre-seed as
   * a tool call. Validity is enforced structurally instead; what is worth
   * measuring is whether she cites at all, and whether the answer rests on one
   * source (which is what makes the reply pin to it).
   */
  citedIds: number[];
  /**
   * The exact system+user prompt of the final generation call — the grounding
   * corpus ungrounded_number checks against. Captured via AgenticDeps.onPrompt
   * so this can never drift from what she actually saw.
   */
  promptText: string;
};

/** Langfuse's evaluator return shape. */
export type Evaluation = { name: string; value: number; comment?: string };

export type EvalInput = { item: GoldenItem; output: TaskOutput };

const goldRetrieved = (o: TaskOutput): boolean =>
  o.goldIds.some((id) => o.retrievedIds.includes(id));

/**
 * The scary term: she had the evidence and denied anyway. 1 = bug.
 * Scoped to items with gold; a D_absent item cannot false-deny by definition.
 */
export function falseDenialGeneration({ item, output }: EvalInput): Evaluation {
  const refusal = detectRefusal(output.answer);
  const bug = item.goldExternalIds.length > 0 && refusal !== null && goldRetrieved(output);
  return {
    name: "false_denial_generation",
    value: bug ? 1 : 0,
    comment: bug
      ? `refused (${refusal?.kind}/${refusal?.degree}) with gold in context — generation bug`
      : "ok",
  };
}

/** She denied because retrieval never surfaced it. 1 = bug, but indicts retrieval. */
export function falseDenialRetrieval({ item, output }: EvalInput): Evaluation {
  const refusal = detectRefusal(output.answer);
  const bug = item.goldExternalIds.length > 0 && refusal !== null && !goldRetrieved(output);
  return {
    name: "false_denial_retrieval",
    value: bug ? 1 : 0,
    comment: bug ? "refused and gold was NOT retrieved — retrieval bug" : "ok",
  };
}

/**
 * The mirror. On a D_absent item, NOT refusing means she invented an answer.
 * 1 = bug. Without this, driving false_denial to 0 is trivially achievable by
 * making her agree with everything.
 */
export function falseAffirmation({ item, output }: EvalInput): Evaluation {
  const bug = item.goldExternalIds.length === 0 && detectRefusal(output.answer) === null;
  return {
    name: "false_affirmation",
    value: bug ? 1 : 0,
    comment: bug ? "answered a question whose subject is NOT in the chat" : "ok",
  };
}

/** Did retrieval surface the gold at all? Mirrors Suite R, through the real loop. */
export function retrievalHit({ item, output }: EvalInput): Evaluation {
  if (item.goldExternalIds.length === 0)
    return { name: "retrieval_hit", value: 1, comment: "n/a (D_absent)" };
  const hit = goldRetrieved(output);
  return {
    name: "retrieval_hit",
    value: hit ? 1 : 0,
    comment: hit ? "ok" : "gold not in retrieved set",
  };
}

/**
 * Did she CHOOSE to search, beyond the unconditional pre-seed?
 *
 * Renamed from `tool_called`, which was a lie: it counted the pre-seed we inject
 * ourselves, so it read 1.00 by construction and reported a fix that never
 * happened. Live traces show toolSpans=0 — she has never once called search_chat
 * since the window landed.
 *
 * This is now DIAGNOSTIC, not a gate. Since the pre-seed hands her the results
 * anyway, not searching costs no correctness — it only tells us the agentic loop
 * is not earning its autonomy, which is worth knowing before paying 3 steps for it.
 */
export function searchedOnOwnInitiative({ item, output }: EvalInput): Evaluation {
  const expected = item.expectedToolCalls ?? [];
  if (expected.length === 0)
    return { name: "searched_on_own_initiative", value: 1, comment: "n/a" };
  const ok = output.toolCalls > 0;
  return {
    name: "searched_on_own_initiative",
    value: ok ? 1 : 0,
    comment: ok
      ? `called search_chat ${output.toolCalls}× beyond the pre-seed`
      : "never called search_chat (the pre-seed carried it)",
  };
}

/**
 * Did she cite a source at all? DIAGNOSTIC — the spike measured 92% emission,
 * and a drop below that means the prompt has stopped landing.
 *
 * Scoped to items that expect an answer (D_absent = no gold): a correct refusal
 * has no source to cite, and extractCitations discards citations on one anyway,
 * so counting D_absent items here would penalise her for being right.
 */
export function citedASource({ item, output }: EvalInput): Evaluation {
  if (item.goldExternalIds.length === 0)
    return { name: "cited_a_source", value: 1, comment: "n/a (D_absent)" };
  const cited = output.citedIds.length > 0;
  return {
    name: "cited_a_source",
    value: cited ? 1 : 0,
    comment: cited ? `cited ${output.citedIds.length}` : "no citation (reply pins to the asker)",
  };
}

/**
 * Did the answer rest on exactly ONE source? DIAGNOSTIC — this is the share of
 * replies that actually quote-reply their source, so it measures the feature's
 * real reach rather than whether the code ran.
 *
 * Not a gate, and NOT to be optimised upward: a summary genuinely spanning
 * several messages SHOULD cite several and pin to none. Pushing this number up
 * would mean teaching her to under-cite, which is the opposite of the point.
 */
export function citedExactlyOne({ item, output }: EvalInput): Evaluation {
  if (item.goldExternalIds.length === 0)
    return { name: "cited_exactly_one", value: 1, comment: "n/a (D_absent)" };
  const one = output.citedIds.length === 1;
  return {
    name: "cited_exactly_one",
    value: one ? 1 : 0,
    comment: one ? "pins to its source" : `cited ${output.citedIds.length} — pins to the asker`,
  };
}

/**
 * Did she assert a numeral (score, time, price, year — ≥2 digits) that never
 * appeared anywhere in the prompt she was shown? A refusal asserts nothing, so
 * it is vacuously grounded. 1 = bug — the concrete-number fabrications that
 * survived every prompt fix (PR #53's absent-03 invented a sports score twice
 * at temp 0). See ask/groundedness.ts for why numerals and why ≥2 digits.
 */
export function ungroundedNumber({ output }: EvalInput): Evaluation {
  if (detectRefusal(output.answer) !== null)
    return { name: "ungrounded_number", value: 0, comment: "n/a (refusal)" };
  const novel = ungroundedNumerals(output.answer, output.promptText);
  return {
    name: "ungrounded_number",
    value: novel.length > 0 ? 1 : 0,
    comment: novel.length > 0 ? `asserts numerals never shown: ${novel.join(", ")}` : "ok",
  };
}

export const EVALUATORS = [
  falseDenialGeneration,
  falseDenialRetrieval,
  falseAffirmation,
  retrievalHit,
  searchedOnOwnInitiative,
  citedASource,
  citedExactlyOne,
  ungroundedNumber,
] as const;

/** Run every evaluator over one item's output. */
export function evaluateAll(input: EvalInput): Evaluation[] {
  return EVALUATORS.map((e) => e(input));
}

export type SuiteESummary = {
  n: number;
  /** Mean of each metric across items. false_denial_*, false_affirmation, and ungrounded_number are BUGS — lower is better. */
  metrics: Record<string, number>;
  perItem: { id: string; evaluations: Evaluation[] }[];
};

/** Aggregate. Reported per-metric; see the module docs for how to read them. */
export function summarize(perItem: { id: string; evaluations: Evaluation[] }[]): SuiteESummary {
  const metrics: Record<string, number> = {};
  const names = new Set(perItem.flatMap((p) => p.evaluations.map((e) => e.name)));
  for (const name of names) {
    const vals = perItem.flatMap((p) =>
      p.evaluations.filter((e) => e.name === name).map((e) => e.value),
    );
    metrics[name] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return { n: perItem.length, metrics, perItem };
}
