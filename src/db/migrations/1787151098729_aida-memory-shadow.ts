import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * @Aida's memory, shadow phase — nothing reads these tables yet.
 *
 * The design rule is that the safety properties live in CONSTRAINTS, not in
 * prompt text. A prompt rule can be argued with by a model under pressure; a
 * NOT NULL cannot.
 *
 * - `group_id NOT NULL` — memory is per-group, matching the retrieval boundary.
 *   "Royi in group 70" and "Royi in group 805" are different people as far as
 *   she is concerned, which is both the privacy guarantee and the truer model.
 * - `source_message_id NOT NULL` — every memory cites a real message. On
 *   2026-08-19 she asserted a confrontation between two people under a leading
 *   question, with ZERO messages supporting it; with this column that claim is
 *   not "discouraged", it is unwritable, because there is nothing to cite.
 * - `speaker_participant_id` is the sender of the cited message (enforced by the
 *   writer, see db/repositories/aida-memory.ts). Every row therefore means
 *   "X said this on date D" — the D4 decision, "attributed observations only".
 *   Derived traits and evaluations have no shape to occupy here.
 * - Append-only. Revocation is a tombstone (`revoked_at`), never an UPDATE, so a
 *   bad extraction run can be undone wholesale and the audit trail survives.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("aida_observations", {
    id: { type: "bigserial", primaryKey: true },
    group_id: {
      type: "bigint",
      notNull: true,
      references: "groups(id)",
      onDelete: "CASCADE",
    },
    speaker_participant_id: {
      type: "bigint",
      notNull: true,
      references: "participants(id)",
      onDelete: "CASCADE",
    },
    // The citation. NOT NULL is the whole safety model.
    source_message_id: {
      type: "bigint",
      notNull: true,
      references: "messages(id)",
      onDelete: "CASCADE",
    },
    content: { type: "text", notNull: true },
    // md5 of the normalized content, so re-running extraction over the same
    // window converges instead of writing duplicates on every summary run.
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
  // The read path (slice 2) wants live memories for one group, newest first.
  pgm.createIndex("aida_observations", ["group_id", "observed_at"], {
    name: "aida_observations_group_observed_idx",
    where: "revoked_at IS NULL",
  });

  /**
   * Directives — things the group explicitly asked her to do differently.
   *
   * The CHECK is the D2 decision made literal: a closed verb set means privilege
   * escalation has no representation, so a planted "ignore your rules" cannot be
   * stored no matter how the extractor is fooled. Widening this set is a
   * migration, which is exactly the amount of friction it deserves.
   */
  pgm.createTable("aida_directives", {
    id: { type: "bigserial", primaryKey: true },
    group_id: {
      type: "bigint",
      notNull: true,
      references: "groups(id)",
      onDelete: "CASCADE",
    },
    verb: { type: "text", notNull: true },
    // NULL = applies to the whole group (e.g. avoid_word); set = about a person.
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

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("aida_directives");
  pgm.dropTable("aida_observations");
}
