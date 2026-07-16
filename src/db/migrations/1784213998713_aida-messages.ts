import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `aida_messages` — the record of which WhatsApp messages @Aida herself sent.
 *
 * ── Why this cannot be a column on `messages` ────────────────────────────────
 * @Aida does not insert her own message. She calls sendText; WhatsApp echoes the
 * message back; the collector ingests it through the SAME generic path as
 * everyone else's (source:'live', from_me:true). The ingest path has no idea it
 * was her — only ask-command.ts knows, from the WAMessage that sendText returns.
 *
 * A `messages.is_assistant` column would therefore need
 *   UPDATE messages SET is_assistant = true WHERE external_id = $1
 * AFTER sendText resolves — which silently hits ZERO ROWS whenever the echo has
 * not been ingested yet. Sometimes it lands, sometimes it doesn't, depending on
 * which async path wins. An in-memory Set fails the same way (the echo can
 * arrive before sendText resolves).
 *
 * Keyed by external_id, the marker has NO race: she records her own id at send
 * time, and a lookup is correct whether the echo was ingested before, after, or
 * never. Ordering stops mattering.
 *
 * ── Why the obvious shortcut is wrong ────────────────────────────────────────
 * Her replies APPEAR distinguishable today — their sender resolves to the group
 * JID rather than a person. That is a sender-resolution fallback, not a marker:
 * in group 70 that participant holds 8,154 messages dating to 2026-03-16, months
 * before @Aida existed, against 17 real replies of hers. There is currently no
 * way to identify her messages at all.
 *
 * Consumers: label her turns in the recency window, exclude her from the search
 * corpus, and fire reply-threads when a user quotes her.
 *
 * No tenant_id: the tenancy remnants are inert (see CLAUDE.md) and must not be
 * built on.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE aida_messages (
      group_id    bigint      NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      external_id text        NOT NULL,
      sent_at     timestamptz NOT NULL DEFAULT now(),
      question    text,
      PRIMARY KEY (group_id, external_id)
    );
  `);
  // Supports the recency window's "her turns in this group, recently" lookup.
  pgm.sql(`CREATE INDEX aida_messages_group_sent_at_idx ON aida_messages (group_id, sent_at);`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS aida_messages;`);
}
