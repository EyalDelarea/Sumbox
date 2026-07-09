import type { SummaryOutput } from "./summarizer.js";

// U+200F RIGHT-TO-LEFT MARK: a strong RTL char at the start of each line forces
// the line's base direction to RTL, so terminals render Hebrew correctly
// (Latin names / numbers stay in place instead of scrambling).
const RLM = "‏";

/**
 * Render a summary for the CLI. The model returns a prose paragraph; we print
 * one sentence per line — long single-line Hebrew gets visually scrambled by
 * terminal bidi wrapping, so short, RTL-marked lines read correctly.
 */
export function renderSummary(out: SummaryOutput): string {
  return out.overview
    .replace(/([.!?])\s+/g, "$1\n")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => RLM + s)
    .join("\n");
}
