import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Polymorphic link from a suggestion to the canonical object it materialized
 * (#5/#32). Nullable: `followup`/`recap` suggestions never create an object, and
 * `pending` task/meeting rows have no object yet. Set on accept/edit, read for
 * cross-surface completion.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("suggestions", {
    entity_kind: {
      type: "text",
      check: "entity_kind IN ('todo','meeting')",
    },
  });
  pgm.addColumn("suggestions", {
    entity_id: { type: "bigint" },
  });
  pgm.createIndex("suggestions", ["tenant_id", "entity_kind", "entity_id"], {
    name: "suggestions_entity_idx",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("suggestions", ["tenant_id", "entity_kind", "entity_id"], {
    name: "suggestions_entity_idx",
  });
  pgm.dropColumn("suggestions", "entity_id");
  pgm.dropColumn("suggestions", "entity_kind");
}
