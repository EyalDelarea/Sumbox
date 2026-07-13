import type pg from "pg";
import { findGroupByName } from "../db/repositories/groups.js";
import { buildPrompt, estimateTokens } from "./prompt.js";
import { type SelectedMessageWithCursor, type Selection, selectMessages } from "./select.js";
import type { SummaryPrompt } from "./summarizer.js";

export type PreparedSummary =
  | { kind: "empty" }
  | {
      kind: "ready";
      groupId: number;
      prompt: SummaryPrompt;
      /** line-index → messages.id, for resolving the model's `^N` source markers. */
      indexMap: Map<number, number>;
      summaryType: "last_n" | "since";
      parameters: Record<string, unknown>;
      messageCount: number;
      /** The estimate the token budget was ENFORCED against — recorded as telemetry
       *  so the guard and the measurement can never silently diverge. */
      estimatedTokens: number;
      /** Messages dropped because the selection did not fit the budget (0 = full coverage). */
      droppedCount: number;
      /**
       * sent_at of the OLDEST message actually summarized — not the requested
       * window start. When a wide selection is trimmed to fit the budget, the two
       * differ, and only this one is true of the summary we are about to produce.
       */
      coveredFrom: Date;
    };

/**
 * How many of the NEWEST messages fit in `tokenBudget`. Binary search over the
 * tail: a summary of a too-wide window should cover the most recent messages,
 * not the oldest ones. Always keeps at least one message — a single message that
 * still overflows is better summarized than refused.
 */
function fitNewestToBudget(all: SelectedMessageWithCursor[], tokenBudget: number): number {
  const fits = (n: number) => {
    const p = buildPrompt(all.slice(all.length - n));
    return estimateTokens(p.system + p.user) <= tokenBudget;
  };
  if (fits(all.length)) return all.length;

  let lo = 1;
  let hi = all.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Shared first half of summarization (used by the CLI and the web server):
 * resolve the group, select messages, trim to the token budget, build the prompt.
 * Throws only on an unknown chat — an over-wide selection is trimmed, not rejected.
 */
export async function prepareSummary(
  client: pg.Pool | pg.PoolClient,
  groupName: string,
  selection: Selection,
  tokenBudget: number,
): Promise<PreparedSummary> {
  const group = await findGroupByName(client, groupName);
  if (!group) {
    throw new Error(`Unknown chat "${groupName}". Run 'groups' to list.`);
  }
  return prepareSummaryForGroup(client, group.id, selection, tokenBudget);
}

/**
 * Same as {@link prepareSummary} but keyed on a caller-verified `groupId` — no
 * name re-resolution. Callers that already resolved the group (e.g. by JID on a
 * tenant-scoped pool) MUST use this: resolving by name would cross groups on a
 * name collision (and cross tenants on the RLS-bypassing pool).
 */
export async function prepareSummaryForGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  selection: Selection,
  tokenBudget: number,
): Promise<PreparedSummary> {
  const all = await selectMessages(client, groupId, selection);
  if (all.length === 0) return { kind: "empty" };

  // Trim to the NEWEST messages that fit, rather than rejecting the request.
  //
  // This used to throw "Selection too large". With the token estimate corrected
  // (Hebrew costs ~2x what chars/4 claimed), that guard would now fire on
  // perfectly ordinary requests like a 3-day /סיכום — turning summaries that
  // previously "worked" (badly: truncated mid-sentence) into hard errors.
  // Instead, summarize the most recent slice that fits and record what was
  // dropped, so the caller can say so. Mirrors prepareSumbox, whose own comment
  // notes that throwing here "would strand the group forever".
  const kept = fitNewestToBudget(all, tokenBudget);
  const messages = all.slice(all.length - kept);
  const dropped = all.length - kept;

  const prompt = buildPrompt(messages);
  const tokens = estimateTokens(prompt.system + prompt.user);

  const summaryType = "last" in selection ? "last_n" : "since";
  const parameters: Record<string, unknown> = {
    ...("last" in selection
      ? { n: selection.last }
      : { since: selection.since.toISOString().slice(0, 10) }),
    // Only present when the request could not be honoured in full — the caller's
    // signal that this summary covers less than was asked for.
    ...(dropped > 0 ? { trimmed: true, droppedCount: dropped } : {}),
  };

  return {
    kind: "ready",
    groupId,
    prompt,
    indexMap: prompt.indexMap,
    summaryType,
    parameters,
    messageCount: messages.length,
    estimatedTokens: tokens,
    droppedCount: dropped,
    coveredFrom: messages[0]!.sentAt,
  };
}
