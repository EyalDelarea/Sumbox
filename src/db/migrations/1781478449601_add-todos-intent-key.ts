import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Content-identity key for task dedup (#5 spine, spec 021). A normalized,
 * order-independent token-set of the commitment text (see summarization/
 * dedup-keys.ts → intentKey) lets the extractor collapse the same commitment
 * mentioned across several messages into one to-do. Nullable so existing rows
 * (and any to-do whose title normalizes to "") are unaffected; the index backs
 * the per-(group, intent) lookup. Tenant isolation is inherited from the table's
 * existing RLS policy — the column needs no policy of its own.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("todos", {
    intent_key: { type: "text" },
  });
  pgm.createIndex("todos", ["tenant_id", "group_id", "intent_key"], {
    name: "todos_intent_idx",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("todos", ["tenant_id", "group_id", "intent_key"], {
    name: "todos_intent_idx",
  });
  pgm.dropColumn("todos", "intent_key");
}
