import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Content-identity key for meeting dedup (#5 spine, spec 021). Stores the
 * normalized topic token-set (summarization/dedup-keys.ts → topicKey) so the
 * same meeting mentioned across messages — matched on topic + a ±2h start
 * window in the chat — collapses to one row instead of duplicating. Nullable so
 * existing rows are unaffected; the index backs the per-(group, topic) lookup.
 * Tenant isolation is inherited from the table's existing RLS policy.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("meetings", {
    topic_key: { type: "text" },
  });
  pgm.createIndex("meetings", ["tenant_id", "group_id", "topic_key"], {
    name: "meetings_topic_idx",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("meetings", ["tenant_id", "group_id", "topic_key"], {
    name: "meetings_topic_idx",
  });
  pgm.dropColumn("meetings", "topic_key");
}
