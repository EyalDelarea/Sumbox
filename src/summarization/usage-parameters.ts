import type { GenUsage } from "./summarizer.js";

/** What one generation cost, ready to be folded onto a summary row. */
export type GenTelemetry = {
  /** Wall-clock time of the whole summarize call. */
  genMs: number;
  /** What Ollama actually counted. Absent when the engine reported nothing. */
  usage?: GenUsage;
  /** What estimateTokens() PREDICTED the prompt would cost. */
  estimatedTokens?: number;
};

/**
 * Fold generation telemetry into a summary row's `parameters` jsonb.
 *
 * Kept in the existing jsonb — no migration. The pairing that matters is
 * `estimatedTokens` (the chars/4 guess the token budget is enforced against)
 * next to `promptTokens` (what the prompt really cost). On Hebrew these differ
 * by ~2.17x, which is why the budget guard never trips and summaries silently
 * run out of context; persisting both lets the budget be re-derived from the
 * real distribution instead of a single hand-measured chat.
 *
 * `truncated` is the standing alarm: it means that summary was cut off mid-sentence.
 */
export function withGenUsage(
  parameters: Record<string, unknown>,
  telemetry: GenTelemetry,
): Record<string, unknown> {
  const { genMs, usage, estimatedTokens } = telemetry;
  return {
    ...parameters,
    genMs,
    ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
    ...(usage === undefined
      ? {}
      : {
          promptTokens: usage.promptTokens,
          evalTokens: usage.evalTokens,
          promptMs: usage.promptMs,
          evalMs: usage.evalMs,
          doneReason: usage.doneReason,
          truncated: usage.truncated,
        }),
  };
}
