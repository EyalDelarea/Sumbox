/**
 * aida-messages.ts — which WhatsApp messages @Aida herself sent.
 *
 * Written at SEND time from the WAMessage sendText returns, never from the
 * ingest path — the collector cannot tell her echo from any other from_me
 * message. See the migration for why a `messages` column would race.
 */

import type pg from "pg";

/**
 * Record one reply of hers. Idempotent on (group_id, external_id), so a retry or
 * a duplicate echo cannot fork a second row.
 *
 * `question` is the triggering question, kept for trace-hunting when a bad answer
 * turns up later.
 */
export async function recordAidaMessage(
  client: pg.Pool | pg.PoolClient,
  input: { groupId: number; externalId: string; question?: string; sentAt?: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO aida_messages (group_id, external_id, question, sent_at)
     VALUES ($1, $2, $3, COALESCE($4, now()))
     ON CONFLICT (group_id, external_id) DO NOTHING`,
    [input.groupId, input.externalId, input.question ?? null, input.sentAt ?? null],
  );
}

/**
 * Did @Aida send this message? The reply-threading gate.
 *
 * Correct regardless of whether her echo has been ingested into `messages` yet —
 * that is the whole point of keying on external_id.
 */
export async function isAidaMessage(
  client: pg.Pool | pg.PoolClient,
  input: { groupId: number; externalId: string },
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM aida_messages WHERE group_id = $1 AND external_id = $2 LIMIT 1`,
    [input.groupId, input.externalId],
  );
  return rows.length > 0;
}
