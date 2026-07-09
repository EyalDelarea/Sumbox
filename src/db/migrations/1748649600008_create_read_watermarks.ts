import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("read_watermarks", {
    group_id: {
      type: "bigint",
      primaryKey: true,
      references: '"groups"',
      onDelete: "CASCADE",
    },
    watermark_sent_at: {
      type: "timestamptz",
      notNull: true,
    },
    watermark_message_id: {
      type: "bigint",
      notNull: true,
      references: '"messages"',
      onDelete: "CASCADE",
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("read_watermarks");
};
