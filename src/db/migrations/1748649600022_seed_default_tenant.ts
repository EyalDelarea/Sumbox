import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Seed the fixed default tenant that owns all data predating T1. Its id is a
 * well-known constant (mirrored by DEFAULT_TENANT_ID in config / tenant-context).
 * Idempotent so re-runs are safe.
 */
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    INSERT INTO tenants (id, name, status)
    VALUES ('${DEFAULT_TENANT_ID}', 'default', 'active')
    ON CONFLICT (id) DO NOTHING
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DELETE FROM tenants WHERE id = '${DEFAULT_TENANT_ID}'`);
};
