import type { MigrationBuilder } from "node-pg-migrate";

// Inlined, not imported — node-pg-migrate loads each migration via raw ESM
// resolution and cannot resolve cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
// Hardened GUC read: NULLIF(..., '') treats the empty-string state that
// `SET LOCAL app.tenant_id` leaves behind after COMMIT as unset, so a pooled
// connection fails closed instead of erroring on `""::uuid`. New scoped tables
// must use this form from the start.
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Create (Plan 3): a generated artifact (table / roster / list / doc / draft)
 * produced from one WhatsApp group's messages, plus the per-creation chat
 * transcript (the Create conversation) that drove it. Both tenant-scoped +
 * RLS-forced — mirrors create-suggestions / create-todos / add-todo-meeting-sources.
 *
 *   creations          — one row per creation. `params` holds the needs-panel
 *     inputs; `output_type` + `title` are filled after route() determines them
 *     (NULL until then). status lifecycle: pending → ready | error.
 *   creation_messages  — append-only conversation log for a creation. Each row
 *     carries the FULL per-turn `artifact_snapshot` (populated on assistant
 *     turns that produced an artifact), so the latest snapshot is reconstructed
 *     by reading the newest assistant message. Tenant-scoped + RLS like its parent.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE creations (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      prompt text NOT NULL,
      output_type text
        CHECK (output_type IS NULL OR output_type IN ('table','roster','list','doc','draft')),
      title text,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','ready','error')),
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      model text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX creations_group_idx ON creations (tenant_id, group_id, created_at);

    CREATE TABLE creation_messages (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      creation_id bigint NOT NULL REFERENCES creations(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('user','assistant')),
      content text NOT NULL,
      artifact_snapshot jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX creation_messages_thread_idx
      ON creation_messages (tenant_id, creation_id, created_at);
  `);

  for (const table of ["creations", "creation_messages"]) {
    pgm.sql(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = ${HARDENED_GUC})
        WITH CHECK (tenant_id = ${HARDENED_GUC});
    `);
  }
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS creation_messages;
    DROP TABLE IF EXISTS creations;
  `);
};
