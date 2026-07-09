import type pg from "pg";

export type Cursor = { sentAt: Date; messageId: number };

export type Watermark = {
  groupId: number;
  cursor: Cursor;
  updatedAt: Date;
};

/**
 * Returns the watermark for a group, or null when no row exists
 * ("never caught up"). Never throws on a missing row.
 */
export async function getWatermark(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<Watermark | null> {
  const { rows } = await client.query<{
    group_id: string;
    watermark_sent_at: Date;
    watermark_message_id: string;
    updated_at: Date;
  }>(
    `
    SELECT group_id, watermark_sent_at, watermark_message_id, updated_at
    FROM read_watermarks
    WHERE group_id = $1
    `,
    [groupId],
  );

  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    groupId: Number(row.group_id),
    cursor: {
      sentAt: row.watermark_sent_at,
      messageId: Number(row.watermark_message_id),
    },
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts or updates the watermark for a group.
 *
 * Monotonic guard: the update only takes effect when the incoming cursor is
 * strictly greater than the stored one:
 *   new.sent_at > old.sent_at
 *   OR (new.sent_at = old.sent_at AND new.message_id > old.message_id)
 *
 * A stale or equal cursor is silently ignored, so the watermark never moves
 * backward. updated_at is always set to now() on an actual advance.
 */
export async function upsertWatermark(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  cursor: Cursor,
): Promise<void> {
  await client.query(
    `
    INSERT INTO read_watermarks (group_id, watermark_sent_at, watermark_message_id, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (group_id) DO UPDATE
      SET watermark_sent_at    = EXCLUDED.watermark_sent_at,
          watermark_message_id = EXCLUDED.watermark_message_id,
          updated_at           = now()
      WHERE
        EXCLUDED.watermark_sent_at > read_watermarks.watermark_sent_at
        OR (
          EXCLUDED.watermark_sent_at = read_watermarks.watermark_sent_at
          AND EXCLUDED.watermark_message_id > read_watermarks.watermark_message_id
        )
    `,
    [groupId, cursor.sentAt, cursor.messageId],
  );
}
