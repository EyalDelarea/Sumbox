/**
 * aggregate.ts — turn a window of chat messages into suggested tasks.
 *
 * Pure orchestration over injected dependencies, so the same code runs from the
 * CLI backfill and (later) the live collector, and is testable without Ollama.
 *
 *   messages ──batch──▶ model suggests (cited, kind-labelled: task / grocery)
 *            ──each──▶ dedup vs live items OF THE SAME KIND raised in the last N days
 *            ──new───▶ insert as 'suggested', under its kind
 *
 * Messages carrying a @Rosey tag are NOT read here: D3 says an explicit tag
 * always wins, so the model never second-guesses a tagged message.
 */

import type { RoseySourceMessage } from "../db/repositories/rosey-tasks.js";
import { type DedupDecision, decideDuplicate, type LiveTaskRef } from "./dedup.js";
import type { RoseyItemKind } from "./kind.js";
import { buildSuggestPrompt, parseSuggestions, SUGGEST_SYSTEM } from "./suggest.js";
import { titleKey } from "./text.js";

/** Messages per suggestion call: enough context for a list typed over several messages. */
export const DEFAULT_BATCH_SIZE = 40;
/**
 * Dedup only against tasks raised this recently. Recurring errands come back
 * week after week and almost never get an explicit "done" (measured: 3 of 87
 * tasks), so an unbounded window would fold every week's "milk" into one task
 * from months ago.
 */
export const DEFAULT_DEDUP_WINDOW_DAYS = 14;

export type AggregateDeps = {
  generate: (system: string, user: string) => Promise<string>;
  isTagged: (text: string) => boolean;
  resolveRaisedBy: (messageIds: readonly number[]) => Promise<Map<number, number | null>>;
  /**
   * Every live item of `kind` raised in [since, until] — a truncated list lets
   * twins through. Dedup is per kind: "milk" on the shopping list and a task
   * that happens to share its title are two items.
   */
  liveTasksRaisedBetween: (since: Date, until: Date, kind: RoseyItemKind) => Promise<LiveTaskRef[]>;
  insertSuggestion: (input: {
    title: string;
    titleKey: string;
    kind: RoseyItemKind;
    raisedByParticipantId: number | null;
    sourceMessageId: number;
    sourceItemIndex: number;
    raisedAt: Date;
  }) => Promise<number | null>;
  /** Told about every failed batch, so a failure is logged and never silent. */
  onBatchError?: (err: unknown, batch: { index: number; size: number }) => void;
};

export type AggregateReport = {
  messagesRead: number;
  taggedSkipped: number;
  batches: number;
  /** Batches whose model call threw or whose reply had no usable JSON. */
  batchFailures: number;
  proposed: number;
  rejected: Record<string, number>;
  droppedByKind: Record<string, number>;
  merged: { exact: number; model: number };
  dedupUnparsed: number;
  created: number;
  createdByKind: Record<RoseyItemKind, number>;
  /** Already stored from an earlier run (same message, same normalized title), whatever its status. */
  alreadyStored: number;
  raisedByUnresolved: number;
};

function bump(into: Record<string, number>, from: Partial<Record<string, number>>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + (v ?? 0);
}

export async function aggregateMessages(
  messages: readonly RoseySourceMessage[],
  deps: AggregateDeps,
  opts: { batchSize?: number; dedupWindowDays?: number } = {},
): Promise<AggregateReport> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const windowMs = (opts.dedupWindowDays ?? DEFAULT_DEDUP_WINDOW_DAYS) * 86_400_000;
  const report: AggregateReport = {
    messagesRead: messages.length,
    taggedSkipped: 0,
    batches: 0,
    batchFailures: 0,
    proposed: 0,
    rejected: {},
    droppedByKind: {},
    merged: { exact: 0, model: 0 },
    dedupUnparsed: 0,
    created: 0,
    createdByKind: { task: 0, grocery: 0 },
    alreadyStored: 0,
    raisedByUnresolved: 0,
  };

  const untagged = messages.filter((m) => !deps.isTagged(m.content));
  report.taggedSkipped = messages.length - untagged.length;
  const byId = new Map(untagged.map((m) => [m.messageId, m]));

  for (let i = 0; i < untagged.length; i += batchSize) {
    const batch = untagged.slice(i, i + batchSize);
    report.batches++;
    try {
      const reply = await deps.generate(SUGGEST_SYSTEM, buildSuggestPrompt(batch));
      const parsed = parseSuggestions(reply, batch);
      if (!parsed) {
        report.batchFailures++;
        deps.onBatchError?.(new Error("suggestion reply had no usable JSON"), {
          index: report.batches - 1,
          size: batch.length,
        });
        continue;
      }
      report.proposed += parsed.items.length;
      bump(report.rejected, parsed.rejected);
      bump(report.droppedByKind, parsed.droppedByKind);

      const raisedBy = await deps.resolveRaisedBy([
        ...new Set(parsed.items.map((it) => it.sourceMessageId)),
      ]);
      for (const item of parsed.items) {
        const msg = byId.get(item.sourceMessageId)!; // parseSuggestions only keeps batch ids
        const key = titleKey(item.title);
        if (!key) {
          report.rejected.empty_text = (report.rejected.empty_text ?? 0) + 1;
          continue;
        }
        // Both sides of the message: an explicit tag for the same item may be
        // stored before this suggestion while being sent after it.
        const live = await deps.liveTasksRaisedBetween(
          new Date(msg.sentAt.getTime() - windowMs),
          new Date(msg.sentAt.getTime() + windowMs),
          item.kind,
        );
        const decision: DedupDecision = await decideDuplicate(
          { title: item.title, titleKey: key },
          live,
          deps.generate,
        );
        if (decision.kind === "exact" || decision.kind === "model") {
          report.merged[decision.kind]++;
          continue;
        }
        if (decision.kind === "new_unparsed") report.dedupUnparsed++;
        const raisedByParticipantId = raisedBy.get(item.sourceMessageId) ?? null;
        const id = await deps.insertSuggestion({
          title: item.title,
          titleKey: key,
          kind: item.kind,
          raisedByParticipantId,
          sourceMessageId: item.sourceMessageId,
          sourceItemIndex: item.itemIndex,
          raisedAt: msg.sentAt,
        });
        if (id === null) {
          report.alreadyStored++;
          continue;
        }
        report.created++;
        report.createdByKind[item.kind]++;
        if (raisedByParticipantId === null) report.raisedByUnresolved++;
      }
    } catch (err) {
      deps.onBatchError?.(err, { index: report.batches - 1, size: batch.length });
      // The model or the DB failed mid-batch. Rows already written are kept (the
      // insert is idempotent); the caller sees the failure and must not advance
      // its cursor past these messages, so the next run reads them again.
      report.batchFailures++;
    }
  }
  return report;
}
