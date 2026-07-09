import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Create `status_snapshots` — a time-series record of system health written
 * by the ops sweep (feature 012). Each sweep writes one row containing job
 * counts, queue depths, redrive/flag statistics, and collector connectivity.
 *
 * The table is intentionally flat and tenant-agnostic so a nullable
 * `customer_id` can be added in V2 without reshaping existing columns.
 *
 * `captured_at` has a B-tree index because Grafana queries filter/order by it.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("status_snapshots", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    captured_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    service_up: { type: "boolean", notNull: true },
    collector_connected: { type: "boolean", notNull: true },
    last_heartbeat_at: { type: "timestamptz", notNull: false },
    stale: { type: "boolean", notNull: true },
    jobs_pending: { type: "integer", notNull: true },
    jobs_running: { type: "integer", notNull: true },
    jobs_done: { type: "integer", notNull: true },
    jobs_failed: { type: "integer", notNull: true },
    jobs_dead: { type: "integer", notNull: true },
    queue_depths: { type: "jsonb", notNull: false },
    redriven: { type: "integer", notNull: true },
    flagged: { type: "integer", notNull: true },
    flagged_details: { type: "jsonb", notNull: false },
  });

  pgm.createIndex("status_snapshots", "captured_at");
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("status_snapshots");
};
