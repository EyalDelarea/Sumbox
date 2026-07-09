import type { MigrationBuilder } from "node-pg-migrate";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Meetings (S7): a LOCAL agenda derived from structured-summary decision bullets
 * that look like meetings (a detected time). Tenant-scoped + RLS-forced.
 * Idempotent upsert on (tenant_id, source_message_id). NOT outbound — no Google
 * Calendar (that is the constitution-gated S8).
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE meetings (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      title text NOT NULL,
      starts_at timestamptz,
      owner text,
      group_id bigint REFERENCES groups(id) ON DELETE CASCADE,
      source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT meetings_tenant_source_unique UNIQUE (tenant_id, source_message_id)
    );
    CREATE INDEX meetings_starts_idx ON meetings (tenant_id, starts_at);

    ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE meetings FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON meetings
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS meetings");
};
