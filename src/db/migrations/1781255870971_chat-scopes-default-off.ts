import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Flip chat scoping to **default-OFF**. A chat is now summarized/suggested only
 * when it has an explicit `included = true` row; an unscoped chat is excluded.
 * This complements the read-side change (listScopes / listIncludedGroupIds /
 * selectActiveGroups), so categorizing a chat without explicitly including it no
 * longer silently opts it in. Reversible — `down` restores the default-ON default.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE chat_scopes ALTER COLUMN included SET DEFAULT false;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE chat_scopes ALTER COLUMN included SET DEFAULT true;`);
}
