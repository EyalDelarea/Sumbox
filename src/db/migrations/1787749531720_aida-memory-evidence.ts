import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `aida_memory_evidence` — the one ledger linking every memory to the messages
 * behind it, and to whether each of them supports or contradicts the belief.
 *
 * Slice 2 of #83, second half. The four memory tables land in the migration
 * before this one; nothing writes to either yet.
 *
 * WHY A BELIEF MUST NAME ITS SOURCES. The failure this exists to prevent has
 * already happened here: @Aida asserted a confrontation that no message
 * supported, then re-retrieved her own assertion as evidence for it. A belief
 * that cannot be traced back to real messages is unfalsifiable, which means it
 * cannot be checked and cannot be withdrawn by the person it is about.
 *
 * WHY ONE POLYMORPHIC LEDGER rather than four evidence tables. The alternative is
 * four foreign keys pointing at four tables, which is four places to forget when
 * a fifth memory kind arrives. `(memory_type, memory_id)` cannot be enforced by a
 * foreign key and that is accepted deliberately — confined to this one table so
 * it stays a known exception rather than becoming a pattern. `memory_type` is a
 * CHECK-constrained closed set so at least the type half cannot drift.
 *
 * WHAT KEEPS IT HONEST WITHOUT AN FK. The write path never deletes a memory row
 * (append + supersede + revoke, see the previous migration), so ordinary use
 * cannot leave a dangling `memory_id`. Bulk removal goes the other way round:
 * `messages` is deleted first and this table cascades from it, and the memory
 * tables cascade from `groups`.
 *
 * ONE PATH DOES DELETE MEMORY ROWS, and it has to clear this table itself.
 * `mergeGroups` moves the duplicate chat's messages onto the survivor with their
 * ids PRESERVED and then deletes the duplicate group, so the memory rows cascade
 * away while every evidence row citing a moved message survives — the cascade
 * from `messages` never fires, because those messages were not deleted. That is
 * the whole reason the merge clears this table explicitly before the group delete.
 * Any future path that deletes a memory row inherits the same obligation; there is
 * no constraint that will remind it.
 *
 * NO `group_id` HERE, deliberately. Every evidence row cites a message, and the
 * write path only accepts messages from the memory's own group — so the group is
 * already implied, and a second copy of it could only ever disagree with the
 * first. It also keeps this table out of the group-purge classification guard,
 * where it would have to be listed for a scoping column it does not need.
 *
 * NO CONFIDENCE SCORE ANYWHERE, here or on a memory. How much weight a belief
 * carries is derived at read time from this ledger: how many messages support it,
 * how many contradict it, and how recent they are. That is inspectable; a number
 * a model wrote at temperature 1.0 is not.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("aida_memory_evidence", {
    /**
     * Which of the four tables `memory_id` points into. The one polymorphic
     * reference in this schema; closed-set constrained below.
     */
    memory_type: { type: "text", notNull: true },
    memory_id: { type: "bigint", notNull: true },
    message_id: {
      type: "bigint",
      notNull: true,
      references: "messages(id)",
      onDelete: "CASCADE",
    },
    /**
     * Whether this message argues FOR the belief or AGAINST it.
     *
     * Contradiction is recorded rather than dropped so that a belief the chat
     * argues against is visibly weak at read time instead of silently equal to a
     * well-supported one.
     */
    stance: { type: "text", notNull: true },
    /** The cited message's own timestamp, so recency needs no join to rank. */
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("aida_memory_evidence", "aida_memory_evidence_type_closed_set", {
    check: "memory_type IN ('episodic', 'semantic', 'relational', 'self_state')",
  });
  pgm.addConstraint("aida_memory_evidence", "aida_memory_evidence_stance_closed_set", {
    check: "stance IN ('supports', 'contradicts')",
  });

  // One stance per (memory, message): a single message cannot both support and
  // contradict the same belief, and citing it twice is one citation. Also the
  // primary key, which is exactly the lookup the read path needs — all evidence
  // for a given memory — so no separate index for it.
  pgm.addConstraint("aida_memory_evidence", "aida_memory_evidence_pkey", {
    primaryKey: ["memory_type", "memory_id", "message_id"],
  });

  // The reverse direction: which beliefs cite this message. Needed for the
  // cascade above to be cheap, and for tracing a bad memory back from a message.
  pgm.createIndex("aida_memory_evidence", ["message_id"], {
    name: "aida_memory_evidence_message_idx",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("aida_memory_evidence");
}
