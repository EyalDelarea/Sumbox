import type pg from "pg";

export type IdentityLinkSource = "message_alt" | "bridge";

export type RecordLinkInput = {
  lidJid: string;
  pnJid: string;
  source: IdentityLinkSource;
};

/**
 * Idempotently upsert a lid↔phone pairing. Conflict on the (tenant_id, lid_jid)
 * unique key refreshes pn_jid/source/updated_at rather than inserting a
 * duplicate. Best-effort callers should swallow failures (e.g. the rarer
 * (tenant_id, pn_jid) unique collision when a pn re-pairs to a new lid).
 */
export async function recordLink(
  client: pg.Pool | pg.PoolClient,
  input: RecordLinkInput,
): Promise<void> {
  await client.query(
    `
    INSERT INTO identity_links (lid_jid, pn_jid, source)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id, lid_jid) DO UPDATE
      SET pn_jid = EXCLUDED.pn_jid, source = EXCLUDED.source, updated_at = now()
    `,
    [input.lidJid, input.pnJid, input.source],
  );
}

/**
 * Return the paired JID for `jid` (the pn for a lid, or the lid for a pn), or
 * null when no link is known. The durable, session-independent lid↔pn bridge.
 */
export async function siblingForJid(
  client: pg.Pool | pg.PoolClient,
  jid: string,
): Promise<string | null> {
  const { rows } = await client.query<{ sibling: string }>(
    `
    SELECT pn_jid AS sibling FROM identity_links WHERE lid_jid = $1
    UNION ALL
    SELECT lid_jid AS sibling FROM identity_links WHERE pn_jid = $1
    LIMIT 1
    `,
    [jid],
  );
  return rows[0]?.sibling ?? null;
}
