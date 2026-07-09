import type { MigrationBuilder } from "node-pg-migrate";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE group_command_permissions (
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      command text NOT NULL DEFAULT 'summary',
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, group_id, command)
    );

    ALTER TABLE group_command_permissions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE group_command_permissions FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON group_command_permissions
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS group_command_permissions");
};
