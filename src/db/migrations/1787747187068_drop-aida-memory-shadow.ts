import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Drop the shadow-phase memory schema — `aida_observations` / `aida_directives`.
 *
 * A forward migration, not an edit to `1787151098729_aida-memory-shadow.ts`.
 * Historical `up`/`down` are never rewritten here; the tenancy/RLS removal set
 * that precedent and this follows it.
 *
 * These tables are shaped for a design that has been superseded (see #83). The
 * replacement is four typed memory tables plus a shared evidence ledger, which
 * arrives in the next slice — so the ground is cleared first, deliberately, so
 * that two competing memory schemas never coexist in one database.
 *
 * NO DATA IS MIGRATED, and nothing is lost by that. The shadow phase never ran:
 * `ASK_MEMORY_SHADOW` was absent from `.env`, so `memoryShadow` was false and
 * `extractMemory` false on every scheduled run. Zero rows were ever written by
 * the job. Rows written by ad-hoc `aida-memory --extract` runs are dropped on
 * purpose: they are shaped for the superseded design, and the new schema's first
 * row should come from the new extractor.
 *
 * `aida_directives` is the one part of this that gives something up, and it is
 * worth recording. Its CHECK constraint restricted behaviour rules to a closed
 * verb set, which made a planted instruction outside that set UNWRITABLE rather
 * than merely visible. #83 gives that up knowingly, in exchange for free-form
 * behaviour memory contained after the fact by a blast-radius log and a revoke
 * command. Worth knowing when reading this later: the table shipped with its
 * constraint and NO repository code behind it, so nothing that ever ran is being
 * removed — only a design that was never wired up.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("aida_directives");
  pgm.dropTable("aida_observations");
}

/**
 * Recreates both tables exactly as `1787151098729_aida-memory-shadow.ts` left
 * them, so a `down` lands on the schema this migration found.
 *
 * Reversibility is structural only. The rows are not coming back — see above.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("aida_observations", {
    id: { type: "bigserial", primaryKey: true },
    group_id: { type: "bigint", notNull: true, references: "groups(id)", onDelete: "CASCADE" },
    speaker_participant_id: {
      type: "bigint",
      notNull: true,
      references: "participants(id)",
      onDelete: "CASCADE",
    },
    source_message_id: {
      type: "bigint",
      notNull: true,
      references: "messages(id)",
      onDelete: "CASCADE",
    },
    content: { type: "text", notNull: true },
    content_hash: { type: "text", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    revoked_at: { type: "timestamptz", notNull: false },
    revoked_by_participant_id: {
      type: "bigint",
      notNull: false,
      references: "participants(id)",
      onDelete: "SET NULL",
    },
  });
  pgm.addConstraint("aida_observations", "aida_observations_dedupe", {
    unique: ["group_id", "source_message_id", "content_hash"],
  });
  pgm.createIndex("aida_observations", ["group_id", "observed_at"], {
    name: "aida_observations_group_observed_idx",
    where: "revoked_at IS NULL",
  });

  pgm.createTable("aida_directives", {
    id: { type: "bigserial", primaryKey: true },
    group_id: { type: "bigint", notNull: true, references: "groups(id)", onDelete: "CASCADE" },
    verb: { type: "text", notNull: true },
    subject_participant_id: {
      type: "bigint",
      notNull: false,
      references: "participants(id)",
      onDelete: "CASCADE",
    },
    value: { type: "text", notNull: true },
    source_message_id: {
      type: "bigint",
      notNull: true,
      references: "messages(id)",
      onDelete: "CASCADE",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    revoked_at: { type: "timestamptz", notNull: false },
    revoked_by_participant_id: {
      type: "bigint",
      notNull: false,
      references: "participants(id)",
      onDelete: "SET NULL",
    },
  });
  pgm.addConstraint("aida_directives", "aida_directives_verb_closed_set", {
    check: "verb IN ('avoid_word', 'tone', 'address_as')",
  });
  pgm.addConstraint("aida_directives", "aida_directives_dedupe", {
    unique: ["group_id", "verb", "subject_participant_id", "value"],
  });
}
