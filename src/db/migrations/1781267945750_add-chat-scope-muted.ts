import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Per-chat MUTE — the third scope state (§7). A muted chat stays `included` (it
 * keeps appearing in Updates/catch-up and is still summarized), but the daily
 * suggestion engine skips it: no proactive suggestions or notifications. Default
 * false so existing scopes are unchanged. Tenant isolation is inherited from the
 * table's existing RLS policy — the column needs no policy of its own.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("chat_scopes", {
    muted: { type: "boolean", notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("chat_scopes", "muted");
}
