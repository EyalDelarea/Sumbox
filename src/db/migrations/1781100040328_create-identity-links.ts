import type { MigrationBuilder } from "node-pg-migrate";

// Mirror of the default tenant id seeded in migration 022 (the FK target that
// actually exists). Used as the column default when no app.tenant_id GUC is set.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE identity_links (
      id         bigserial PRIMARY KEY,
      tenant_id  uuid NOT NULL
        DEFAULT COALESCE(current_setting('app.tenant_id', true)::uuid, '${DEFAULT_TENANT_ID}'),
      lid_jid    text NOT NULL,
      pn_jid     text NOT NULL,
      source     text NOT NULL CHECK (source IN ('message_alt', 'bridge')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT identity_links_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );

    CREATE UNIQUE INDEX identity_links_tenant_lid_uniq ON identity_links (tenant_id, lid_jid);
    CREATE UNIQUE INDEX identity_links_tenant_pn_uniq  ON identity_links (tenant_id, pn_jid);

    ALTER TABLE identity_links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE identity_links FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON identity_links
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON identity_links;
    DROP TABLE IF EXISTS identity_links;
  `);
};
