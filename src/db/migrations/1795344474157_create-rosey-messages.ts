import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `rosey_messages` — the ledger of WhatsApp messages Rosey herself sent.
 *
 * NOTHING WRITES THIS YET. Rosey has no send path in this release; the table is
 * created now (D2: tables from day one) so the send slices need no schema change.
 *
 * Same reasoning as `aida_messages`: keyed by external_id, recorded at send
 * time, because on a shared linked device her posts echo back as `from_me`
 * exactly like the owner's, and an `is_bot` column on `messages` would race the
 * echo. It will drive the own-echo guard, the per-group rate limits (counts
 * survive a restart), and reply/react linkage to her posts.
 *
 * - `kind` is the post type the rate limits are defined over.
 * - `task_id`: D8 is a native WhatsApp poll per task, so a poll post points at
 *   the one task it tracks. SET NULL: the ledger row must outlive the task, or
 *   a deleted task would erase the evidence the rate limit counts.
 * - `message_secret`: a poll vote arrives encrypted (pollUpdateMessage), and
 *   decrypting it needs the 32-byte messageSecret the poll was created with.
 *   Baileys 7.0.0-rc14 does not auto-decrypt votes, so the secret must be kept.
 *   It is a per-poll key, not message content.
 *
 * No tenant_id: the tenancy remnants are inert (see CLAUDE.md).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE rosey_messages (
      group_id       bigint      NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      external_id    text        NOT NULL,
      kind           text        NOT NULL CHECK (kind IN ('reply', 'reaction', 'weekly', 'poll')),
      task_id        bigint      REFERENCES rosey_tasks(id) ON DELETE SET NULL,
      message_secret bytea,
      sent_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, external_id),
      CONSTRAINT rosey_messages_secret_is_poll CHECK (message_secret IS NULL OR kind = 'poll')
    );
  `);
  // Rate limits count one group's sends of a kind over a recent window.
  pgm.sql(
    `CREATE INDEX rosey_messages_group_kind_sent_idx ON rosey_messages (group_id, kind, sent_at);`,
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS rosey_messages;`);
}
