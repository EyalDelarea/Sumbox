import type pg from "pg";
import { humanizeSender, resolveSenderName } from "../../summarization/sender-name.js";

/**
 * Upsert a participant by display_name.
 * Returns the participant id as a number.
 *
 * Deliberately does NOT record a JID, though the table has a (dormant)
 * whatsapp_id column. This row is keyed on display_name, which comes from
 * pushName — self-chosen and not unique across chats — so two different people
 * sharing a name collapse into one row here. A jid hung off that row would
 * belong to whoever spoke most recently under the name. Author identity lives on
 * `messages.sender_jid` instead, where it is per-message and inside the group
 * scope. See migration 1784288081956.
 */
export async function upsertParticipant(
  client: pg.Pool | pg.PoolClient,
  displayName: string,
): Promise<number> {
  const result = await client.query<{ id: string }>(
    `
    INSERT INTO participants (display_name)
    VALUES ($1)
    ON CONFLICT (tenant_id, display_name) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id
    `,
    [displayName],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`upsertParticipant: no row returned for displayName="${displayName}"`);
  }
  return Number(row.id);
}

export interface GroupParticipant {
  name: string;
  /** How many (readable, non-self) messages this person sent in the group. */
  messageCount: number;
}

/**
 * The people active in a group, by message volume (most active first). Derived
 * from who actually sent messages — we don't store an explicit membership list.
 * Used to orient the agent ("who's in this chat").
 *
 * `includeOwner` (default false, preserving the original device-owner-excluded
 * semantics) is what @Aida's roster passes. She needs the owner because
 * PEOPLE-SAFETY's permissive branch is scoped to people who ARE in the group,
 * and the owner is both a member and the most-asked-about person in the corpus —
 * omitting him would route every question about him to the non-member floor,
 * which is the exact bug the roster exists to fix. Measured on the real DB, the
 * owner stores as an ordinary display_name, so he needs no special labelling.
 *
 * Raw JIDs (`…@…`) and the `Unknown` placeholder are excluded, mirroring
 * {@link participantNamesForBiasing}. This is not cosmetic: measured on the live
 * DB, every group @Aida serves carries exactly one JID-shaped display_name, and
 * in group 70 that row (the group's own `@g.us` jid) has 5855 messages — more
 * than any real person. Unfiltered it would head the roster and read to the model
 * as the chat's most active member.
 */
export async function listGroupParticipants(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  limit = 15,
  opts: { includeOwner?: boolean } = {},
): Promise<GroupParticipant[]> {
  const { rows } = await client.query<{ name: string; count: string }>(
    `
    SELECT p.display_name AS name, COUNT(*) AS count
    FROM messages m
    JOIN participants p ON p.id = m.participant_id
    WHERE m.group_id = $1
      AND ($2::boolean OR m.from_me IS NOT TRUE)
      AND btrim(coalesce(p.display_name, '')) <> ''
      AND p.display_name NOT LIKE '%@%'
      AND p.display_name <> 'Unknown'
    GROUP BY p.display_name
    ORDER BY COUNT(*) DESC, p.display_name
    LIMIT $3
    `,
    [groupId, opts.includeOwner === true, limit],
  );
  return rows.map((r) => ({ name: r.name, messageCount: Number(r.count) }));
}

/**
 * Distinct real participant names in the group that owns `messageId`, most-active
 * first, capped. Feeds the STT hotword bias so a spoken name decodes to the
 * person actually in the chat (e.g. "אייל" over the more common "יעל").
 *
 * Deliberately SYMMETRIC — unlike `listGroupParticipants` it does NOT exclude
 * `from_me`: the device owner is a name people say too, and a one-sided list
 * (everyone but you) would actively bias the decoder *against* your own name.
 *
 * Raw JIDs (`…@…`) and the `Unknown` placeholder are excluded — they are not
 * names a person would utter, and feeding them as hotwords only adds noise.
 */
export async function participantNamesForBiasing(
  client: pg.Pool | pg.PoolClient,
  messageId: number | string,
  limit = 20,
): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `
    SELECT p.display_name AS name
    FROM messages m
    JOIN participants p ON p.id = m.participant_id
    WHERE m.group_id = (SELECT group_id FROM messages WHERE id = $1)
      AND btrim(coalesce(p.display_name, '')) <> ''
      AND p.display_name NOT LIKE '%@%'
      AND p.display_name <> 'Unknown'
    GROUP BY p.display_name
    ORDER BY COUNT(*) DESC, p.display_name
    LIMIT $2
    `,
    [messageId, limit],
  );
  return rows.map((r) => r.name);
}

/**
 * Upsert many participants by display_name in parallel.
 * Returns a Map<display_name, id>.
 */
export async function upsertParticipants(
  client: pg.Pool | pg.PoolClient,
  displayNames: string[],
): Promise<Map<string, number>> {
  const entries = await Promise.all(
    displayNames.map(async (name) => {
      const id = await upsertParticipant(client, name);
      return [name, id] as [string, number];
    }),
  );
  return new Map(entries);
}

// ── Identities → labels ───────────────────────────────────────────────────

/**
 * The name to show for a stored WhatsApp identity — a memory's subject.
 *
 * THE INDIRECTION IS THE WHOLE FUNCTION. A belief's subject is stored in its
 * canonical form, which `createMemory` makes the PHONE jid wherever a link is
 * known. Display names only ever arrive on messages, as `pushName` — and in a
 * group, those messages carry the `@lid`. So the name and the identity we stored
 * sit on opposite sides of `identity_links`, and a direct lookup on
 * `messages.sender_jid` finds only the JID-shaped participant row the author rule
 * exists to reject. Verified on the live DB: the phone form alone resolves to
 * `972…@s.whatsapp.net`, and through the sibling to `Royi`.
 *
 * NEVER RETURNS A RAW JID. An identity with no name behind it falls back to
 * `humanizeSender`, exactly as every other surface in this project does — the
 * phone number for a phone jid, the unknown-participant label for anything else.
 * A screen that showed a raw `@lid` would be showing an internal identifier as a
 * person.
 *
 * The MOST RECENT name wins, because push names change and the current one is the
 * one the operator will recognise.
 *
 * One query for the whole page: a review page carries up to two subjects a row,
 * and a per-subject lookup would be dozens of round trips for one screen.
 */
export async function displayNamesForJids(
  client: pg.Pool | pg.PoolClient,
  jids: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(jids.map((j) => j.trim()).filter((j) => j !== ""))];
  const labels = new Map<string, string>();
  if (wanted.length === 0) return labels;

  const { rows } = await client.query<{ jid: string; name: string | null }>(
    `
    WITH wanted AS (SELECT DISTINCT unnest($1::text[]) AS jid),
    -- Both directions: the stored form is usually the phone jid, and the named
    -- messages hang off the lid. siblingForJid's query, widened to a batch.
    sibling AS (
      SELECT w.jid,
             max(CASE WHEN l.lid_jid = w.jid THEN l.pn_jid ELSE l.lid_jid END) AS other
      FROM wanted w
      LEFT JOIN identity_links l ON l.lid_jid = w.jid OR l.pn_jid = w.jid
      GROUP BY w.jid
    )
    SELECT s.jid,
           (SELECT p.display_name
              FROM messages m
              JOIN participants p ON p.id = m.participant_id
             WHERE m.sender_jid IN (s.jid, s.other)
               -- The author rule's own test for who is a person, so a belief's
               -- subject can never be labelled with a placeholder row.
               AND btrim(coalesce(p.display_name, '')) <> ''
               AND p.display_name NOT LIKE '%@%'
               AND p.display_name <> 'Unknown'
             ORDER BY m.sent_at DESC
             LIMIT 1) AS name
    FROM sibling s
    `,
    [wanted],
  );

  for (const row of rows) {
    labels.set(row.jid, row.name ? resolveSenderName(row.name) : humanizeSender(row.jid));
  }
  // A jid the query returned nothing for at all still gets a label, never a gap.
  for (const jid of wanted) {
    if (!labels.has(jid)) labels.set(jid, humanizeSender(jid));
  }
  return labels;
}
