import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Enable + FORCE row-level security on every tenant-scoped table and install the
 * tenant_isolation policy. The policy keys off the per-transaction GUC `app.tenant_id`
 * (set by withTenant). current_setting(..., true) returns NULL when unset → no rows
 * match and writes are rejected (fail-closed).
 *
 * FORCE makes the policy apply even to the table owner (defense in depth). Superusers
 * and BYPASSRLS roles (catchapp_operator) still bypass — by design.
 *
 * Global tables (service_status, status_snapshots) are intentionally left without RLS.
 */
const SCOPED_TABLES = [
  "groups",
  "participants",
  "imports",
  "messages",
  "transcripts",
  "summaries",
  "total_summaries",
  "media_analyses",
  "message_media",
  "read_watermarks",
  "job_runs",
  "scheduler_state",
];

export const up = (pgm: MigrationBuilder): void => {
  for (const table of SCOPED_TABLES) {
    pgm.sql(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    `);
  }
};

export const down = (pgm: MigrationBuilder): void => {
  for (const table of SCOPED_TABLES) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${table};
      ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
    `);
  }
};
