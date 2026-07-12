import type pg from "pg";
import { findGroupByName } from "../db/repositories/groups.js";
import type { Cursor } from "../db/repositories/read-watermarks.js";
import { getWatermark } from "../db/repositories/read-watermarks.js";
import { getLatestSumboxSummary } from "../db/repositories/summaries.js";
import { buildPrompt, estimateTokens } from "./prompt.js";
import {
  firstPendingVisualMediaAfter,
  firstPendingVoiceNoteAfter,
  type SelectedMessageWithCursor,
  selectAfterCursor,
} from "./select.js";
import type { SummaryOutput, SummaryPrompt } from "./summarizer.js";

export type { Cursor };

/**
 * Never-freeze grace: how long an un-analyzed image/video or un-transcribed
 * voice note may hold the catch-up barrier before it stops blocking. Analysis
 * and transcription are enqueued *selectively* (see media-pipeline 020) and may
 * never run for a given item, so "no analysis/transcript row" cannot mean "wait
 * forever" — past this window the item drops out of the barrier and catch-up
 * proceeds, summarizing it without its description (same outcome as a failed
 * analysis). Otherwise a single such item right after the watermark freezes the
 * group on a false "nothing new" indefinitely.
 *
 * ponytail: wall-clock age is the only robust signal — in-flight job state lives
 * in RabbitMQ, not the DB (job_runs records only terminal runs). Tune higher to
 * give in-flight analysis more time to land; lower to surface new text sooner.
 */
export const MEDIA_BARRIER_GRACE_MS = 15 * 60 * 1_000; // 15 minutes

/** Marks a message body that was cut to fit the budget — visible to the model and the reader. */
const CLAMP_SUFFIX = " […הודעה ארוכה, נחתכה]";

/**
 * How many messages of `range` (oldest-first) fit in `tokenBudget`. Binary
 * search over the real prompt, so the fixed system-prompt overhead counts.
 * Always returns ≥1: one message is the smallest unit of forward progress, and
 * an oversized one is clamped by `clampToBudget` rather than refused.
 *
 * Correctness rests on `fits` being monotone in n — true only because
 * `buildPrompt`'s length directives grow with the message-count tier, so a
 * shorter range can never produce a longer system prompt. Keep LENGTH_DIRECTIVES
 * ordered shortest-first (prompt.ts) or this can return an over-budget n.
 */
function fitToBudget(range: SelectedMessageWithCursor[], tokenBudget: number): number {
  const fits = (n: number) => {
    const p = buildPrompt(range.slice(0, n));
    return estimateTokens(p.system + p.user) <= tokenBudget;
  };
  if (fits(range.length)) return range.length;
  let lo = 1;
  let hi = range.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Cut a single oversized message's body down to the budget. `content` is
 * unbounded — `selectAfterCursor` concatenates the text with any voice-note
 * transcript and image description — so one message really can exceed the whole
 * budget, and past `SUMMARY_NUM_CTX` the model would silently drop the tail
 * *after* the watermark advanced past it. Clamping here makes the loss explicit
 * (marked in the transcript) and bounded instead of silent and runtime-defined.
 *
 * ponytail: cuts the tail. A smarter head+tail or map-reduce split is the
 * upgrade if long transcripts turn out to bury their point at the end.
 */
function clampToBudget(
  m: SelectedMessageWithCursor,
  tokenBudget: number,
): SelectedMessageWithCursor {
  const empty = buildPrompt([{ ...m, content: "" }]);
  const overhead = estimateTokens(empty.system + empty.user);
  const budgetChars = Math.max(0, (tokenBudget - overhead) * 4 - CLAMP_SUFFIX.length);
  if (m.content.length <= budgetChars) return m;
  return { ...m, content: m.content.slice(0, budgetChars) + CLAMP_SUFFIX };
}

export type PreparedSumbox =
  | { kind: "cache-hit"; summaryId: number; summary: SummaryOutput; generatedAt: Date }
  | { kind: "empty" }
  | {
      kind: "ready";
      groupId: number;
      prompt: SummaryPrompt;
      /** line-index → messages.id, for resolving the model's `^N` source markers. */
      indexMap: Map<number, number>;
      summaryType: "watermark";
      parameters: {
        fromExclusive: { sentAt: string; messageId: number } | null;
        toInclusive: { sentAt: string; messageId: number };
        messageCount: number;
        usedFallback: boolean;
        /** Messages left past this summary's window, when the backlog was trimmed to fit. */
        backlogRemaining?: number;
      };
      messageCount: number;
      /** The chars/4 estimate fitToBudget ENFORCED against the budget — recorded as
       *  telemetry so the guard and the measurement can never silently diverge. */
      estimatedTokens: number;
      newWatermark: Cursor;
      usedFallback: boolean;
    };

/**
 * Shared "first half" of the catch-up flow: resolves the group, looks up the
 * watermark, computes the barrier-truncated range (or first-run fallback), and
 * returns what the web layer needs to serve the cache or stream + commit.
 *
 * Performs NO writes — the caller commits the watermark and persists the
 * summary only after a successful stream.
 */
export async function prepareSumbox(
  client: pg.Pool | pg.PoolClient,
  groupName: string,
  fallbackN: number = 25,
  tokenBudget: number,
  now: Date = new Date(),
): Promise<PreparedSumbox> {
  // 1. Resolve group
  const group = await findGroupByName(client, groupName);
  if (!group) {
    throw new Error(`Unknown chat "${groupName}". Run 'groups' to list.`);
  }

  // 2. Get watermark
  const wm = await getWatermark(client, group.id);

  // 3. Compute range
  let range: SelectedMessageWithCursor[]; // oldest-first (selectAfterCursor ORDERs ASC)
  let usedFallback: boolean;

  if (wm !== null) {
    // Incremental: messages strictly after the watermark, truncated at the barrier.
    // The barrier is the EARLIEST of two independent pending-media barriers:
    //   1. Pending voice note (no completed transcript): blocks because content may yet arrive.
    //   2. Pending visual media (no media_analyses row at all): blocks until analysis completes.
    //      A failed analysis row means we do NOT block (never-freeze guarantee).
    // Both barriers are fetched in parallel, then the earlier cursor wins.
    // Never-freeze cutoff: pending media older than this stops acting as a
    // barrier (its analysis/transcript is overdue and may never arrive).
    const staleBefore = new Date(now.getTime() - MEDIA_BARRIER_GRACE_MS);
    const all = await selectAfterCursor(client, group.id, wm.cursor);
    const [voiceBarrier, visualBarrier] = await Promise.all([
      firstPendingVoiceNoteAfter(client, group.id, wm.cursor, staleBefore),
      firstPendingVisualMediaAfter(client, group.id, wm.cursor, staleBefore),
    ]);

    // Pick the earliest non-null barrier cursor
    let barrier: Cursor | null = null;
    if (voiceBarrier !== null && visualBarrier !== null) {
      // Both present: take the one that comes first in conversation order
      const voiceFirst =
        voiceBarrier.sentAt < visualBarrier.sentAt ||
        (voiceBarrier.sentAt.getTime() === visualBarrier.sentAt.getTime() &&
          voiceBarrier.messageId < visualBarrier.messageId);
      barrier = voiceFirst ? voiceBarrier : visualBarrier;
    } else {
      barrier = voiceBarrier ?? visualBarrier;
    }

    if (barrier !== null) {
      // Keep only messages strictly before the barrier cursor
      range = all.filter(
        (m) =>
          m.sentAt < barrier!.sentAt ||
          (m.sentAt.getTime() === barrier!.sentAt.getTime() && m.messageId < barrier!.messageId),
      );
    } else {
      range = all;
    }
    usedFallback = false;
  } else {
    // First run: read all rows once and take the newest fallbackN.
    // Reading all rows on first run is acceptable — the range is bounded thereafter
    // by the watermark cursor on every subsequent call.
    const all = await selectAfterCursor(client, group.id, { sentAt: new Date(0), messageId: 0 });
    range = all.slice(-fallbackN);
    usedFallback = true;
  }

  // 4. Empty handling
  if (range.length === 0) {
    if (wm !== null) {
      const latest = await getLatestSumboxSummary(client, group.id);
      if (latest) {
        // Carry the full structured output — the web layer normalizes it so the
        // cache-hit renders the same §3 card as a fresh summary.
        return {
          kind: "cache-hit",
          summaryId: latest.id,
          summary: latest.output,
          generatedAt: latest.createdAt,
        };
      }
    }
    return { kind: "empty" };
  }

  // 5. Trim to the budget and build the prompt.
  // Catch-up has no user-tunable selection (no --last/--since): throwing here
  // would strand the group forever — the watermark never advances, the backlog
  // only grows, and every scheduled run re-throws. Instead summarize the oldest
  // slice that fits; the watermark advances and later runs drain the rest.
  const backlog = range.length;
  const kept = fitToBudget(range, tokenBudget);
  range = range.slice(0, kept);
  // A lone message that still overflows is clamped, never handed over whole.
  if (kept === 1) range = [clampToBudget(range[0]!, tokenBudget)];

  const prompt = buildPrompt(range);
  // The same chars/4 figure fitToBudget just enforced — surfaced (not recomputed
  // downstream) so the number recorded as telemetry IS the number the guard used.
  const estimatedTokens = estimateTokens(prompt.system + prompt.user);
  const last = range[range.length - 1]!;
  const newWatermark: Cursor = { sentAt: last.sentAt, messageId: last.messageId };

  const fromExclusive = wm
    ? { sentAt: wm.cursor.sentAt.toISOString(), messageId: wm.cursor.messageId }
    : null;

  // `backlogRemaining` is the operator's only signal that this summary covers
  // part of a draining backlog rather than everything new — without it a group
  // grinding through 5k messages looks identical to a healthy one.
  const parameters = {
    fromExclusive,
    toInclusive: { sentAt: newWatermark.sentAt.toISOString(), messageId: newWatermark.messageId },
    messageCount: range.length,
    usedFallback,
    ...(kept < backlog ? { backlogRemaining: backlog - kept } : {}),
  };

  return {
    kind: "ready",
    groupId: group.id,
    prompt,
    indexMap: prompt.indexMap,
    summaryType: "watermark",
    parameters,
    messageCount: range.length,
    estimatedTokens,
    newWatermark,
    usedFallback,
  };
}
