import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS scheduler_state (
      slot_key    TEXT PRIMARY KEY,
      last_run_at TIMESTAMPTZ NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("scheduler_state");
};
