import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Meeting state flags (#16 #5 #8):
 *
 *   time_changed_at — stamped when a dedup-merged message moves the meeting's
 *     start time within the ±2h window (the UI shows a "מועד עודכן" badge).
 *   exported_at     — stamped the first time the meeting is included in an
 *     .ics export (GET /api/meetings.ics). Both are nullable so existing rows
 *     are unaffected; the columns carry no NOT NULL constraint.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("meetings", {
    time_changed_at: { type: "timestamptz" },
    exported_at: { type: "timestamptz" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("meetings", "exported_at");
  pgm.dropColumn("meetings", "time_changed_at");
}
