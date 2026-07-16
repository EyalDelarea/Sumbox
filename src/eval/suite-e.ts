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
 * A denial with ZERO tool calls is a 100%-precision bug detection with no text
 * analysis at all — she refused without even looking.
 */
export function toolWasCalled({ item, output }: EvalInput): Evaluation {
  const expected = item.expectedToolCalls ?? [];
  if (expected.length === 0) return { name: "tool_called", value: 1, comment: "n/a" };
  const ok = output.toolCalls > 0;
  return {
    name: "tool_called",
    value: ok ? 1 : 0,
    comment: ok ? `search_chat ran ${output.toolCalls}×` : "REFUSED WITHOUT SEARCHING",
  };
}

export const EVALUATORS = [
  falseDenialGeneration,
  falseDenialRetrieval,
  falseAffirmation,
  retrievalHit,
  toolWasCalled,
] as const;

/** Run every evaluator over one item's output. */
export function evaluateAll(input: EvalInput): Evaluation[] {
  return EVALUATORS.map((e) => e(input));
}

export type SuiteESummary = {
  n: number;
  /** Mean of each metric across items. false_denial_* and false_affirmation are BUGS — lower is better. */
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
