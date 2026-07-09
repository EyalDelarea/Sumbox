import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

// Inlined — node-pg-migrate can't resolve cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Spec 024 — `assistant_memory`: durable facts the conversational agent (העוזר)
 * keeps about the user across conversations (preferences, role, recurring
 * context, name). Read into the agent's system instruction each turn; written
 * via the `remember` tool / removed via `forget`. Tenant-scoped + RLS like every
 * user table; in single-user mode the default tenant owns the rows.
 *
 *   content — one short fact ("מנהל/ת את קבוצת ההורים של כיתה ב'", "מעדיף/ה תשובות קצרות").
 *   source  — 'user' (the user said "remember…") vs 'inferred' (the agent learned it).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE assistant_memory (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      content text NOT NULL,
      source text NOT NULL DEFAULT 'user'
        CHECK (source IN ('user','inferred')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX assistant_memory_idx ON assistant_memory (tenant_id, created_at);

    ALTER TABLE assistant_memory ENABLE ROW LEVEL SECURITY;
    ALTER TABLE assistant_memory FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON assistant_memory
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS assistant_memory;`);
}
