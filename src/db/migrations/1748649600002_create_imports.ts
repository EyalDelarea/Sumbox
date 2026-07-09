import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("imports", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    group_id: {
      type: "bigint",
      notNull: true,
      references: '"groups"',
      onDelete: "RESTRICT",
    },
    source_path: {
      type: "text",
      notNull: true,
    },
    source_hash: {
      type: "text",
      notNull: true,
    },
    original_file_path: {
      type: "text",
      notNull: true,
    },
    status: {
      type: "text",
      notNull: true,
      check: "status IN ('pending', 'completed', 'failed')",
    },
    error_message: {
      type: "text",
      notNull: false,
    },
    imported_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("imports");
};
