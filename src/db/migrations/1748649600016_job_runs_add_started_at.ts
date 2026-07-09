import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Add `started_at` to job_runs so we can distinguish queue wait from actual
 * processing time. Without it, the only timestamps were created_at (enqueued)
 * and updated_at (last status change), so "duration" conflated time spent
 * waiting in the backlog with real compute — wildly inflating slow-backlog
 * types (e.g. analyze.image averaged ~1.7h, almost all of it queue wait).
 *
 * The worker stamps started_at = now() on the pending → running transition.
 * Queue wait  = started_at - created_at.
 * Processing  = updated_at - started_at  (for terminal rows).
 *
 * Nullable: rows that ran before this migration (and any still pending) carry
 * no start time and are simply excluded from the new averages.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn("job_runs", {
    started_at: { type: "timestamptz", notNull: false },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn("job_runs", "started_at");
};
