import type { MigrationBuilder } from "node-pg-migrate";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Dismissed-sources tombstone table (#16 #5 #3):
 * when a user discards a Today-deck task/meeting suggestion, a tombstone row is
 * inserted here keyed by (kind, group_id, identity_key).  The extraction upserts
 * in agenda.ts skip any item whose tombstone exists, so a dismissed commitment is
 * never re-created by a subsequent digest run.
 *
 * Tenant-scoped + RLS-forced (mirrors create-todos / add-todo-meeting-sources).
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE dismissed_sources (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      kind text NOT NULL CHECK (kind IN ('todo','meeting')),
      group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      identity_key text NOT NULL,
      source_message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, kind, group_id, identity_key)
    );

    ALTER TABLE dismissed_sources ENABLE ROW LEVEL SECURITY;
    ALTER TABLE dismissed_sources FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON dismissed_sources
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS dismissed_sources");
};
