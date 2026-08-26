import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The four @Aida memory tables — episodic, semantic, relational, self-state.
 *
 * Slice 2 of #83. Nothing reads or writes these yet: the schema lands ahead of
 * both the extractor (slice 4) and the read path (slice 5), with the visibility
 * slice (3) following immediately so the first memory ever written is already
 * inspectable and deletable.
 *
 * WHY FOUR TABLES rather than one claim table with a polymorphic subject: the
 * subjects genuinely differ. An episodic memory may be about the group at large
 * and have no subject; a semantic one has exactly one; a relational one has two
 * or more. A shared table could not constrain any of those honestly — it would
 * have to make every subject column nullable and enforce the real shape in code.
 * The cost accepted is four retrieval paths and four supersede chains.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *  - `tenant_id`. Every memory-era table omits it. The remnants elsewhere in this
 *    schema are inert history (see CLAUDE.md) and must not be built on.
 *  - A confidence score. A number written by a model running at temperature 1.0
 *    is unfalsifiable and unreproducible — measured on this stack, the ask path
 *    runs at the default 1.0 and the eval harness spans a wide range run-to-run
 *    on unchanged code. Weight is DERIVED at read time from the evidence ledger.
 *  - Any UPDATE-in-place affordance. A belief is replaced by inserting a newer row
 *    and pointing the old one at it (`superseded_by_id`); a bad belief is made
 *    unusable by stamping `revoked_at`, never by deletion. Post-hoc cleanup is the
 *    entire safety model for this feature, and that only works if the record of a
 *    mistake outlives the mistake.
 *
 * SUBJECTS ARE JIDs, NOT PARTICIPANT IDS. `participants` is keyed on display_name
 * (self-chosen, not unique), so two different people sharing a WhatsApp name
 * collapse into one row — a fine key for a roster, an unacceptable one for a
 * belief about a person. Author identity lives on `messages.sender_jid`
 * (migration 1784288081956), and that is what a subject stores, canonicalized
 * through `identity_links` at write time so one human reached by two WhatsApp
 * identities is one subject. Not `participants.whatsapp_id`, which is dormant.
 *
 * GROUP IS MANDATORY EVERYWHERE. Memory is per-group: that is the privacy
 * boundary, and also the truer model, since the same person in two chats is two
 * people as far as @Aida is concerned.
 */

/** Columns every memory table shares, whatever kind of claim it holds. */
function commonColumns(pgm: MigrationBuilder, selfTable: string): ColumnDefinitions {
  return {
    id: { type: "bigserial", primaryKey: true },
    group_id: { type: "bigint", notNull: true, references: "groups(id)", onDelete: "CASCADE" },
    /** The belief itself, in words. Phrased as an interpretation, never as history. */
    content: { type: "text", notNull: true },
    /** md5 over normalized content — the dedupe key, so re-extraction converges. */
    content_hash: { type: "text", notNull: true },
    /** When the cited messages happened. Derived from them, never supplied. */
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    /**
     * The newer row that replaced this one. Self-referencing, so a supersede
     * chain can never cross from an event to a trait and become unfollowable.
     */
    superseded_by_id: {
      type: "bigint",
      notNull: false,
      references: `${selfTable}(id)`,
      onDelete: "SET NULL",
    },
    /** Stamped to make a belief unusable while leaving the record of it intact. */
    revoked_at: { type: "timestamptz", notNull: false },
    revoked_by_participant_id: {
      type: "bigint",
      notNull: false,
      references: "participants(id)",
      onDelete: "SET NULL",
    },
  };
}

/**
 * The default read wants live rows for one group, newest first. Partial on both
 * withdrawal columns, since that read never wants a revoked or superseded row.
 */
function liveIndex(pgm: MigrationBuilder, table: string): void {
  pgm.createIndex(table, ["group_id", "observed_at"], {
    name: `${table}_live_idx`,
    where: "revoked_at IS NULL AND superseded_by_id IS NULL",
  });
}

/**
 * The dedupe key, which is what makes re-running extraction over the same window
 * converge instead of writing a new row per run.
 *
 * PARTIAL ON `superseded_by_id IS NULL`, and the predicate carries real meaning.
 * A belief she has since replaced must be re-formable: if the chat starts saying
 * the old thing again, that is a new observation with new messages behind it, and
 * a total index would make the belief permanently unwritable in that group —
 * silently, since the write would report success onto the superseded row.
 *
 * A REVOKED row is NOT excluded, deliberately. It keeps occupying its slot, so
 * re-extraction converges onto the withdrawn belief and adds nothing. Revocation
 * is sticky by construction rather than by a filter someone has to remember, and
 * that asymmetry between revoked and superseded is the whole point of the
 * predicate being written this narrowly.
 *
 * A raw index rather than a UNIQUE constraint because a constraint cannot be
 * partial — and, for the episodic case, because Postgres treats NULLs as distinct
 * in a unique index by default, so `NULLS NOT DISTINCT` is needed or every
 * re-extraction would insert another copy of the same subject-less event.
 */
function dedupeIndex(pgm: MigrationBuilder, table: string, subjectColumn: string): void {
  pgm.sql(`
    CREATE UNIQUE INDEX ${table}_dedupe
      ON ${table} (group_id, ${subjectColumn}, content_hash) NULLS NOT DISTINCT
      WHERE superseded_by_id IS NULL;
  `);
}

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ── Relational subject canonicalization ──────────────────────────────────
  // "Ron and Eyal" and "Eyal and Ron" are ONE relationship, and the schema must
  // not permit two rows for it. Enforcing that structurally means the stored
  // array has to be in a canonical form, which needs a sort — and a CHECK cannot
  // contain a subquery or an aggregate, so the sort lives in a function.
  //
  // `array_sort()` would do this without a function, but it is Postgres 18 and
  // this stack is pinned to pg16 (docker-compose.yml, and pgvector:pg16 in the
  // test harness).
  //
  // COLLATE "C" is not cosmetic. Text ordering under the default collation moves
  // when the image's glibc/ICU moves — the exact hazard that pinned the Postgres
  // image by digest (see docker-compose.yml and ops/runbooks/collation-corruption.md).
  // A collation-dependent sort inside an IMMUTABLE function would be a lie, and
  // would silently un-canonicalize existing rows on a base-image bump. Byte order
  // never moves.
  //
  // The function also rejects duplicates and NULL elements: `count(DISTINCT x)`
  // ignores NULLs, so an array containing one fails the length comparison.
  //
  // COALESCE around `array_length` is load-bearing, not defensive. An empty array
  // has a NULL length, `NULL >= 2` is NULL, and a CHECK that evaluates to NULL
  // PASSES — so without it a relational memory about nobody would be accepted by
  // the one constraint written to make that impossible.
  pgm.sql(`
    CREATE FUNCTION aida_jid_array_is_canonical(a text[]) RETURNS boolean
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
        SELECT COALESCE(array_length(a, 1), 0) >= 2
           AND a = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(a) AS u(x))
           AND COALESCE(array_length(a, 1), 0) = (SELECT count(DISTINCT x) FROM unnest(a) AS u(x))
      $$;
  `);

  // ── Episodic — something that happened ───────────────────────────────────
  // The only table whose subject is optional: an event may be about the group at
  // large ("the trip got moved to Sunday") and belong to nobody in particular.
  pgm.createTable("aida_episodic_memories", {
    ...commonColumns(pgm, "aida_episodic_memories"),
    subject_jid: { type: "text", notNull: false },
  });
  dedupeIndex(pgm, "aida_episodic_memories", "subject_jid");
  liveIndex(pgm, "aida_episodic_memories");

  // ── Semantic — a lasting pattern about one person ────────────────────────
  pgm.createTable("aida_semantic_memories", {
    ...commonColumns(pgm, "aida_semantic_memories"),
    subject_jid: { type: "text", notNull: true },
  });
  dedupeIndex(pgm, "aida_semantic_memories", "subject_jid");
  liveIndex(pgm, "aida_semantic_memories");

  // ── Relational — a lasting pattern between people ────────────────────────
  pgm.createTable("aida_relational_memories", {
    ...commonColumns(pgm, "aida_relational_memories"),
    subject_jids: { type: "text[]", notNull: true },
  });
  pgm.addConstraint("aida_relational_memories", "aida_relational_memories_subjects_canonical", {
    check: "aida_jid_array_is_canonical(subject_jids)",
  });
  // Array equality is order-sensitive, which is exactly what makes this dedupe
  // work: the CHECK above guarantees the stored order is canonical, so two rows
  // for the same set of people are impossible rather than merely discouraged.
  dedupeIndex(pgm, "aida_relational_memories", "subject_jids");
  liveIndex(pgm, "aida_relational_memories");

  // ── Self-state — what she holds about herself, and how to behave ─────────
  // No subject; it is always about @Aida.
  pgm.createTable("aida_self_state_memories", {
    ...commonColumns(pgm, "aida_self_state_memories"),
    /**
     * Knowledge about herself, or a rule for how she should behave.
     *
     * A closed set, and the one place this schema still has one. `aida_directives`
     * carried a CHECK over a closed VERB set, which made a planted behaviour
     * instruction unwritable rather than merely visible; #83 gives that up
     * knowingly and makes behaviour memory free-form, contained after the fact by
     * a blast-radius log and a revoke command (slice 3). What survives here is
     * only the distinction itself — the read path forces behaviour into every
     * turn and treats knowledge as retrievable, so it has to be able to tell them
     * apart, and a column says so where a naming convention would not.
     */
    facet: { type: "text", notNull: true },
  });
  pgm.addConstraint("aida_self_state_memories", "aida_self_state_memories_facet_closed_set", {
    check: "facet IN ('knowledge', 'behaviour')",
  });
  dedupeIndex(pgm, "aida_self_state_memories", "facet");
  liveIndex(pgm, "aida_self_state_memories");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("aida_self_state_memories");
  pgm.dropTable("aida_relational_memories");
  pgm.dropTable("aida_semantic_memories");
  pgm.dropTable("aida_episodic_memories");
  // After the tables — the CHECK on aida_relational_memories depends on it.
  pgm.sql(`DROP FUNCTION aida_jid_array_is_canonical(text[]);`);
}
