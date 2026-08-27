import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

const MEMORY_TABLES = [
  "aida_episodic_memories",
  "aida_semantic_memories",
  "aida_relational_memories",
  "aida_self_state_memories",
] as const;

/**
 * `correction_note` — why a human overruled her, and the only way to tell that
 * one did.
 *
 * Slice 3b of #83. A forward migration: the tables shipped in
 * `aida-memory-tables` and that file is history now.
 *
 * TWO JOBS, AND THE SECOND IS WHY THE FIRST IS MANDATORY. Correcting a memory
 * writes a new row and points the old one at it, and the new row should say what
 * the reason was — overruling her is a claim of your own. But nothing else in
 * this schema records WHO wrote a row, so an extracted belief and a
 * human-corrected one are indistinguishable, and a screen showing both cannot
 * mark yours. The presence of a note is that mark.
 *
 * Which is exactly why the write path refuses an empty one. If a correction could
 * arrive without a note, a human-written row would look extracted, and the marker
 * would fail on the rows it exists to mark. Nullable in the column, required at
 * the door — the same shape as "a memory cannot exist without evidence", which no
 * foreign key can express either.
 *
 * Nothing backfills. Every row that exists when this runs was written by the
 * extractor, so null is already the right answer for all of them.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  for (const table of MEMORY_TABLES) {
    pgm.addColumn(table, {
      correction_note: { type: "text", notNull: false },
    });
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const table of MEMORY_TABLES) {
    pgm.dropColumn(table, "correction_note");
  }
}
