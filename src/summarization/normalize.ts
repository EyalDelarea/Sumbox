import { parseStructuredSummary } from "./parse-structured.js";
import type { SummaryBullet, SummaryOutput } from "./summarizer.js";

/**
 * A summary in the consistent shape the API + front-end render from, regardless
 * of whether the stored row is structured (S3+) or legacy prose. `version` tells
 * the UI whether bullets may carry tappable `sourceMessageId`s (2) or never (1).
 */
export type NormalizedSummary = {
  version: 1 | 2;
  /** Full markdown — backs "העתק סיכום" and the legacy render fallback. */
  overview: string;
  /** TL;DR (## תקציר) — the new §3 card's summary section. */
  tldr: string;
  topics: SummaryBullet[];
  decisions: SummaryBullet[];
  openQuestions: SummaryBullet[];
  actionItems: SummaryBullet[];
};

/**
 * Normalize a stored {@link SummaryOutput} for rendering. Structured rows pass
 * through; legacy prose rows are sectioned best-effort (no source links) so old
 * history still renders with headings. `overview` is always the full markdown.
 * Never throws.
 */
export function normalizeSummaryOutput(output: SummaryOutput): NormalizedSummary {
  if ("version" in output && output.version === 2) {
    return {
      version: 2,
      overview: output.overview,
      tldr: output.tldr,
      topics: output.topics,
      decisions: output.decisions,
      openQuestions: output.openQuestions,
      actionItems: output.actionItems,
    };
  }

  // Legacy prose: reuse the structured parser with an empty index map, so the
  // four ## sections are split but no bullet can resolve a source message.
  const prose = output.overview ?? "";
  const parsed = parseStructuredSummary(prose, new Map());
  return {
    version: 1,
    overview: prose,
    tldr: parsed.tldr,
    topics: parsed.topics,
    decisions: parsed.decisions,
    openQuestions: parsed.openQuestions,
    actionItems: parsed.actionItems,
  };
}

/**
 * Collapse a stored summary's raw text into a single clean line for list
 * previews — the Updates cards. Pass the TL;DR (תקציר) when present, or the
 * overview markdown for rows that predate the TL;DR field; this skips heading
 * lines, strips a leading list/quote marker and bold/italic emphasis, collapses
 * whitespace, and truncates to `max` chars on a word boundary with an ellipsis.
 * Returns "" when nothing usable remains, so callers can fall back to a CTA.
 */
export function summaryPreviewLine(raw: string | null | undefined, max = 140): string {
  if (!raw) return "";
  const line =
    raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^#{1,6}(\s|$)/.test(l)) ?? "";
  const cleaned = line
    .replace(/^[-*+>]\s+/, "") // leading list bullet / blockquote marker
    .replace(/(\*\*|__|[*_])(.+?)\1/g, "$2") // bold/italic emphasis
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  const slice = cleaned.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const head = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}
