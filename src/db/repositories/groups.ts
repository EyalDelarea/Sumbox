import type pg from "pg";
import { summaryPreviewLine } from "../../summarization/normalize.js";

type GroupSource = "import" | "live" | "mixed";

type UpsertGroupByWhatsappIdInput = {
  whatsappId: string;
  name: string;
  source: "live";
};

type UpsertGroupInput = {
  name: string;
  source: GroupSource;
};

/**
 * Insert a group by name, or return the existing id on name conflict.
 * Returns the group id as a number.
 */
export async function upsertGroup(
  client: pg.Pool | pg.PoolClient,
  input: UpsertGroupInput,
): Promise<number> {
  const result = await client.query<{ id: string }>(
    `
    INSERT INTO groups (name, source)
    VALUES ($1, $2)
    ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
    `,
    [input.name, input.source],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`upsertGroup: no row returned for name="${input.name}"`);
  }
  return Number(row.id);
}

type UpsertGroupByCanonicalJidInput = {
  /** The identity the message actually arrived under. */
  primaryJid: string;
  /**
   * The person's *other* identity (lid<->pn sibling), or null when there is none
   * (e.g. a @g.us group, or an unresolvable 1:1). When the primary identity has
   * no row but the sibling does, the message is routed into the sibling's row so
   * a duplicate group never forms.
   */
  siblingJid: string | null;
  name: string;
  source: "live";
};

/** Look up a group row by its whatsapp_id, or null. */
async function findGroupByJid(
  client: pg.Pool | pg.PoolClient,
  jid: string,
): Promise<{ id: number; source: string } | null> {
  const { rows } = await client.query<{ id: string; source: string }>(
    `SELECT id, source FROM groups WHERE whatsapp_id = $1 LIMIT 1`,
    [jid],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), source: row.source } : null;
}

/** Upgrade a group whose source is 'import' to 'mixed' once live messages land. */
async function upgradeImportSource(
  client: pg.Pool | pg.PoolClient,
  id: number,
  source: string,
): Promise<void> {
  if (source === "import") {
    await client.query(`UPDATE groups SET source = 'mixed' WHERE id = $1`, [id]);
  }
}

/**
 * Upsert a group for an incoming live message, canonicalizing the person's
 * identity so all of their messages land in ONE row regardless of which
 * WhatsApp identity (@lid vs @s.whatsapp.net) the message arrived under.
 *
 * WhatsApp's LID migration delivers a person's messages under either identity.
 * Keying a group on the raw JID splits one person across two rows; once a CLI
 * merge folds them, a message under the other identity re-creates the duplicate
 * (issue #17). Routing to the existing row at ingest stops duplicates re-forming.
 *
 * Resolution order:
 * 1. A row already exists under `primaryJid` → use it.
 * 2. Else a row exists under `siblingJid` → route into it (no new row).
 * 3. Else INSERT a new row keyed on `primaryJid`.
 *
 * Returns the group id plus the `canonicalJid` the row is actually keyed under,
 * so callers can target downstream updates (e.g. display-name) at the right row.
 */
export async function upsertGroupByCanonicalJid(
  client: pg.Pool | pg.PoolClient,
  input: UpsertGroupByCanonicalJidInput,
): Promise<{ groupId: number; canonicalJid: string }> {
  // 1. A row already exists under the identity the message arrived under.
  const primary = await findGroupByJid(client, input.primaryJid);
  if (primary) {
    await upgradeImportSource(client, primary.id, primary.source);
    return { groupId: primary.id, canonicalJid: input.primaryJid };
  }

  // 2. No primary row, but the person's other identity already has a chat —
  //    route this message into it instead of spawning a duplicate.
  if (input.siblingJid) {
    const sibling = await findGroupByJid(client, input.siblingJid);
    if (sibling) {
      await upgradeImportSource(client, sibling.id, sibling.source);
      return { groupId: sibling.id, canonicalJid: input.siblingJid };
    }
  }

  // 3. Neither identity has a row — insert a new live group keyed on primaryJid.
  //    The name may collide with an existing import group (by name, not JID); in
  //    that case adopt its row and upgrade source to 'mixed'.
  const inserted = await client.query<{ id: string }>(
    `
    INSERT INTO groups (whatsapp_id, name, source)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET whatsapp_id = EXCLUDED.whatsapp_id,
          source = CASE
            WHEN groups.source = 'import' THEN 'mixed'
            ELSE EXCLUDED.source
          END
    RETURNING id
    `,
    [input.primaryJid, input.name, input.source],
  );

  const row = inserted.rows[0];
  if (!row) {
    throw new Error(
      `upsertGroupByCanonicalJid: no row returned for whatsapp_id="${input.primaryJid}"`,
    );
  }
  return { groupId: Number(row.id), canonicalJid: input.primaryJid };
}

/**
 * Upsert a group by whatsapp_id (JID) for live-collected groups. Thin wrapper
 * over {@link upsertGroupByCanonicalJid} with no sibling identity (the legacy
 * single-identity behavior). Returns the group id.
 */
export async function upsertGroupByWhatsappId(
  client: pg.Pool | pg.PoolClient,
  input: UpsertGroupByWhatsappIdInput,
): Promise<number> {
  const { groupId } = await upsertGroupByCanonicalJid(client, {
    primaryJid: input.whatsappId,
    siblingJid: null,
    name: input.name,
    source: input.source,
  });
  return groupId;
}

/**
 * All stored chats with their source, message count, last message timestamp, and
 * a one-line preview of the most recent catch-up summary.
 *
 * Ordered by most-recent activity first (last_message_at DESC) so the chats that
 * matter float to the top, mirroring WhatsApp's own chat list. Chats with no
 * messages (last_message_at IS NULL) sink to the bottom; name is the tiebreaker
 * so equal-recency chats stay in a stable, predictable order.
 *
 * `summaryPreview` lets the Updates cards show what a chat is about *before* the
 * user taps in, without an extra request per card or generating anything: it's
 * folded into this one query as a correlated lookup of the latest *cached*
 * `watermark` summary (the same catch-up the detail view serves from cache), and
 * is null when no such summary exists yet (the card then shows its CTA). See #13.
 */
export async function listGroups(client: pg.Pool | pg.PoolClient): Promise<
  {
    id: number;
    name: string;
    source: string;
    messageCount: number;
    lastMessageAt: Date | null;
    newCount: number;
    summaryPreview: string | null;
  }[]
> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    source: string;
    message_count: string;
    last_message_at: Date | null;
    new_count: string;
    summary_preview: string | null;
  }>(
    `
    SELECT g.id, g.name, g.source,
           COUNT(m.id) AS message_count,
           MAX(m.sent_at) AS last_message_at,
           -- "חדשות": messages that arrived since this chat was last summarized
           -- (an un-summarized chat counts all its messages as new to catch up on).
           COUNT(m.id) FILTER (
             WHERE m.sent_at > COALESCE(
               (SELECT MAX(s.created_at) FROM summaries s WHERE s.group_id = g.id),
               '-infinity'::timestamptz
             )
           ) AS new_count,
           -- The latest cached catch-up summary's text (TL;DR, or the overview for
           -- pre-TL;DR rows), trimmed to a one-line card preview in JS below.
           (
             SELECT COALESCE(NULLIF(s.output->>'tldr', ''), s.output->>'overview')
             FROM summaries s
             WHERE s.group_id = g.id AND s.summary_type = 'watermark'
             ORDER BY s.created_at DESC, s.id DESC
             LIMIT 1
           ) AS summary_preview
    FROM groups g
    LEFT JOIN messages m ON m.group_id = g.id
    GROUP BY g.id, g.name, g.source
    ORDER BY last_message_at DESC NULLS LAST, g.name ASC
    `,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    source: r.source,
    messageCount: Number(r.message_count),
    lastMessageAt: r.last_message_at ?? null,
    newCount: Number(r.new_count),
    summaryPreview: summaryPreviewLine(r.summary_preview) || null,
  }));
}

/**
 * Update the display name of a group ONLY if the stored name still equals the
 * raw JID (i.e. name was never resolved from the JID). This is idempotent: it
 * never clobbers a user-renamed or already-resolved name.
 *
 * Returns true if a row was updated (name changed), false otherwise.
 *
 * SQL: UPDATE groups SET name=$2 WHERE whatsapp_id=$1 AND name=$1
 */
export async function updateDisplayName(
  client: pg.Pool | pg.PoolClient,
  whatsappId: string,
  displayName: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE groups SET name = $2 WHERE whatsapp_id = $1 AND name = $1`,
    [whatsappId, displayName],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Disambiguating display-name resolution ──────────────────────────────────
//
// Two different people can share a WhatsApp display name, and `groups.name` is
// UNIQUE. `updateDisplayName` throws 23505 on that, which is the right answer
// for the contacts-directory path (there a collision means "same person, second
// JID") but wrong for the message paths: the row keeps `name = whatsapp_id`, so
// `isDisplayNameUnresolved` stays true and EVERY subsequent message retries the
// same doomed UPDATE.
//
// `groups_tenant_name_unique` is load-bearing and must not be dropped:
// `findGroupByName` is `WHERE name = $1 LIMIT 1` with no ordering, and it is the
// lookup key for the CLI, both summarization prepare paths, and the web
// handlers. Uniqueness is what makes that LIMIT 1 deterministic. So we keep
// names unique and disambiguate the loser instead.

/**
 * Claim `candidate` for this chat, but only if it is free.
 *
 * The `NOT EXISTS` guard means a taken name yields 0 rows rather than raising
 * 23505. That matters because this function is called in a loop: a raised
 * unique_violation would abort an enclosing transaction, and the signature
 * accepts a `PoolClient`. Same idempotence guard as `updateDisplayName` — it
 * only ever touches a row still named by its raw JID.
 *
 * Returns true if the name was claimed.
 */
async function tryClaimName(
  client: pg.Pool | pg.PoolClient,
  whatsappId: string,
  candidate: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE groups SET name = $2
       WHERE whatsapp_id = $1
         AND name = $1
         AND NOT EXISTS (SELECT 1 FROM groups other WHERE other.name = $2)`,
    [whatsappId, candidate],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The part of a JID before '@' — a phone number for @s.whatsapp.net. */
function jidUserPart(jid: string): string {
  return jid.split("@")[0] ?? jid;
}

/**
 * Pick the identity whose digits mean something to a human: the phone side of a
 * lid↔pn pair when we know it, otherwise the chat's own JID. A bare @lid number
 * is an opaque WhatsApp-internal id and identifies nobody.
 */
function digitSourceJid(whatsappId: string, siblingJid: string | null | undefined): string {
  if (siblingJid && siblingJid.endsWith("@s.whatsapp.net")) return siblingJid;
  return whatsappId;
}

/**
 * The names to try, in order, when `displayName` is already taken by a stranger.
 * Escalates until uniqueness is guaranteed by construction, so this can never
 * fall back to `name = whatsappId` and re-enter the per-message retry loop.
 *
 * Exported for unit testing.
 */
export function disambiguationCandidates(
  whatsappId: string,
  displayName: string,
  siblingJid?: string | null,
): string[] {
  const digits = jidUserPart(digitSourceJid(whatsappId, siblingJid));
  const last4 = digits.slice(-4);
  const candidates = [`${displayName} (~${digits})`, `${displayName} (${whatsappId})`];
  // Only worth trying the short form when it is actually shorter.
  if (last4 && last4 !== digits) candidates.unshift(`${displayName} (~${last4})`);
  return candidates;
}

export type DisplayNameOutcome =
  /** The row's name was set (to `name`, which may carry a disambiguating suffix). */
  | { status: "updated"; name: string }
  /**
   * The name is held by this chat's own lid/pn sibling — the same person under
   * their other identity, awaiting reconcile. Deliberately left nameless: it is
   * `findMergeCandidates` (merge.ts) that reconciles the pair, and it only
   * considers chats where `name == whatsapp_id`. Naming this row would
   * disqualify it from the merge forever and split the conversation in two.
   */
  | { status: "skipped-sibling"; heldBy: string }
  /** No row matched — it does not exist, or its name was already resolved. */
  | { status: "noop" }
  /** Every candidate collided. Pathological; the caller should log it. */
  | { status: "unresolvable" };

/**
 * Like {@link updateDisplayName}, but resolves a duplicate-name collision instead
 * of throwing. For the message-driven paths (live collector, batch resolver)
 * where a collision means two different people share a display name.
 *
 * NOT for the contacts-directory path: there one contact is applied to several
 * of its own JIDs, so a collision is the correct outcome and must stay a no-op.
 *
 * `siblingJid` is this chat's other WhatsApp identity (lid↔pn) when known. It
 * is passed in rather than looked up so this repository stays free of
 * identity-links queries.
 */
export async function updateDisplayNameDisambiguated(
  client: pg.Pool | pg.PoolClient,
  whatsappId: string,
  displayName: string,
  siblingJid?: string | null,
): Promise<DisplayNameOutcome> {
  if (await tryClaimName(client, whatsappId, displayName)) {
    return { status: "updated", name: displayName };
  }

  // 0 rows has two causes: the row is absent / already resolved (nothing to do),
  // or the name is taken. Only the second is worth more work.
  if (!(await isDisplayNameUnresolved(client, whatsappId))) {
    return { status: "noop" };
  }

  // Who holds the name? If it is our own sibling, stay nameless (see above).
  const { rows } = await client.query<{ whatsapp_id: string | null }>(
    `SELECT whatsapp_id FROM groups WHERE name = $1 LIMIT 1`,
    [displayName],
  );
  const heldBy = rows[0]?.whatsapp_id ?? null;
  if (!heldBy) {
    // Freed between the two statements. Unreachable with a single collector
    // process; the next message resolves the name normally.
    return { status: "noop" };
  }
  if (siblingJid && heldBy === siblingJid) {
    return { status: "skipped-sibling", heldBy };
  }

  for (const candidate of disambiguationCandidates(whatsappId, displayName, siblingJid)) {
    if (await tryClaimName(client, whatsappId, candidate)) {
      return { status: "updated", name: candidate };
    }
  }
  return { status: "unresolvable" };
}

/**
 * Returns true iff a group row exists with name == whatsapp_id (i.e. the
 * display name has never been resolved from the raw JID). Used to gate the
 * groupSubject network call so we don't call it on every message.
 */
export async function isDisplayNameUnresolved(
  client: pg.Pool | pg.PoolClient,
  whatsappId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ found: boolean }>(
    `SELECT true AS found FROM groups WHERE whatsapp_id = $1 AND name = $1 LIMIT 1`,
    [whatsappId],
  );
  return rows.length > 0;
}

/**
 * Return all groups where name == whatsapp_id AND whatsapp_id IS NOT NULL.
 * These are groups whose display name has never been resolved (still the raw JID).
 * Used by the proactive name-resolver to drive a bulk-resolve pass.
 */
export async function listUnresolvedGroups(
  client: pg.Pool | pg.PoolClient,
): Promise<{ id: number; whatsappId: string }[]> {
  const { rows } = await client.query<{ id: string; whatsapp_id: string }>(
    `SELECT id, whatsapp_id FROM groups WHERE whatsapp_id IS NOT NULL AND name = whatsapp_id`,
  );
  return rows.map((r) => ({ id: Number(r.id), whatsappId: r.whatsapp_id }));
}

/**
 * Derive a representative sender name for a non-@g.us group (e.g. @lid / @s.whatsapp.net)
 * by looking up the most-recent non-null participant display_name among that group's messages.
 *
 * Excludes messages the device owner sent (from_me): a 1-on-1 DM must be named
 * after the OTHER party, never after ourselves. Without this filter, a DM where
 * we sent the most-recent message gets mislabeled with our own display name.
 *
 * Returns null when no inbound (non-from_me) named messages exist yet.
 */
export async function representativeSenderName(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<string | null> {
  const { rows } = await client.query<{ display_name: string }>(
    `SELECT p.display_name
     FROM messages m
     JOIN participants p ON p.id = m.participant_id
     WHERE m.group_id = $1
       AND p.display_name IS NOT NULL
       AND m.from_me IS NOT TRUE
     ORDER BY m.sent_at DESC
     LIMIT 1`,
    [groupId],
  );
  return rows[0]?.display_name ?? null;
}

/** Look up a group by its unique name. Returns null if not found. */
export async function findGroupByName(
  client: pg.Pool | pg.PoolClient,
  name: string,
): Promise<{ id: number; name: string } | null> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM groups WHERE name = $1 LIMIT 1`,
    [name],
  );
  if (rows.length === 0) return null;
  return { id: Number(rows[0].id), name: rows[0].name };
}
