import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("media_analyses", {
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
    kind: {
      type: "text",
      notNull: true,
      check: "kind IN ('image', 'video')",
    },
    // Nullable: failed rows carry no description, only error_message.
    description: {
      type: "text",
      notNull: false,
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

  pgm.addConstraint("media_analyses", "media_analyses_message_id_unique", "UNIQUE (message_id)");

  pgm.addConstraint(
    "media_analyses",
    "media_analyses_completed_has_description",
    "CHECK ((status = 'completed' AND description IS NOT NULL) OR status = 'failed')",
  );
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("media_analyses");
};
