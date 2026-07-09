import type { MigrationBuilder } from "node-pg-migrate";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Source-count join tables (#16 #5): record every contributing source message
 * for a merged/deduped todo or meeting so the UI can show "מ-N הודעות".
 *
 *   todo_sources    — one row per (todo, source message) pair; idempotent via
 *     UNIQUE (tenant_id, todo_id, source_message_id). Cascades on todo delete.
 *   meeting_sources — same shape for meetings.
 *
 * Both are tenant-scoped + RLS-forced (mirrors create-todos / create-meetings).
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE todo_sources (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      todo_id bigint NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, todo_id, source_message_id)
    );

    ALTER TABLE todo_sources ENABLE ROW LEVEL SECURITY;
    ALTER TABLE todo_sources FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON todo_sources
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});

    CREATE TABLE meeting_sources (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, meeting_id, source_message_id)
    );

    ALTER TABLE meeting_sources ENABLE ROW LEVEL SECURITY;
    ALTER TABLE meeting_sources FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON meeting_sources
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS meeting_sources;
    DROP TABLE IF EXISTS todo_sources;
  `);
};
