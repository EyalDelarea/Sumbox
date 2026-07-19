import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Drop `summary_user_marks` — superseded by `summary_group_marks`.
 *
 * The per-participant cursor is what made /סיכום summaries bloated: each member
 * carried a private window, so the same conversation was re-summarized once per
 * asker, at ever-widening ranges. The group marker replaced it wholesale,
 * including the quote-threading pointers, leaving this table with no reader.
 *
 * Removal is a forward migration, never an edit to the historical `up` (see
 * CLAUDE.md). `down` restores the STRUCTURE only — the rows are gone. That is
 * accepted: the replacement's cold start is a last-N window, so a restored
 * cursor would not be read anyway.
 *
 * RLS is deliberately NOT recreated in `down`. The original `up` enabled it, but
 * RLS was removed repo-wide by 1783689576346_drop-rls-policies; reinstating it
 * here would resurrect a dropped concept on a rollback.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS summary_user_marks;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS summary_user_marks (
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                         '00000000-0000-0000-0000-000000000001')
        REFERENCES tenants(id),
      group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      participant_id bigint NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      last_summarized_at timestamptz NOT NULL,
      last_summary_id bigint REFERENCES summaries(id) ON DELETE SET NULL,
      last_reply_wa_message_id text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, group_id, participant_id)
    );
  `);
}
