import type { MigrationBuilder } from "node-pg-migrate";

// Mirror of the default tenant id (migration 022). Inlined — node-pg-migrate
// cannot resolve cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// Hardened GUC read (migration 031 / harden-tenant-guc-new-tables): NULLIF treats
// the empty-string state a committed `SET LOCAL app.tenant_id` leaves behind as
// unset, so reads fail closed instead of erroring on `""::uuid`.
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Chat scopes (S4): persist, per tenant, which chats Sumbox summarizes and how
 * they are grouped. Two tenant-scoped + RLS-forced tables:
 *
 *   scope_categories — the user-defined category list (עבודה/אישי/לקוחות seeded as
 *     system rows for the default tenant). A first-class table, not a text column on
 *     chat_scopes, so an empty "+ קבוצה" category and a rename-safe "move to group"
 *     target have stable identity.
 *   chat_scopes — one row per (tenant, group): included (whitelist/blacklist),
 *     optional category, and a soft removed_at (→ "הוסרו" section, lossless restore).
 *
 * Scope governs SUMMARIZATION, not ingestion: the collector keeps storing all
 * messages, so exclude/remove stays reversible. A group with NO chat_scopes row is
 * treated as included (default-on) — preserving today's "summarize everything".
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE scope_categories (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      name text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_system boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scope_categories_tenant_name_unique UNIQUE (tenant_id, name)
    );
    CREATE INDEX scope_categories_tenant_idx ON scope_categories (tenant_id, sort_order);

    CREATE TABLE chat_scopes (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      included boolean NOT NULL DEFAULT true,
      category_id bigint REFERENCES scope_categories(id) ON DELETE SET NULL,
      removed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chat_scopes_tenant_group_unique UNIQUE (tenant_id, group_id)
    );
    CREATE INDEX chat_scopes_tenant_group_idx ON chat_scopes (tenant_id, group_id);
    -- keeps the digest filter (listIncludedGroupIds) cheap
    CREATE INDEX chat_scopes_included_idx ON chat_scopes (tenant_id)
      WHERE included AND removed_at IS NULL;
  `);

  // Tenant isolation — fail-closed, hardened GUC form (mirrors migration 031).
  for (const table of ["scope_categories", "chat_scopes"]) {
    pgm.sql(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = ${HARDENED_GUC})
        WITH CHECK (tenant_id = ${HARDENED_GUC});
    `);
  }

  // Seed the system categories for the default tenant (single-user zero-config).
  // New tenants get these seeded at registration in a later slice.
  pgm.sql(`
    INSERT INTO scope_categories (tenant_id, name, sort_order, is_system)
    VALUES
      ('${DEFAULT_TENANT_ID}', 'עבודה', 0, true),
      ('${DEFAULT_TENANT_ID}', 'אישי', 1, true),
      ('${DEFAULT_TENANT_ID}', 'לקוחות', 2, true)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  // chat_scopes first — its category_id FK depends on scope_categories.
  pgm.sql(`
    DROP TABLE IF EXISTS chat_scopes;
    DROP TABLE IF EXISTS scope_categories;
  `);
};
