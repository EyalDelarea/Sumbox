import type pg from "pg";

/**
 * Persistence for Today info-card dismissals. A dismissal is keyed to the
 * `total_summaries` row the card was rendered from (`summaryId`) plus the
 * client-side card identity (`cardId`, e.g. `info:highlights` or
 * `info:chat:<chat>`), so it only suppresses *that* version of the digest — a
 * freshly generated summary is a new row and its cards surface again.
 */

/** Record a dismissal. Idempotent: a repeat dismiss of the same card is a no-op. */
export async function dismissInfoCard(
  client: pg.Pool | pg.PoolClient,
  summaryId: number,
  cardId: string,
): Promise<void> {
  await client.query(
    `
    INSERT INTO dismissed_info_cards (summary_id, card_id)
    VALUES ($1, $2)
    ON CONFLICT (tenant_id, summary_id, card_id) DO NOTHING
    `,
    [summaryId, cardId],
  );
}

/** Reverse a dismissal (the undo path). A no-op if it was never dismissed. */
export async function undismissInfoCard(
  client: pg.Pool | pg.PoolClient,
  summaryId: number,
  cardId: string,
): Promise<void> {
  await client.query("DELETE FROM dismissed_info_cards WHERE summary_id = $1 AND card_id = $2", [
    summaryId,
    cardId,
  ]);
}

/** The card ids dismissed for a given summary, as a Set for O(1) filtering. */
export async function listDismissedCardIds(
  client: pg.Pool | pg.PoolClient,
  summaryId: number,
): Promise<Set<string>> {
  const { rows } = await client.query<{ card_id: string }>(
    "SELECT card_id FROM dismissed_info_cards WHERE summary_id = $1",
    [summaryId],
  );
  return new Set(rows.map((r) => r.card_id));
}
