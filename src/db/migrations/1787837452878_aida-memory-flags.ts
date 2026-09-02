import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `aida_memory_flags` — beliefs the repair pass could not support and will not
 * delete.
 *
 * The repair pass re-reads each stored belief against only the messages it
 * cites. Where the belief is wrong it writes a correction, which supersedes and
 * stays visible. Where NOTHING it says survives the citations, the honest verdict
 * is that the belief should go — but the pass is not allowed to act on that.
 * Measured on group 70, its drop verdicts included two beliefs that were true and
 * that it had misread; an automatic revoke would have destroyed both with no
 * surface saying so. A flag is the same verdict rendered reversible.
 *
 * KEYED LIKE THE EVIDENCE LEDGER, `(memory_type, memory_id)`, because the four
 * memory tables have four independent sequences and an id alone means nothing
 * across them. One flag per belief: a second pass re-raising the same doubt is
 * not new information, so it updates the reason rather than accumulating rows.
 *
 * NO FOREIGN KEY, for the same reason the evidence ledger's memory side has
 * none: a polymorphic reference cannot have one. Ordinary belief-lifecycle
 * operations (revoke, supersede) never delete a memory row — but three
 * production paths DO delete memory rows outright, and each one is responsible
 * for deleting this table's matching flags FIRST, the same way it already
 * clears matching `aida_memory_evidence` rows: `mergeGroups`
 * (src/db/repositories/merge.ts) drops a duplicate chat's memories on merge;
 * `purgeUnselectedChats` (src/db/repositories/data-deletion.ts) drops a chat's
 * memories when it falls out of selection; `deleteAllData` (same file) drops
 * every memory on a full wipe (unconditional there — no group to scope to).
 * Miss one and a flag outlives the belief it doubts, keyed to a
 * `(memory_type, memory_id)` pair nothing else in the schema still occupies.
 *
 * CLEARED BY DELETION. A flag is an open question; answering it (revoking the
 * belief, or deciding it stands) removes the row. Keeping resolved flags would
 * turn the operator's list into an archive nobody reads.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("aida_memory_flags", {
    memory_type: { type: "text", notNull: true },
    memory_id: { type: "bigint", notNull: true },
    /** Why the pass could not support it, in its own words. */
    reason: { type: "text", notNull: true },
    flagged_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("aida_memory_flags", "aida_memory_flags_pkey", {
    primaryKey: ["memory_type", "memory_id"],
  });
  // The same closed set the evidence ledger enforces. A flag against a type that
  // does not exist would never be shown and never be answered.
  pgm.addConstraint("aida_memory_flags", "aida_memory_flags_type_closed_set", {
    check: "memory_type IN ('episodic', 'semantic', 'relational', 'self_state')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("aida_memory_flags");
}
