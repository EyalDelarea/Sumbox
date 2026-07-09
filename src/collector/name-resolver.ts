/**
 * name-resolver.ts — Proactive bulk group-name resolution.
 *
 * Resolves display names for all groups that still show their raw JID as name
 * (i.e. name == whatsapp_id). Called once on session 'connected' so quiet
 * groups (those that never received a new live message) get resolved without
 * waiting for the next message.
 *
 * Resolution strategy per JID type:
 * - @g.us   → groupSubject(jid): fetch the WhatsApp group subject via session.
 * - anything else (@lid, @s.whatsapp.net, …) → representativeSenderName: look up
 *   the most-recent participant display_name from stored messages in that group.
 *   groupSubject is NEVER called for non-@g.us JIDs.
 *
 * Each group is wrapped in try/catch so one failure (including a UNIQUE(name)
 * collision) never aborts the batch. Never throws.
 */
import type pg from "pg";
import {
  listUnresolvedGroups,
  representativeSenderName,
  updateDisplayName,
} from "../db/repositories/groups.js";
import { getLogger } from "../logging/log.js";

const log = getLogger("name-resolver");

/**
 * A UNIQUE(tenant_id, name) collision (Postgres `23505`) is the expected outcome
 * when two JIDs resolve to the same display name — the loser simply keeps its
 * JID-name and a later directory event may resolve it differently. These are
 * benign and high-volume, so they log at `debug`. Anything else (a DB outage, an
 * `XX002` corrupt-index error, …) is unexpected and must stay visible at `warn`.
 */
function isBenignNameConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export type NameResolverDeps = {
  /** Fetch the WhatsApp group subject for a @g.us JID. Only called for @g.us. */
  groupSubject: (jid: string) => Promise<string>;
};

export type ResolveResult = {
  resolved: number;
};

/**
 * Resolve display names for all groups whose name still equals their raw JID.
 *
 * - For @g.us groups: call groupSubject(jid) to get the WhatsApp subject.
 * - For all other JIDs (e.g. @lid, @s.whatsapp.net): look up the most-recent
 *   participant display_name from stored messages (no network call needed).
 * - Each group is wrapped individually so failures never abort the batch.
 * - Never throws.
 *
 * Returns the count of groups whose name was successfully updated.
 */
export async function resolveAllGroupNames(
  pool: pg.Pool | pg.PoolClient,
  deps: NameResolverDeps,
): Promise<ResolveResult> {
  let resolved = 0;

  let unresolved: { id: number; whatsappId: string }[];
  try {
    unresolved = await listUnresolvedGroups(pool);
  } catch (err) {
    log.error({ err }, "failed to list unresolved groups");
    return { resolved: 0 };
  }

  for (const { id, whatsappId } of unresolved) {
    try {
      let name: string | null = null;

      if (whatsappId.endsWith("@g.us")) {
        const subject = await deps.groupSubject(whatsappId);
        if (subject && subject.trim()) {
          name = subject.trim();
        }
      } else {
        // @lid, @s.whatsapp.net, or any other type: use stored participant name
        name = await representativeSenderName(pool, id);
      }

      if (name) {
        const updated = await updateDisplayName(pool, whatsappId, name);
        if (updated) {
          resolved++;
        }
      }
    } catch (err) {
      // One failure must never abort the batch (incl. UNIQUE name collisions).
      // Benign dup-name collisions are routine noise (debug); anything else is
      // unexpected and stays at warn. Log only the reason — not a full stack.
      const reason = err instanceof Error ? err.message : String(err);
      const level = isBenignNameConflict(err) ? "debug" : "warn";
      log[level]({ jid: whatsappId, reason }, "skipped");
    }
  }

  return { resolved };
}

// ---------------------------------------------------------------------------
// Directory-based resolution (WhatsApp contacts + history chats)
// ---------------------------------------------------------------------------
//
// The proactive pass above can only name @g.us groups (via groupSubject) and
// derive 1:1 names from stored pushNames. It can't recover a SAVED contact name,
// nor a group name we no longer have access to (groupSubject → forbidden /
// item-not-found). WhatsApp delivers both via the contacts.upsert / contacts.update
// events and the `chats` + `contacts` arrays on messaging-history.set. These
// resolvers consume that directory data — the only source for those names.

/** Minimal shape of a Baileys Contact we care about (all fields optional). */
export type WAContactLike = {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  /** Name the device owner saved for this contact. */
  name?: string | null;
  /** Name the contact set for themselves (push name). */
  notify?: string | null;
  /** Business verified name. */
  verifiedName?: string | null;
};

/** Minimal shape of a Baileys Chat we care about. */
export type WAChatLike = {
  id?: string | null;
  name?: string | null;
};

/**
 * True if `s` is a human display name worth storing — i.e. not empty, not a raw
 * JID, and not a bare phone number (which is no better than the JID we already
 * show). Exported for unit testing.
 */
export function isUsableName(s: string | null | undefined): boolean {
  const t = (s ?? "").trim();
  if (!t) return false;
  if (t.includes("@")) return false; // looks like a JID
  if (/^\+?[\d\s\-()]+$/.test(t)) return false; // just a phone number
  return true;
}

/** Pick the best human display name from a contact, or null if none usable. */
export function pickContactName(c: WAContactLike): string | null {
  for (const cand of [c.name, c.verifiedName, c.notify]) {
    if (isUsableName(cand)) return (cand as string).trim();
  }
  return null;
}

/** Update a single JID's display name, swallowing failures. Returns true if changed. */
async function applyName(
  pool: pg.Pool | pg.PoolClient,
  jid: string | null | undefined,
  name: string,
): Promise<boolean> {
  if (!jid) return false;
  try {
    return await updateDisplayName(pool, jid, name);
  } catch (err) {
    // Expected/benign (forbidden, item-not-found, name collision) — reason only.
    // Dup-name collisions are routine (debug); unexpected errors stay at warn.
    const reason = err instanceof Error ? err.message : String(err);
    const level = isBenignNameConflict(err) ? "debug" : "warn";
    log[level]({ jid, reason }, "directory update skipped");
    return false;
  }
}

/**
 * Resolve 1:1 / @lid chat names from WhatsApp's contacts directory.
 *
 * A contact may be keyed by @lid, @s.whatsapp.net, or a phoneNumber that differs
 * from the chat's stored JID, so we try every JID the contact exposes.
 * updateDisplayName is idempotent (only touches groups still named by their JID),
 * so this never clobbers an already-resolved name. Never throws.
 */
export type ContactResolverDeps = {
  /**
   * Bridge an @lid identity to its phone (@s.whatsapp.net) JID. Modern WhatsApp
   * keys contacts by @lid while many 1:1 chats are stored by phone JID, and the
   * contact payload carries no phoneNumber — so without this bridge an @lid
   * contact name never reaches its @s.whatsapp.net chat.
   */
  pnForLid?: (lid: string) => Promise<string | null>;
};

export async function resolveContactNames(
  pool: pg.Pool | pg.PoolClient,
  contacts: WAContactLike[] | null | undefined,
  deps: ContactResolverDeps = {},
): Promise<ResolveResult> {
  let resolved = 0;
  for (const c of contacts ?? []) {
    const name = pickContactName(c);
    if (!name) continue;
    const jids = new Set([c.id, c.phoneNumber, c.lid].filter((j): j is string => Boolean(j)));
    // Bridge @lid → phone JID so the name also reaches the @s.whatsapp.net chat.
    if (deps.pnForLid) {
      for (const jid of [...jids]) {
        if (jid.endsWith("@lid")) {
          const pn = await deps.pnForLid(jid).catch(() => null);
          if (pn) jids.add(pn);
        }
      }
    }
    for (const jid of jids) {
      if (await applyName(pool, jid, name)) resolved++;
    }
  }
  if (resolved > 0) {
    log.info({ resolved }, "resolved name(s) from contacts");
  }
  return { resolved };
}

/**
 * Resolve group/chat names from the `chats` array WhatsApp delivers on
 * messaging-history.set. This is the only path that can name groups we can no
 * longer fetch a subject for (groupSubject → forbidden / item-not-found) but
 * were present in the synced history. Never throws.
 */
export async function resolveChatNames(
  pool: pg.Pool | pg.PoolClient,
  chats: WAChatLike[] | null | undefined,
): Promise<ResolveResult> {
  let resolved = 0;
  for (const ch of chats ?? []) {
    if (!isUsableName(ch.name)) continue;
    if (await applyName(pool, ch.id, (ch.name as string).trim())) resolved++;
  }
  if (resolved > 0) {
    log.info({ resolved }, "resolved name(s) from history chats");
  }
  return { resolved };
}
