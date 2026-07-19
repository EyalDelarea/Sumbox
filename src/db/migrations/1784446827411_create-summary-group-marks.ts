import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `summary_group_marks` — the single shared `/סיכום` cursor for a group.
 *
 * Replaces the per-participant `summary_user_marks`. With a cursor per person,
 * every member carried a private catch-up window, so the same conversation was
 * re-summarized once per asker at ever-widening ranges — a member who had not
 * asked in a week got a week-wide summary minutes after someone else got an
 * hour-wide one. One row per group collapses that to a single window.
 *
 * Only the `/סיכום` command writes here. The window deliberately does NOT read
 * `summaries.created_at`: the scheduled twice-daily digest also inserts summary
 * rows, and anchoring on that table would let a 9am digest silently shrink the
 * next manual window.
 *
 * `last_summary_id` / `last_reply_wa_message_id` carry the quote-threading
 * pointers the per-user table used to hold, so the reply chains the GROUP's
 * previous summary and survives a restart.
 *
 * No tenant_id: the tenancy remnants are inert (see CLAUDE.md) and must not be
 * built on. Cleanup rides `groups`' ON DELETE CASCADE, exactly like
 * `aida_messages`.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE summary_group_marks (
      group_id                 bigint      NOT NULL PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      last_summarized_at       timestamptz NOT NULL,
      last_summary_id          bigint      REFERENCES summaries(id) ON DELETE SET NULL,
      last_reply_wa_message_id text,
      updated_at               timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS summary_group_marks;`);
}
