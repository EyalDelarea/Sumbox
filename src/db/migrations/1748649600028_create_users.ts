import type { MigrationBuilder } from "node-pg-migrate";

/**
 * T2 — users. One account per email across the WHOLE instance (open self-registration):
 * the UNIQUE index on lower(email) is a system constraint and is enforced regardless of
 * RLS, so two tenants can never share an email. Each user belongs to exactly one tenant.
 *
 * tenant_id uses the same COALESCE(GUC, default) default as the T1 tables (migration 023)
 * so an INSERT inside withTenant(A) auto-attributes to A, and RLS (below) rejects a
 * no-context or cross-tenant write (fail-closed).
 *
 * The one legitimate cross-tenant read is login (find user by email before the tenant is
 * known); it runs on the BYPASSRLS operator/admin connection, never the app role.
 */
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(current_setting('app.tenant_id', true)::uuid, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      email text NOT NULL,
      password_hash text NOT NULL,
      email_verified_at timestamptz,
      consent_tos_version text,
      consent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));
    CREATE INDEX users_tenant_idx ON users (tenant_id);

    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE users FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON users
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP TABLE IF EXISTS users;`);
};
