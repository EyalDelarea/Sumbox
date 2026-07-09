import type { MigrationBuilder } from "node-pg-migrate";

// Mirror of the default tenant id (see migration 022) — inlined because
// node-pg-migrate cannot resolve cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Follow-up to `tenant_guc_empty_string_hardening` (migration 031). That migration
 * routed every GUC read through NULLIF(..., '') so the empty-string state that
 * `SET LOCAL app.tenant_id` leaves behind after COMMIT is treated as unset — but it
 * only rewrote the tables that existed at the time.
 *
 * Two tenant-scoped tables created afterwards reintroduced the naive
 * `current_setting('app.tenant_id', true)::uuid` form in both their column default
 * and their RLS policy:
 *   - identity_links     (migration 1781100040328)
 *   - message_embeddings (migration 1781100447880)
 *
 * On a pooled `catchapp_app` connection whose GUC was left as empty-string by a prior
 * `withTenant()`, any query touching these tables then fails with
 * `invalid input syntax for type uuid: ""` instead of failing closed — silently
 * breaking semantic retrieval / `ask` / embedding-backfill in multi-tenant mode.
 *
 * Fix: apply the same hardened expression to these two tables. Semantics are
 * unchanged (fail-closed): no-context reads see zero rows, no-context writes are
 * rejected, admin/maintenance writes still default to the default tenant.
 */

const NEW_SCOPED_TABLES = ["identity_links", "message_embeddings"];

const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
const NAIVE_GUC = `current_setting('app.tenant_id', true)::uuid`;

export const up = (pgm: MigrationBuilder): void => {
  for (const table of NEW_SCOPED_TABLES) {
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
  for (const table of NEW_SCOPED_TABLES) {
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
