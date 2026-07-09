import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("job_runs", {
    id: { type: "uuid", primaryKey: true },
    type: {
      type: "text",
      notNull: true,
      check: "type IN ('import.file', 'transcribe.voicenote')",
    },
    status: {
      type: "text",
      notNull: true,
      check: "status IN ('pending', 'running', 'done', 'failed', 'dead')",
    },
    payload: { type: "jsonb", notNull: true },
    attempts: { type: "int", notNull: true, default: 0 },
    max_attempts: { type: "int", notNull: true },
    last_error: { type: "text", notNull: false },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createIndex("job_runs", ["status"]);
  pgm.createIndex("job_runs", ["type", "status"]);
  pgm.createIndex("job_runs", ["created_at"]);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("job_runs");
};
