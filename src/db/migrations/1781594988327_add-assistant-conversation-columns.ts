import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Spec 023 — merge Ask (שאל) + Create (צור) into העוזר (The Assistant): a
 * `creations` row becomes a generic CONVERSATION holding answer OR artifact
 * turns. Additive only — existing Create rows keep working (status/output_type
 * unchanged). Tenant isolation is inherited from each table's existing RLS
 * policy; the new columns need no policy of their own.
 *
 *   creations.scope_kind / scope_chat_name — conversation scope. 'group' (the
 *     existing single-group Create behavior) vs 'global' (cross-chat Ask). Old
 *     rows default to 'group'. scope_chat_name caches the display label so the
 *     history list renders without a groups join (and so a deleted group still
 *     shows a name).
 *   creations.unread — an assistant turn settled while the user was NOT viewing
 *     this conversation; drives the bell badge + "new result" dot. Cleared on open.
 *   creations.group_id — relaxed to NULLABLE: a cross-chat answer thread has no
 *     single group. Build turns still resolve a concrete group (Option A).
 *   creation_messages.kind — 'artifact' (a build turn) vs 'answer' (a cited Ask
 *     turn). Old assistant rows are artifact turns by default.
 *   creation_messages.citations — Ask answer sources ([{n,messageId,chat,...}]);
 *     null on artifact turns (those carry artifact_snapshot instead).
 *   creation_messages.rating — per-turn 👍/👎: 1 | -1, null = unrated.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("creations", {
    scope_kind: {
      type: "text",
      notNull: true,
      default: "group",
      check: "scope_kind IN ('group','global')",
    },
    scope_chat_name: { type: "text" },
    unread: { type: "boolean", notNull: true, default: false },
  });
  // Cross-chat answer threads have no single group. Existing Create rows are
  // already non-null, so relaxing the constraint is data-safe.
  pgm.alterColumn("creations", "group_id", { notNull: false });

  pgm.addColumns("creation_messages", {
    kind: {
      type: "text",
      notNull: true,
      default: "artifact",
      check: "kind IN ('artifact','answer')",
    },
    citations: { type: "jsonb" },
    rating: {
      type: "smallint",
      check: "rating IS NULL OR rating IN (1, -1)",
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("creation_messages", ["rating", "citations", "kind"]);
  pgm.alterColumn("creations", "group_id", { notNull: true });
  pgm.dropColumns("creations", ["unread", "scope_chat_name", "scope_kind"]);
}
