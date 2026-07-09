import type { MigrationBuilder } from "node-pg-migrate";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * To-dos (S7): a checklist derived from structured-summary decision bullets.
 * Tenant-scoped + RLS-forced. Idempotent upsert on (tenant_id, source_message_id);
 * `done` is the one piece of user-authored state and is PRESERVED on re-extraction
 * (a checked box is never reset by a refresh).
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE todos (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      title text NOT NULL,
      due_at timestamptz,
      owner text,
      done boolean NOT NULL DEFAULT false,
      group_id bigint REFERENCES groups(id) ON DELETE CASCADE,
      source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT todos_tenant_source_unique UNIQUE (tenant_id, source_message_id)
    );
    CREATE INDEX todos_due_idx ON todos (tenant_id, due_at);

    ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE todos FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON todos
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS todos");
};
