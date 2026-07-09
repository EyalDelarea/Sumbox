import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Drop meetings.exported_at — the .ics calendar export (GET /api/meetings.ics)
 * was removed (spec 025), so the column is orphaned. time_changed_at stays
 * (still powers the "מועד עודכן" badge).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("meetings", "exported_at");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("meetings", { exported_at: { type: "timestamptz" } });
}
