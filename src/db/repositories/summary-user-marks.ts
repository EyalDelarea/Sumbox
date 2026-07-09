import type pg from "pg";

/**
 * Per-user /סיכום cursor for a group: where this participant last caught up, plus
 * a pointer to their last reply so the next one can quote it. One row per
 * (tenant, group, participant). See migration create_summary_user_marks.
 */
export type SummaryUserMark = {
  lastSummarizedAt: Date;
  /** The user's last summary row, for rebuilding the quote text (null if purged). */
  lastSummaryId: number | null;
  /** WhatsApp message id of the user's last reply, for quoting it. */
  lastReplyWaMessageId: string | null;
};

/** Read a participant's mark for a group, or null if they've never asked here. */
export async function getSummaryUserMark(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  participantId: number,
): Promise<SummaryUserMark | null> {
  const { rows } = await client.query<{
    last_summarized_at: Date;
    last_summary_id: string | null;
    last_reply_wa_message_id: string | null;
  }>(
    `SELECT last_summarized_at, last_summary_id, last_reply_wa_message_id
       FROM summary_user_marks
      WHERE group_id = $1 AND participant_id = $2`,
    [groupId, participantId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    lastSummarizedAt: row.last_summarized_at,
    lastSummaryId: row.last_summary_id === null ? null : Number(row.last_summary_id),
    lastReplyWaMessageId: row.last_reply_wa_message_id,
  };
}

/** Advance a participant's mark to the given point (idempotent upsert). */
export async function upsertSummaryUserMark(
  client: pg.Pool | pg.PoolClient,
  m: {
    groupId: number;
    participantId: number;
    lastSummarizedAt: Date;
    lastSummaryId: number;
    lastReplyWaMessageId: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO summary_user_marks
       (group_id, participant_id, last_summarized_at, last_summary_id, last_reply_wa_message_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, group_id, participant_id) DO UPDATE SET
       last_summarized_at = EXCLUDED.last_summarized_at,
       last_summary_id = EXCLUDED.last_summary_id,
       last_reply_wa_message_id = EXCLUDED.last_reply_wa_message_id,
       updated_at = now()`,
    [m.groupId, m.participantId, m.lastSummarizedAt, m.lastSummaryId, m.lastReplyWaMessageId],
  );
}
