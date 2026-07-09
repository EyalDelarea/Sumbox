import type { MigrationBuilder } from "node-pg-migrate";

// Total summary (סיכום כללי): one aggregate digest across ALL chats for a time
// range. Kept in its own table because the per-group `summaries` table has a
// NOT NULL group_id FK; an aggregate row has no single group.
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("total_summaries", {
    id: { type: "bigserial", primaryKey: true },
    range_kind: {
      type: "text",
      notNull: true,
      check: "range_kind IN ('since', 'scheduled')",
    },
    // { since: ISO8601 }
    parameters: { type: "jsonb", notNull: true },
    // { highlights: "<md>", perChat: [ {groupId, name, messageCount, summary:"<md>"} ] }
    output: { type: "jsonb", notNull: true },
    model: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("total_summaries");
};
