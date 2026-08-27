/**
 * roster-sync.ts — fill the lid↔phone bridge from WhatsApp's own group rosters.
 *
 * `identity_links` is the only thing connecting a member's `@lid` — the privacy
 * identifier every group message now arrives under — to their phone JID. Until
 * now it learned one pair at a time, opportunistically, from a message that
 * happened to carry both forms. Measured on the live DB: **105 of the 324 lids
 * seen in messages, 32%**.
 *
 * `groupMetadata(jid).participants` carries the whole mapping for a group in one
 * call. Probed against three real groups (406 participants): `id` and
 * `phoneNumber` populated for every one, `name` and `notify` for none. So this is
 * the authoritative bridge — and not a source of display names, which only ever
 * arrive on messages as `pushName`.
 *
 * WHY THIS DOES NOT REWRITE AN EXISTING LINK. Both columns are unique, so a
 * roster pair can collide with a link already on file. The roster is more
 * authoritative than what a passing message revealed — and rewriting a link
 * silently MOVES every belief filed against that identity, which is the one error
 * this design calls unrecoverable: revoking a memory cannot un-hold it about the
 * wrong person. So a collision is skipped and COUNTED. If the count stays zero
 * across real rosters, the case is theoretical and can be revisited with
 * evidence rather than with caution.
 *
 * SELF-LIMITING. A run only visits groups that still hold an unlinked lid, so it
 * shrinks as the bridge fills and does nothing once it is complete. That is what
 * makes it safe to run on every connect: 97 group chats paced at one call a
 * second would otherwise be 97 calls of nothing, against the endpoint whose
 * `rate-overlimit` storm `group-subject-throttle.ts` exists to prevent.
 */
import type pg from "pg";
import { recordLink } from "../db/repositories/identity-links.js";
import { getLogger } from "../logging/log.js";

const log = getLogger("roster-sync");

/** The live-session capability this needs. Injected, so the sync is testable. */
export type RosterBridge = {
  groupParticipants(waJid: string): Promise<{ id: string; phoneNumber?: string }[]>;
};

/**
 * What one run did. Every skip has its own counter: they are different things
 * happening, and a run that linked nothing because everything collided reads
 * nothing like one that linked nothing because the bridge is already complete.
 */
export type RosterSyncStats = {
  /** Groups visited — those still holding at least one unlinked lid. */
  groups: number;
  /** New pairs written. */
  linked: number;
  /** Pairs already on file exactly as the roster reports them. */
  already: number;
  /** The lid is linked to a DIFFERENT phone. Skipped, never rewritten. */
  lidTaken: number;
  /** The phone is linked to a DIFFERENT lid. Skipped, never rewritten. */
  pnTaken: number;
  /** A participant whose id is not an `@lid` — see below. */
  notLid: number;
  /** A participant WhatsApp gave no phone number for. */
  noPhone: number;
  /** Groups whose roster could not be read at all. */
  failed: number;
};

const EMPTY: RosterSyncStats = {
  groups: 0,
  linked: 0,
  already: 0,
  lidTaken: 0,
  pnTaken: 0,
  notLid: 0,
  noPhone: 0,
  failed: 0,
};

/**
 * Groups worth calling WhatsApp about: a real group chat holding at least one
 * `@lid` sender that is not yet bridged. Newest activity first, so a run capped
 * below the backlog still covers the chats being used.
 */
export async function groupsNeedingRoster(
  client: pg.Pool | pg.PoolClient,
  limit: number,
): Promise<{ id: number; whatsappId: string }[]> {
  const { rows } = await client.query<{ id: string; whatsapp_id: string }>(
    `
    SELECT g.id, g.whatsapp_id, max(m.sent_at) AS last_seen
    FROM groups g
    JOIN messages m ON m.group_id = g.id
    WHERE g.whatsapp_id LIKE '%@g.us'
      AND m.sender_jid LIKE '%@lid'
      AND NOT EXISTS (SELECT 1 FROM identity_links l WHERE l.lid_jid = m.sender_jid)
    GROUP BY g.id, g.whatsapp_id
    ORDER BY last_seen DESC
    LIMIT $1
    `,
    [limit],
  );
  return rows.map((r) => ({ id: Number(r.id), whatsappId: r.whatsapp_id }));
}

/**
 * Bridge every group that still needs it, and report what happened.
 *
 * Paced rather than parallel: `groupMetadata` is the endpoint WhatsApp rate-limits
 * hardest, and a burst across 97 groups is the storm shape, not the volume.
 *
 * NOTHING THROWS OUT OF HERE. A group whose roster fails is counted and the run
 * continues — one unreachable chat must not cost the bridge every other one.
 */
export async function syncGroupRosters(
  pool: pg.Pool,
  bridge: RosterBridge,
  opts: {
    /** Groups per run. */
    limit?: number;
    /** Pause between groups. */
    delayMs?: number;
    /** Injected so tests do not wait. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<RosterSyncStats> {
  const limit = opts.limit ?? 25;
  const delayMs = opts.delayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const groups = await groupsNeedingRoster(pool, limit);
  if (groups.length === 0) return EMPTY;

  const stats: RosterSyncStats = { ...EMPTY };
  let first = true;
  for (const group of groups) {
    if (!first) await sleep(delayMs);
    first = false;
    stats.groups++;
    const participants = await bridge.groupParticipants(group.whatsappId);
    if (participants.length === 0) {
      stats.failed++;
      continue;
    }
    await bridgeParticipants(pool, participants, stats);
  }

  // Logged, not merely returned: this runs unattended, and "the bridge grew by
  // 219 pairs" is the difference between a resolver that names people and one
  // that shows masked phone numbers.
  log.info(stats, "roster sync complete");
  return stats;
}

/** Classify and write one group's roster. Mutates `stats`. */
async function bridgeParticipants(
  pool: pg.Pool,
  participants: readonly { id: string; phoneNumber?: string }[],
  stats: RosterSyncStats,
): Promise<void> {
  const pairs: { lid: string; pn: string }[] = [];
  for (const p of participants) {
    const lid = (p.id ?? "").trim();
    const pn = (p.phoneNumber ?? "").trim();
    // Asserted rather than assumed. Probed, every participant's id was an `@lid`
    // — but if it can ever be the phone form, this would write a phone into the
    // lid column, and neither unique index would catch it.
    if (!lid.endsWith("@lid")) {
      stats.notLid++;
      continue;
    }
    if (!pn.endsWith("@s.whatsapp.net")) {
      stats.noPhone++;
      continue;
    }
    pairs.push({ lid, pn });
  }
  if (pairs.length === 0) return;

  // One read for the whole roster: 357 participants is one query, not 357.
  const { rows: existing } = await pool.query<{ lid_jid: string; pn_jid: string }>(
    `SELECT lid_jid, pn_jid FROM identity_links WHERE lid_jid = ANY($1::text[]) OR pn_jid = ANY($2::text[])`,
    [pairs.map((p) => p.lid), pairs.map((p) => p.pn)],
  );
  const pnForLid = new Map(existing.map((r) => [r.lid_jid, r.pn_jid]));
  const lidForPn = new Map(existing.map((r) => [r.pn_jid, r.lid_jid]));

  for (const { lid, pn } of pairs) {
    const boundPn = pnForLid.get(lid);
    const boundLid = lidForPn.get(pn);
    if (boundPn === pn && boundLid === lid) {
      stats.already++;
      continue;
    }
    if (boundPn !== undefined) {
      stats.lidTaken++;
      continue;
    }
    if (boundLid !== undefined) {
      stats.pnTaken++;
      continue;
    }
    // `bridge`, not a new source value: the CHECK on `identity_links.source`
    // would need a migration for a field nothing reads, and `recordLink`
    // refreshes source on conflict, so the distinction would not survive anyway.
    await recordLink(pool, { lidJid: lid, pnJid: pn, source: "bridge" });
    stats.linked++;
  }
}
