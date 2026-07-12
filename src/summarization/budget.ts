/**
 * How many tokens of `num_ctx` are held back for the model to WRITE the summary.
 *
 * `num_ctx` is a single budget shared by the prompt and the response. Before this
 * reservation existed, a 32,342-token prompt against a 32,768-token window left
 * the model 426 tokens — and it stopped with `done_reason: "length"`, mid-word,
 * with the later sections never written. `num_predict: 4096` was a dead letter:
 * context headroom, not the generation cap, is the binding constraint.
 *
 * 2048 comfortably fits a complete structured summary (a healthy one runs
 * ~600-900 output tokens; the most extensive tier lands near 1200).
 */
export const RESERVED_OUTPUT_TOKENS = 2048;

/**
 * How far the token estimator may under-count before the guard is unsafe.
 *
 * estimateTokens() is fitted per-script but still an approximation (worst
 * observed error ~13 % against real counts). The prompt that actually reaches
 * Ollama may therefore be larger than we predicted, so the ceiling is discounted
 * to keep the reservation intact even when the estimate is at its worst.
 */
const ESTIMATOR_SAFETY = 1.15;

/**
 * The largest prompt (in ESTIMATED tokens) a selection may occupy.
 *
 * Two independent limits, whichever is smaller:
 *
 *  1. **The hard ceiling** — what physically fits while still leaving the model
 *     room to answer: (numCtx − reserved) discounted by the estimator's error.
 *     Exceeding this does not "use more context", it truncates the summary.
 *
 *  2. **The configured budget** (`SUMMARY_TOKEN_BUDGET`) — a SPEED lever. Prompt
 *     evaluation dominates runtime (~89 % of a slow run; ~125 s for a 32k prompt),
 *     so the only way to make summaries fast is to make prompts smaller. A budget
 *     well under the ceiling trades coverage-per-run for latency; the watermark
 *     path simply drains the remainder across later runs.
 */
export function effectiveTokenBudget(opts: { numCtx: number; configured: number }): number {
  const ceiling = Math.floor((opts.numCtx - RESERVED_OUTPUT_TOKENS) / ESTIMATOR_SAFETY);
  // A pathologically small num_ctx must never yield a zero/negative budget: that
  // would make every selection "too large" and strand every group forever.
  const safeCeiling = Math.max(1, ceiling);
  return Math.max(1, Math.min(opts.configured, safeCeiling));
}
