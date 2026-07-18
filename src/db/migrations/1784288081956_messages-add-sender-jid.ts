import type { MigrationBuilder } from "node-pg-migrate";

/**
 * The author's WhatsApp JID, ON THE MESSAGE.
 *
 * Quoting a message requires naming its author — Baileys builds a quote's
 * attribution from the jid — and until now there was nowhere to read one from:
 * mapWaMessage folded key.participant into a display NAME and dropped the
 * identity.
 *
 * Why here and NOT on `participants` (which has an unused whatsapp_id column):
 * participants is UNIQUE on display_name, and display_name comes from pushName —
 * self-chosen, changeable, and not unique across chats. Two different people
 * called "אמא" in two groups collapse into one participant row, so a jid stored
 * there would belong to whichever of them spoke most recently. Attribution would
 * be wrong non-deterministically, and could carry one group's jid into another —
 * the message-level group filter on every citation lookup would not catch it,
 * because the jid arrives through the participants join.
 *
 * A jid is a property of the MESSAGE (who sent this one), not of a name.
 *
 * Nullable and forward-only: imported history is names-only and never had a jid,
 * and live messages ingested before this column existed cannot recover one. The
 * quote is dropped rather than guessed when it is null.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("messages", {
    sender_jid: { type: "text", notNull: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("messages", "sender_jid");
}
