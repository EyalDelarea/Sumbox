import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("message_media", {
    id: { type: "bigserial", primaryKey: true },
    message_id: {
      type: "bigint",
      notNull: true,
      references: '"messages"',
      onDelete: "CASCADE",
    },
    media_kind: {
      type: "text",
      notNull: true,
      check: "media_kind IN ('image', 'video', 'audio', 'sticker', 'document')",
    },
    mime_type: { type: "text", notNull: false },
    media_key: { type: "bytea", notNull: false },
    direct_path: { type: "text", notNull: false },
    url: { type: "text", notNull: false },
    file_enc_sha256: { type: "bytea", notNull: false },
    file_sha256: { type: "bytea", notNull: false },
    media_key_ts: { type: "bigint", notNull: false },
    file_length: { type: "bigint", notNull: false },
    wa_message: { type: "bytea", notNull: false },
    download_state: {
      type: "text",
      notNull: true,
      default: "pending",
      check: "download_state IN ('pending', 'present', 'unrecoverable', 'pruned')",
    },
    attempts: { type: "integer", notNull: true, default: 0 },
    last_error: { type: "text", notNull: false },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("message_media", "message_media_message_id_unique", "UNIQUE (message_id)");

  pgm.createIndex("message_media", ["download_state"], {
    name: "message_media_download_state_idx",
    where: "download_state = 'pending'",
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("message_media");
};
