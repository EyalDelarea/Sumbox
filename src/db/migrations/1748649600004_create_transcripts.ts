import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("transcripts", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    message_id: {
      type: "bigint",
      notNull: true,
      references: '"messages"',
      onDelete: "CASCADE",
    },
    // Nullable: failed rows (FR-013) carry no transcript text, only error_message.
    transcript: {
      type: "text",
      notNull: false,
    },
    language: {
      type: "text",
      notNull: true,
      default: "he",
    },
    engine: {
      type: "text",
      notNull: true,
    },
    status: {
      type: "text",
      notNull: true,
      check: "status IN ('completed', 'failed')",
    },
    error_message: {
      type: "text",
      notNull: false,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("transcripts", "transcripts_message_id_unique", "UNIQUE (message_id)");

  pgm.addConstraint(
    "transcripts",
    "transcripts_completed_has_text",
    "CHECK ((status = 'completed' AND transcript IS NOT NULL) OR status = 'failed')",
  );
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("transcripts");
};
