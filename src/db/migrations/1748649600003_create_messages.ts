import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("messages", {
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
    participant_id: {
      type: "bigint",
      notNull: false,
      references: '"participants"',
      onDelete: "RESTRICT",
    },
    import_id: {
      type: "bigint",
      notNull: false,
      references: '"imports"',
      onDelete: "SET NULL",
    },
    source: {
      type: "text",
      notNull: true,
      check: "source IN ('import', 'live')",
    },
    external_id: {
      type: "text",
      notNull: false,
    },
    message_type: {
      type: "text",
      notNull: true,
      check: "message_type IN ('text', 'media', 'system')",
    },
    text_content: {
      type: "text",
      notNull: false,
    },
    media_filename: {
      type: "text",
      notNull: false,
    },
    media_path: {
      type: "text",
      notNull: false,
    },
    media_status: {
      type: "text",
      notNull: false,
      check: "media_status IN ('present', 'missing') OR media_status IS NULL",
    },
    sent_at: {
      type: "timestamptz",
      notNull: true,
    },
    dedupe_key: {
      type: "text",
      notNull: true,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // Primary dedupe constraint (SC-002)
  pgm.addConstraint(
    "messages",
    "messages_group_dedupe_key_unique",
    "UNIQUE (group_id, dedupe_key)",
  );

  // Secondary partial unique index for live messages with external_id
  // A partial unique index enforces UNIQUE (group_id, external_id) WHERE external_id IS NOT NULL
  pgm.createIndex("messages", ["group_id", "external_id"], {
    name: "messages_group_external_id_unique",
    unique: true,
    where: "external_id IS NOT NULL",
  });

  // Index for "last N" / "since" selection
  pgm.createIndex("messages", ["group_id", "sent_at"], {
    name: "messages_group_id_sent_at_idx",
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("messages");
};
