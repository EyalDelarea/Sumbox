import type { MigrationBuilder } from "node-pg-migrate";

// Mirror of the default tenant id (see migrations 022/023) — inlined because
// node-pg-migrate cannot resolve cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * T2 hardening: `SET LOCAL app.tenant_id` (what withTenant does) leaves the custom GUC
 * DEFINED-as-empty-string on the session after COMMIT. The T1/T2 expressions
 * `current_setting('app.tenant_id', true)::uuid` only handled the unset(NULL) case, so
 * the FIRST scoped query on a pooled connection poisoned it: every later un-scoped
 * query on that connection failed with `invalid input syntax for type uuid: ""` (in the
 * column default and in the RLS policy alike). Dormant in T1 — the app never set the
 * GUC; the T2 live cutover trips it immediately.
 *
 * Fix: route every read of the GUC through NULLIF(..., '') so empty-string === unset.
 * Semantics are unchanged: no-context writes on the app role are still rejected
 * (fail-closed — policy compares against NULL), no-context reads still see zero rows,
 * and admin/maintenance writes still default to the default tenant.
 */

// All 15 tenant-scoped tables: 12 from T1 (023/025) + 3 auth tables (028–030).
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
  "users",
  "user_sessions",
  "email_tokens",
];

const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
const NAIVE_GUC = `current_setting('app.tenant_id', true)::uuid`;

export const up = (pgm: MigrationBuilder): void => {
  for (const table of SCOPED_TABLES) {
    pgm.sql(`
      ALTER TABLE ${table}
        ALTER COLUMN tenant_id SET DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}');
      DROP POLICY tenant_isolation ON ${table};
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = ${HARDENED_GUC})
        WITH CHECK (tenant_id = ${HARDENED_GUC});
    `);
  }
};

export const down = (pgm: MigrationBuilder): void => {
  for (const table of SCOPED_TABLES) {
    pgm.sql(`
      ALTER TABLE ${table}
        ALTER COLUMN tenant_id SET DEFAULT COALESCE(${NAIVE_GUC}, '${DEFAULT_TENANT_ID}');
      DROP POLICY tenant_isolation ON ${table};
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = ${NAIVE_GUC})
        WITH CHECK (tenant_id = ${NAIVE_GUC});
    `);
  }
};
