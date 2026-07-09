import type { MigrationBuilder } from "node-pg-migrate";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * People (S7): a derived CRM projection over participants — one row per person
 * the engine surfaced (status, last-contact, open-threads, next-step). Tenant-
 * scoped + RLS-forced. Idempotent upsert on (tenant_id, participant_id);
 * rebuildable from summaries.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE people (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      participant_id bigint NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','cold-lead','warm','dormant')),
      last_contact_at timestamptz,
      open_threads integer NOT NULL DEFAULT 0,
      next_step text,
      next_step_source_message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT people_tenant_participant_unique UNIQUE (tenant_id, participant_id)
    );
    CREATE INDEX people_status_idx ON people (tenant_id, status);
    CREATE INDEX people_last_contact_idx ON people (tenant_id, last_contact_at DESC);

    ALTER TABLE people ENABLE ROW LEVEL SECURITY;
    ALTER TABLE people FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON people
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS people");
};
