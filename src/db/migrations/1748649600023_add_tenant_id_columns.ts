import type { MigrationBuilder } from "node-pg-migrate";

// Mirror of the default tenant id seeded in migration 022 and exposed to the app via
// config / tenant-context. Inlined (not imported) because node-pg-migrate loads each
// migration file via raw ESM resolution, which cannot resolve cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Add a mandatory tenant_id to every tenant-scoped table:
 *   1. add tenant_id NOT NULL DEFAULT COALESCE(current_setting('app.tenant_id'), '<default>'):
 *      - at migration time the GUC is unset → existing rows backfill to the default
 *        tenant atomically (ZERO data loss);
 *      - inside withTenant(A) the GUC is A → inserts auto-attribute to A (no per-repo
 *        wiring needed);
 *      - with no context the value falls back to the default tenant.
 *   2. add FK -> tenants(id)
 *   3. add a tenant-leading composite index
 *   4. re-scope natural-key UNIQUE/PK constraints to be per-tenant
 *
 * Cross-tenant safety is guaranteed by RLS, not by this default: the WITH CHECK policy
 * (migration 025) compares tenant_id to the GUC, so for the non-superuser app role a
 * no-context write is rejected (fail-closed) and a write whose tenant_id != the active
 * context is rejected. Existing single-tenant tests connect as the admin/superuser
 * (RLS-bypassing) role, so they keep working with writes landing on the default tenant.
 */

// table -> tenant-leading composite index columns
const SCOPED: Record<string, string[]> = {
  groups: ["tenant_id", "whatsapp_id"],
  participants: ["tenant_id", "display_name"],
  imports: ["tenant_id", "group_id"],
  messages: ["tenant_id", "group_id", "sent_at"],
  transcripts: ["tenant_id", "message_id"],
  summaries: ["tenant_id", "group_id", "created_at"],
  total_summaries: ["tenant_id", "created_at"],
  media_analyses: ["tenant_id", "message_id"],
  message_media: ["tenant_id", "message_id"],
  read_watermarks: ["tenant_id", "group_id"],
  job_runs: ["tenant_id", "status", "created_at"],
  scheduler_state: ["tenant_id", "slot_key"],
};

export const up = (pgm: MigrationBuilder): void => {
  for (const [table, indexCols] of Object.entries(SCOPED)) {
    pgm.sql(`
      ALTER TABLE ${table}
        ADD COLUMN tenant_id uuid NOT NULL
        DEFAULT COALESCE(current_setting('app.tenant_id', true)::uuid, '${DEFAULT_TENANT_ID}');
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants(id);
      CREATE INDEX ${table}_tenant_idx ON ${table} (${indexCols.join(", ")});
    `);
  }

  // Re-scope global natural-key uniqueness to be per-tenant, so two tenants can
  // independently have a group/participant with the same name.
  pgm.sql(`
    ALTER TABLE groups DROP CONSTRAINT groups_name_unique;
    ALTER TABLE groups ADD CONSTRAINT groups_tenant_name_unique UNIQUE (tenant_id, name);

    ALTER TABLE participants DROP CONSTRAINT participants_display_name_unique;
    ALTER TABLE participants
      ADD CONSTRAINT participants_tenant_display_name_unique UNIQUE (tenant_id, display_name);

    ALTER TABLE scheduler_state DROP CONSTRAINT scheduler_state_pkey;
    ALTER TABLE scheduler_state ADD PRIMARY KEY (tenant_id, slot_key);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  // Restore global constraints, then drop tenant_id (without deleting data rows).
  pgm.sql(`
    ALTER TABLE scheduler_state DROP CONSTRAINT scheduler_state_pkey;
    ALTER TABLE scheduler_state ADD PRIMARY KEY (slot_key);

    ALTER TABLE participants DROP CONSTRAINT participants_tenant_display_name_unique;
    ALTER TABLE participants
      ADD CONSTRAINT participants_display_name_unique UNIQUE (display_name);

    ALTER TABLE groups DROP CONSTRAINT groups_tenant_name_unique;
    ALTER TABLE groups ADD CONSTRAINT groups_name_unique UNIQUE (name);
  `);

  for (const table of Object.keys(SCOPED)) {
    pgm.sql(`
      DROP INDEX IF EXISTS ${table}_tenant_idx;
      ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_tenant_id_fkey;
      ALTER TABLE ${table} DROP COLUMN tenant_id;
    `);
  }
};
