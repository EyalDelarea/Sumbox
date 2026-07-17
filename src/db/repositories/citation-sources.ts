/**
 * citation-sources.ts — resolve a cited message id back to the WhatsApp message
 * it names, so @Aida's reply can quote its source.
 *
 * @Aida cites internal `messages.id` (see ask/prompt.ts citeTag). WhatsApp only
 * knows `external_id`, and Baileys needs the AUTHOR's jid to attribute a quote —
 * this is the one place that crossing happens.
 */

import type pg from "pg";

/** A cited message, resolved to everything needed to quote it. */
export type CitationSource = {
  messageId: number;
  /** The WhatsApp message id (stanza id) to quote. */
  externalId: string;
  /** Preview text for the quote bubble. */
  text: string;
  /**
   * The author's JID, or null when we never learned it.
   *
   * Null for every message ingested before the collector started recording it,
   * and for all imported history — a WhatsApp export is names-only. A quote
   * cannot be attributed without it, so the caller must skip the pin rather than
   * guess.
   */
  authorJid: string | null;
  /** True when the device owner (or @Aida herself) sent it. */
  fromMe: boolean;
};

/**
 * Resolve one cited message id within `groupId`.
 *
 * The group scope is the privacy boundary, exactly as in retrieval: a citation
 * is model output, and without this filter a stray id could name a message from
 * a different chat. Filtering here means an out-of-group id simply resolves to
 * null and the quote is dropped.
 *
 * Returns null when the id is unknown, belongs to another group, or has no
 * external_id (imported history was never a live WhatsApp message, so there is
 * nothing to quote).
 */
export async function resolveCitationSource(
  client: pg.Pool | pg.PoolClient,
  input: { groupId: number; messageId: number },
): Promise<CitationSource | null> {
  const { rows } = await client.query<{
    id: string;
    external_id: string;
    text: string;
    author_jid: string | null;
    from_me: boolean | null;
  }>(
    `SELECT m.id,
            m.external_id,
            coalesce(NULLIF(trim(m.text_content), ''), '') AS text,
            p.whatsapp_id AS author_jid,
            m.from_me
       FROM messages m
       LEFT JOIN participants p ON p.id = m.participant_id
      WHERE m.id = $1
        AND m.group_id = $2
        AND m.external_id IS NOT NULL
      LIMIT 1`,
    [input.messageId, input.groupId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    messageId: Number(row.id),
    externalId: row.external_id,
    text: row.text,
    authorJid: row.author_jid,
    fromMe: row.from_me === true,
  };
}
