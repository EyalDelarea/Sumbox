/**
 * T012 — enqueueScheduledRun
 *
 * Lists all groups; for each group that has readable messages after its
 * watermark (i.e. is "changed"), enqueues a summarize.group job.
 * Unchanged groups are skipped. Per-group errors never abort the batch.
 * Never throws.
 */

import type pg from "pg";
import { listIncludedGroupIds } from "../db/repositories/chat-scopes.js";
import type { JobBus } from "../jobs/job-bus.js";

export type EnqueueScheduledRunOpts = {
  /** When true, enqueue all groups regardless of whether they have new messages. */
  all?: boolean;
  /**
   * When provided, also enqueue ONE summarize.total job for [since, now] after
   * the per-group jobs. Omitted by callers that only want per-group behaviour.
   */
  sinceForTotal?: Date;
};

export type EnqueueScheduledRunResult = {
  enqueued: number;
  skipped: number;
};

/**
 * Check whether a group has at least one readable message after its watermark.
 *
 * Reuses the same content predicate as selectAfterCursor (non-system, non-empty
 * content after joining transcripts + media_analyses) but only checks existence
 * (LIMIT 1) to keep it cheap.
 *
 * When there is no watermark row (never summarized), the group is considered
 * changed iff it has at least one readable message at all.
 */
async function hasNewMessages(pool: pg.Pool, groupId: number): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `
    SELECT m.id
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
    LEFT JOIN read_watermarks rw ON rw.group_id = m.group_id
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      AND concat_ws(' — ',
            NULLIF(trim(m.text_content), ''),
            NULLIF(trim(a.description), ''),
            NULLIF(trim(t.transcript), '')
          ) <> ''
      AND (
        rw.group_id IS NULL
        OR m.sent_at > rw.watermark_sent_at
        OR (m.sent_at = rw.watermark_sent_at AND m.id > rw.watermark_message_id)
      )
    LIMIT 1
    `,
    [groupId],
  );
  return rows.length > 0;
}

/**
 * Enqueue a summarize.group job for every group that has new messages since
 * its watermark (or for all groups when opts.all is true).
 *
 * Per-group errors are caught and logged — one failure never aborts the batch.
 * The function itself never throws.
 */
export async function enqueueScheduledRun(
  pool: pg.Pool,
  bus: JobBus,
  opts?: EnqueueScheduledRunOpts,
): Promise<EnqueueScheduledRunResult> {
  let enqueued = 0;
  let skipped = 0;

  try {
    // Only included chats are summarized (S4 scope filter, default-OFF): a group
    // is processed only when it has an explicit `included = true` row — an
    // un-scoped chat is skipped. `opts.all` ignores the watermark, NOT the scope
    // — a forced run must not resurrect un-scoped/excluded chats.
    const includedIds = await listIncludedGroupIds(pool);

    for (const groupId of includedIds) {
      try {
        const changed = opts?.all === true || (await hasNewMessages(pool, groupId));
        if (!changed) {
          skipped++;
          continue;
        }

        await bus.enqueue("summarize.group", {
          groupId: String(groupId),
        });
        enqueued++;
      } catch (err) {
        // Per-group error: log and continue the batch
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[enqueueScheduledRun] group ${groupId} failed, skipping: ${msg}\n`);
        // Count as skipped so the caller knows something happened
        skipped++;
      }
    }
  } catch (err) {
    // Outer error (e.g. DB unreachable): log but never throw
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[enqueueScheduledRun] fatal error, returning partial result: ${msg}\n`);
  }

  if (opts?.sinceForTotal) {
    try {
      await bus.enqueue("summarize.total", {
        since: opts.sinceForTotal.toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[enqueueScheduledRun] summarize.total enqueue failed: ${msg}\n`);
    }
  }

  return { enqueued, skipped };
}
