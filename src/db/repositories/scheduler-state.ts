import type pg from "pg";

/**
 * Returns the last recorded run time for a scheduler slot, or null when no
 * run has ever been recorded for that slot.
 */
export async function getLastRun(
  client: pg.Pool | pg.PoolClient,
  slotKey: string,
): Promise<Date | null> {
  const { rows } = await client.query<{ last_run_at: Date }>(
    `
    SELECT last_run_at
    FROM scheduler_state
    WHERE slot_key = $1
    `,
    [slotKey],
  );

  if (rows.length === 0) return null;
  return rows[0]!.last_run_at;
}

/**
 * Records that a scheduled slot ran at the given time.
 *
 * Upserts the row for the given slotKey. The monotonic guard ensures
 * last_run_at never moves backwards: only updates when the incoming runAt
 * is strictly greater than the stored value.
 */
export async function recordRun(
  client: pg.Pool | pg.PoolClient,
  slotKey: string,
  runAt: Date,
): Promise<void> {
  await client.query(
    `
    INSERT INTO scheduler_state (slot_key, last_run_at, updated_at)
    VALUES ($1, $2, now())
    ON CONFLICT (tenant_id, slot_key) DO UPDATE
      SET last_run_at = GREATEST(scheduler_state.last_run_at, EXCLUDED.last_run_at),
          updated_at  = now()
    `,
    [slotKey, runAt],
  );
}
