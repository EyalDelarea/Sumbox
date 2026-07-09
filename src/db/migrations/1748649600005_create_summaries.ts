import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("summaries", {
    id: { type: "bigserial", primaryKey: true },
    group_id: {
      type: "bigint",
      notNull: true,
      references: '"groups"',
      onDelete: "CASCADE",
    },
    summary_type: {
      type: "text",
      notNull: true,
      check: "summary_type IN ('last_n', 'since')",
    },
    parameters: { type: "jsonb", notNull: true },
    output: { type: "jsonb", notNull: true },
    model: { type: "text", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("summaries");
};
