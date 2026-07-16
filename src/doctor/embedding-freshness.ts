/**
 * embedding-freshness.ts — is the embedding sweep actually running?
 *
 * The sweep's own DEAD_STREAK_ALERT only fires when a batch RUNS AND FAILS. A
 * sweep that never ticks is completely silent, and that is not hypothetical: on
 * 2026-07-16 it stopped at 12:44 and did not resume for ~50 minutes, spanning an
 * entire conversation. Nothing logged, nothing alerted. @Aida silently degraded
 * to lexical-only retrieval and answered "לא מצאתי" with total confidence.
 *
 * The doctor is a SEPARATE PROCESS from the worker that owns the sweep, so it
 * cannot read an in-memory heartbeat. It infers liveness from the DB instead —
 * the same query that diagnosed the outage by hand. That is the better test
 * anyway: it measures the outcome users feel (are recent messages searchable?)
 * rather than whether a timer is ticking.
 */

import type pg from "pg";

/** Oldest an eligible unembedded message may be before the sweep is "behind". */
const STALE_AFTER_MS = 5 * 60_000;

export type FreshnessProbe = {
  /** Age of the OLDEST message still waiting to be embedded, in ms. Null when the queue is drained. */
  oldestPendingMs: number | null;
  pending: number;
};

/**
 * Ask the DB how far behind the sweep is.
 *
 * Mirrors selectUnembeddedContentMessages' eligibility exactly — system messages
 * and empty content are never embedded, so counting them would report a
 * permanent phantom backlog and train everyone to ignore the check.
 */
export async function probeEmbeddingFreshness(
  pool: pg.Pool | pg.PoolClient,
  now: () => number = Date.now,
): Promise<FreshnessProbe> {
  const { rows } = await pool.query<{ pending: string; oldest: Date | null }>(
    `SELECT count(*) AS pending, min(m.sent_at) AS oldest
       FROM messages m
       LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
       LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
       LEFT JOIN message_embeddings e ON e.message_id = m.id
      WHERE e.message_id IS NULL
        AND m.message_type <> 'system'
        AND concat_ws(' — ',
              NULLIF(trim(m.text_content), ''),
              NULLIF(trim(a.description), ''),
              NULLIF(trim(t.transcript), '')
            ) <> ''`,
  );
  const row = rows[0];
  const oldest = row?.oldest ?? null;
  return {
    pending: Number(row?.pending ?? 0),
    oldestPendingMs: oldest ? now() - oldest.getTime() : null,
  };
}

/**
 * Healthy when nothing eligible has been waiting longer than STALE_AFTER_MS.
 *
 * Deliberately NOT a count threshold: a big backlog draining fast is fine, while
 * a single message stuck for an hour means the sweep is dead. Age is the signal;
 * volume is not.
 */
export function isFresh(p: FreshnessProbe): boolean {
  return p.oldestPendingMs === null || p.oldestPendingMs <= STALE_AFTER_MS;
}

/** Human-readable state for the doctor's `detail`. */
export function describeFreshness(p: FreshnessProbe): string {
  if (p.oldestPendingMs === null) return "all messages embedded";
  const mins = Math.round(p.oldestPendingMs / 60_000);
  return `${p.pending} message(s) unembedded; oldest waiting ${mins} min — @Aida's semantic search is blind to them and will answer "לא מצאתי" about anything it cannot see`;
}
