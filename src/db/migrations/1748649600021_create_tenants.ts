import type { MigrationBuilder } from "node-pg-migrate";

/**
 * T1 tenancy foundation — the `tenants` table: the unit of data ownership.
 * `gen_random_uuid()` is built into Postgres 13+ (no extension required on PG16).
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("tenants", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    name: {
      type: "text",
      notNull: true,
    },
    status: {
      type: "text",
      notNull: true,
      default: "active",
      check: "status IN ('active', 'suspended', 'deleted')",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    deleted_at: {
      type: "timestamptz",
      notNull: false,
    },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("tenants");
};
