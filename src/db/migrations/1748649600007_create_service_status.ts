import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("service_status", {
    id: {
      type: "int",
      primaryKey: true,
      check: "id = 1",
    },
    collector_connected: {
      type: "boolean",
      notNull: true,
      default: false,
    },
    last_heartbeat_at: { type: "timestamptz", notNull: false },
    last_qr_at: { type: "timestamptz", notNull: false },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // Seed the singleton row
  pgm.sql("INSERT INTO service_status (id) VALUES (1)");
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("service_status");
};
