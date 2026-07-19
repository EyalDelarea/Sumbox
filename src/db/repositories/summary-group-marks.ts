import type pg from "pg";

/**
 * The group's shared /סיכום cursor: where this group last caught up, plus a
 * pointer to the last reply so the next one can quote it. One row per group —
 * every asker shares this window. See migration create-summary-group-marks.
 */
export type SummaryGroupMark = {
  lastSummarizedAt: Date;
  /** The group's last summary row, for rebuilding the quote text (null if purged). */
  lastSummaryId: number | null;
  /** WhatsApp message id of the group's last summary reply, for quoting it. */
  lastReplyWaMessageId: string | null;
};

/** Read a group's mark, or null if /סיכום has never run here. */
export async function getSummaryGroupMark(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<SummaryGroupMark | null> {
  const { rows } = await client.query<{
    last_summarized_at: Date;
    last_summary_id: string | null;
    last_reply_wa_message_id: string | null;
  }>(
    `SELECT last_summarized_at, last_summary_id, last_reply_wa_message_id
       FROM summary_group_marks
      WHERE group_id = $1`,
    [groupId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    lastSummarizedAt: row.last_summarized_at,
    lastSummaryId: row.last_summary_id === null ? null : Number(row.last_summary_id),
    lastReplyWaMessageId: row.last_reply_wa_message_id,
  };
}

/**
 * Advance the group's mark to the given point (idempotent upsert). Returns
 * whether the write landed.
 *
 * The advance is MONOTONIC: a timestamp at or before the stored one is rejected.
 * `lastSummarizedAt` comes from the command message's `messageTimestamp` — the
 * sender's device clock, which nothing validates. With one cursor per group, a
 * single skewed clock writing a far-future value would leave every later /סיכום
 * matching no messages ("אין הודעות חדשות") for everyone, permanently, with no
 * way to recover from inside the app. The guard makes a forward move the only
 * possible outcome, and the boolean lets the caller log a rejected write instead
 * of assuming success.
 */
export async function upsertSummaryGroupMark(
  client: pg.Pool | pg.PoolClient,
  m: {
    groupId: number;
    lastSummarizedAt: Date;
    lastSummaryId: number;
    lastReplyWaMessageId: string | null;
  },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO summary_group_marks
       (group_id, last_summarized_at, last_summary_id, last_reply_wa_message_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (group_id) DO UPDATE SET
       last_summarized_at = EXCLUDED.last_summarized_at,
       last_summary_id = EXCLUDED.last_summary_id,
       last_reply_wa_message_id = EXCLUDED.last_reply_wa_message_id,
       updated_at = now()
     WHERE EXCLUDED.last_summarized_at > summary_group_marks.last_summarized_at`,
    [m.groupId, m.lastSummarizedAt, m.lastSummaryId, m.lastReplyWaMessageId],
  );
  return (rowCount ?? 0) > 0;
}
