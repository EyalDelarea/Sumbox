import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Normalize existing rows onto the stable command key.
 *
 * The commands-tab feature originally stored the trigger TEXT ("/סיכום") in the
 * `command` column. A later change made `command` a stable identifier ("summary")
 * so the trigger could be user-editable — but only changed the column default;
 * rows written by the earlier code still hold "/סיכום" and are therefore invisible
 * to the UI/matcher, which now query `command = 'summary'`. This backfills them.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`UPDATE group_command_permissions SET command = 'summary' WHERE command <> 'summary'`);
}

/**
 * Irreversible data normalization: the original per-row trigger text is not
 * recoverable (a single group had exactly one command). No-op down.
 */
export async function down(_pgm: MigrationBuilder): Promise<void> {}
