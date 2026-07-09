import type pg from "pg";
import type { Cursor } from "../db/repositories/read-watermarks.js";
import { getSummaryForRegenerate } from "../db/repositories/summaries.js";
import { buildPrompt, estimateTokens, type SummaryAdjust } from "./prompt.js";
import { selectAfterCursor } from "./select.js";
import type { SummaryPrompt } from "./summarizer.js";

type StoredCursor = { sentAt: string; messageId: number };
type SumboxParams = {
  fromExclusive: StoredCursor | null;
  toInclusive: StoredCursor;
  messageCount: number;
  usedFallback: boolean;
};

export type PreparedRegenerate =
  | { kind: "not-found" }
  | { kind: "empty" }
  | {
      kind: "ready";
      groupId: number;
      prompt: SummaryPrompt & { indexMap: Map<number, number> };
      indexMap: Map<number, number>;
      summaryType: "watermark";
      /** Reused verbatim from the rated summary so the new row covers the same window. */
      parameters: SumboxParams;
      messageCount: number;
      regeneratedFromId: number;
    };

/**
 * Re-run a previously-rated catch-up summary over the SAME message range with a
 * reason-tuned prompt. The range is reconstructed from the rated summary's stored
 * `parameters` cursors — NOT from the live watermark (which has moved on). Performs
 * NO writes and does NOT touch the read-watermark; the caller inserts the new row.
 *
 * Note: the id range reconstructs exactly, but the prompt TEXT may differ from the
 * original if a transcript/analysis completed after the original generation
 * (selectAfterCursor substitutes completed media descriptions) — accepted.
 */
export async function prepareRegenerate(
  client: pg.Pool | pg.PoolClient,
  summaryId: number,
  adjust: SummaryAdjust,
  tokenBudget: number,
): Promise<PreparedRegenerate> {
  const row = await getSummaryForRegenerate(client, summaryId);
  if (!row) return { kind: "not-found" };
  const params = row.parameters as SumboxParams;

  const to: Cursor = {
    sentAt: new Date(params.toInclusive.sentAt),
    messageId: params.toInclusive.messageId,
  };
  // Lower bound: strictly after fromExclusive, or the first-run sentinel (matches
  // prepare-sumbox.ts first-run select).
  const from: Cursor = params.fromExclusive
    ? { sentAt: new Date(params.fromExclusive.sentAt), messageId: params.fromExclusive.messageId }
    : { sentAt: new Date(0), messageId: 0 };

  const all = await selectAfterCursor(client, row.groupId, from);
  // Upper bound is INCLUSIVE — selectAfterCursor has no upper bound, so filter here.
  let range = all.filter(
    (m) =>
      m.sentAt < to.sentAt ||
      (m.sentAt.getTime() === to.sentAt.getTime() && m.messageId <= to.messageId),
  );
  // First run took only the newest messageCount; reproduce that lower edge.
  if (params.fromExclusive === null) range = range.slice(-params.messageCount);

  if (range.length === 0) return { kind: "empty" };

  const prompt = buildPrompt(range, adjust);
  const tokens = estimateTokens(prompt.system + prompt.user);
  if (tokens > tokenBudget) {
    throw new Error(`Selection too large (~${tokens} tokens > budget ${tokenBudget}).`);
  }

  return {
    kind: "ready",
    groupId: row.groupId,
    prompt,
    indexMap: prompt.indexMap,
    summaryType: "watermark",
    parameters: params,
    messageCount: range.length,
    regeneratedFromId: summaryId,
  };
}
