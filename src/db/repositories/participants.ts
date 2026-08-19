import type pg from "pg";

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
