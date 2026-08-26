/**
 * aida-memory.ts — the repository fronting @Aida's four memory tables and the
 * shared evidence ledger.
 *
 * The schema expresses everything it can (see migrations `aida-memory-tables`
 * and `aida-memory-evidence`), but two invariants are beyond it and live here:
 *
 *   1. A MEMORY CANNOT EXIST WITHOUT EVIDENCE. No foreign key can say "at least
 *      one child row", so it is a transaction boundary instead: the memory and
 *      its evidence are written as one unit, and a memory whose evidence does not
 *      land takes itself with it. That only holds while this module is the ONLY
 *      writer — a later slice must not gain a second door.
 *   2. THE TRUST-BEARING FIELDS ARE DERIVED, NOT SUPPLIED. `observed_at` comes
 *      from the cited messages and the evidence rows are written by `INSERT
 *      ... SELECT FROM messages`, scoped to the memory's own group. A caller
 *      cannot invent a timestamp, cannot cite a message from another chat, and
 *      cannot cite one that does not exist — a hallucinated id simply matches no
 *      rows. That pattern is inherited from the shadow-phase repository, which is
 *      the closest prior art in this repo's history.
 *
 * Nothing here mutates a belief. A memory is replaced by writing a newer one and
 * pointing the old row at it, and withdrawn by stamping it. `UPDATE` appears in
 * exactly two places — setting `superseded_by_id` and setting `revoked_at` — and
 * both are guarded so they can only ever move a row from unset to set.
 *
 * Nothing calls this yet. The extractor is slice 4 and the read path is slice 5;
 * the visibility surface (slice 3) builds against it while it is still empty.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { siblingForJid } from "./identity-links.js";

// ── Vocabulary ────────────────────────────────────────────────────────────

/** Which of the four tables a memory lives in. Mirrors the ledger's closed set. */
export type MemoryType = "episodic" | "semantic" | "relational" | "self_state";

/** Whether a cited message argues for the belief or against it. */
export type EvidenceStance = "supports" | "contradicts";

/** Knowledge she holds about herself, or a rule for how she should behave. */
export type SelfStateFacet = "knowledge" | "behaviour";

const TABLE_FOR: Record<MemoryType, string> = {
  episodic: "aida_episodic_memories",
  semantic: "aida_semantic_memories",
  relational: "aida_relational_memories",
  self_state: "aida_self_state_memories",
};

/**
 * What a memory is about, which is also what decides where it is stored.
 *
 * A discriminated union rather than four optional fields: an episodic memory may
 * legitimately be about nobody, a semantic one is about exactly one person, and a
 * relational one about two or more. Modelling that as nullable columns on one
 * shape would make every impossible combination expressible.
 */
export type MemorySubject =
  | { memoryType: "episodic"; subjectJid?: string | null }
  | { memoryType: "semantic"; subjectJid: string }
  | { memoryType: "relational"; subjectJids: readonly string[] }
  | { memoryType: "self_state"; facet: SelfStateFacet };

/** One message offered as evidence, and which way it cuts. */
export type EvidenceDraft = {
  messageId: number;
  stance: EvidenceStance;
};

/** A belief to record, together with the messages it came from. */
export type MemoryDraft = MemorySubject & {
  groupId: number;
  /** The belief in words. Phrased as an interpretation, never as history. */
  content: string;
  /** At least one. An empty list is a caller bug, not a data outcome — see below. */
  evidence: readonly EvidenceDraft[];
};

export type MemoryWriteResult = {
  id: number;
  /** False when an identical memory already existed and this run converged onto it. */
  created: boolean;
  /** Evidence rows this call added. Zero on a repeat run that cited nothing new. */
  evidenceRecorded: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * The dedupe key. Normalized so trivial whitespace differences don't defeat it,
 * which is what makes re-running extraction over the same window converge
 * instead of writing a new row per run.
 *
 * md5 and the same normalization as the shadow phase used, deliberately: this is
 * a dedupe key, not a security primitive, and keeping it identical means the
 * numbers measured on #83 stay comparable.
 */
export function memoryContentHash(content: string): string {
  return createHash("md5").update(content.trim().replace(/\s+/g, " ")).digest("hex");
}

/**
 * The form of a WhatsApp identity a subject is stored as: the phone JID, when
 * one is known.
 *
 * The same human can reach a group under two identities — an `@lid` and an
 * `@s.whatsapp.net` — and without collapsing them a belief about that person
 * splits into two parallel sets. `identity_links` already carries the bridge.
 *
 * ONE DIRECTION ONLY, and the direction matters. `siblingForJid` returns *the
 * other* identity of a pair, so calling it unconditionally would rewrite phone
 * JIDs into lids and leave the split exactly where it was, just mirrored. Only an
 * `@lid` is rewritten, and only to something that really is a phone JID. This
 * follows the existing precedent in `ask-command.ts`, which canonicalizes a 1:1
 * `@lid` to its phone JID for the allowlist.
 *
 * An unlinked lid stays a lid. That is the honest outcome: two subjects is
 * better than one wrong one, and the link may be learned later.
 */
export async function canonicalSubjectJid(
  client: pg.Pool | pg.PoolClient,
  jid: string,
): Promise<string> {
  if (!jid.endsWith("@lid")) return jid;
  const sibling = await siblingForJid(client, jid);
  return sibling?.endsWith("@s.whatsapp.net") ? sibling : jid;
}

/**
 * Canonical form of a relational memory's subjects: canonicalized, deduped, and
 * sorted so that a pair in either order is one memory.
 *
 * Sorted by JS default string order, which is UTF-16 code-unit order and matches
 * the `COLLATE "C"` byte order the database CHECK sorts by. JIDs are ASCII —
 * digits, `@`, and a lowercase host — so the two agree. If a non-ASCII value ever
 * reached here the CHECK would reject the row loudly rather than accept a
 * differently-ordered duplicate, which is the right direction to fail in.
 */
async function canonicalSubjectJids(
  client: pg.Pool | pg.PoolClient,
  jids: readonly string[],
): Promise<string[]> {
  const canonical = await Promise.all(jids.map((j) => canonicalSubjectJid(client, j)));
  return [...new Set(canonical)].sort();
}

/** The dedupe key columns and values for one memory kind. */
function dedupeTarget(subject: MemorySubject, canonicalSubject: string[] | string | null) {
  switch (subject.memoryType) {
    case "episodic":
      return {
        columns: ["group_id", "subject_jid", "content_hash"],
        extraColumns: ["subject_jid"],
        extraValues: [canonicalSubject as string | null],
      };
    case "semantic":
      return {
        columns: ["group_id", "subject_jid", "content_hash"],
        extraColumns: ["subject_jid"],
        extraValues: [canonicalSubject as string],
      };
    case "relational":
      return {
        columns: ["group_id", "subject_jids", "content_hash"],
        extraColumns: ["subject_jids"],
        extraValues: [canonicalSubject as string[]],
      };
    case "self_state":
      return {
        columns: ["group_id", "facet", "content_hash"],
        extraColumns: ["facet"],
        extraValues: [subject.facet],
      };
  }
}

async function resolveCanonicalSubject(
  client: pg.PoolClient,
  draft: MemoryDraft,
): Promise<string[] | string | null> {
  switch (draft.memoryType) {
    case "episodic":
      return draft.subjectJid ? await canonicalSubjectJid(client, draft.subjectJid) : null;
    case "semantic":
      return await canonicalSubjectJid(client, draft.subjectJid);
    case "relational":
      return await canonicalSubjectJids(client, draft.subjectJids);
    case "self_state":
      return null;
  }
}

// ── Write path ────────────────────────────────────────────────────────────

/**
 * Record one belief together with the messages behind it, as a single unit.
 *
 * Returns `null` when nothing was written because none of the cited messages
 * exist in this group. That is a NORMAL outcome, not an error: the extractor is
 * an LLM and will sometimes cite an id it invented or one from another chat.
 * Callers count these — the reject rate is the signal for whether the extractor
 * is good enough for the read path to trust.
 *
 * Throws on a caller bug: empty content, or an empty evidence list. Those are not
 * data outcomes the extractor can produce, they are a writer that forgot the
 * invariant, and silently returning `null` would hide it.
 *
 * TAKES A POOL, NOT A CLIENT, and that is the point. This function owns its
 * transaction. Handed a pool, a caller cannot accidentally run the memory insert
 * and the evidence insert on two different connections and leave a belief
 * standing with nothing behind it. The cost is that it cannot be composed into a
 * larger transaction; no caller needs that, and the invariant is worth more.
 *
 * CONVERGENCE. A second run over the same window hits the dedupe key and returns
 * the existing row with `created: false`, adding any evidence it did not already
 * have. A REVOKED row still occupies its dedupe slot, so re-extraction cannot
 * resurrect a withdrawn belief — it converges onto the revoked row and adds
 * nothing. Revocation is sticky by construction rather than by a later filter.
 */
export async function createMemory(
  pool: pg.Pool,
  draft: MemoryDraft,
): Promise<MemoryWriteResult | null> {
  const content = draft.content.trim();
  if (content.length === 0) {
    throw new Error("createMemory: content is empty");
  }
  if (draft.evidence.length === 0) {
    throw new Error("createMemory: a memory cannot be written without evidence");
  }

  const table = TABLE_FOR[draft.memoryType];
  const contentHash = memoryContentHash(content);
  const messageIds = draft.evidence.map((e) => e.messageId);
  const stances = draft.evidence.map((e) => e.stance);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const canonicalSubject = await resolveCanonicalSubject(client, draft);
    const target = dedupeTarget(draft, canonicalSubject);

    // `observed_at` is DERIVED from the cited messages, scoped to this group — a
    // caller cannot supply it. No matching message means there is nothing to
    // believe from, and the memory is never inserted at all.
    const { rows: windowRows } = await client.query<{ observed_at: Date | null }>(
      `SELECT max(sent_at) AS observed_at
         FROM messages
        WHERE id = ANY($1::bigint[]) AND group_id = $2`,
      [messageIds, draft.groupId],
    );
    const observedAt = windowRows[0]?.observed_at ?? null;
    if (observedAt === null) {
      await client.query("ROLLBACK");
      return null;
    }

    const columns = ["group_id", ...target.extraColumns, "content", "content_hash", "observed_at"];
    const values = [
      draft.groupId,
      ...target.extraValues,
      content,
      contentHash,
      observedAt,
    ] as unknown[];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (${target.columns.join(", ")}) DO NOTHING
       RETURNING id`,
      values,
    );

    let id: number;
    let created: boolean;
    if (inserted[0]) {
      id = Number(inserted[0].id);
      created = true;
    } else {
      const { rows: existing } = await client.query<{ id: string; revoked_at: Date | null }>(
        `SELECT id, revoked_at FROM ${table}
          WHERE group_id = $1 AND content_hash = $2
            AND ${target.extraColumns[0]} IS NOT DISTINCT FROM $3`,
        [draft.groupId, contentHash, target.extraValues[0]],
      );
      const row = existing[0];
      if (!row) {
        // The dedupe fired but the row is not findable — a schema/key mismatch,
        // not a data outcome. Fail loudly rather than return a fabricated id.
        throw new Error(`createMemory: dedupe conflict on ${table} with no matching row`);
      }
      id = Number(row.id);
      created = false;
      if (row.revoked_at !== null) {
        // Converged onto a withdrawn belief. Do not feed it new evidence.
        await client.query("COMMIT");
        return { id, created: false, evidenceRecorded: 0 };
      }
    }

    // Evidence is written FROM `messages`, so a cited id that is not a real
    // message in this group contributes nothing and `observed_at` cannot be
    // invented. Repeat citations collide with the primary key and are absorbed.
    const { rowCount } = await client.query(
      `INSERT INTO aida_memory_evidence (memory_type, memory_id, message_id, stance, observed_at)
       SELECT $1, $2, m.id, v.stance, m.sent_at
         FROM unnest($3::bigint[], $4::text[]) AS v(message_id, stance)
         JOIN messages m ON m.id = v.message_id
        WHERE m.group_id = $5
       ON CONFLICT DO NOTHING`,
      [draft.memoryType, id, messageIds, stances, draft.groupId],
    );
    const evidenceRecorded = rowCount ?? 0;

    // THE INVARIANT. A memory this call created with nothing behind it must not
    // survive the call. Only checked for a fresh row: a converged one already has
    // the evidence of the run that created it.
    if (created && evidenceRecorded === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("COMMIT");
    return { id, created, evidenceRecorded };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Supersede and revoke ──────────────────────────────────────────────────

/**
 * Point a memory at the newer one that replaced it. Returns whether it landed.
 *
 * Guarded to `superseded_by_id IS NULL`, so this can only ever move a row from
 * unset to set. Re-pointing an already-superseded row at a different replacement
 * would rewrite the very history this column exists to keep, so it returns false
 * instead. Self-supersede is rejected for the same reason.
 *
 * Within one table by construction — both ids name rows in the same kind, which
 * is why the supersede pointer is a plain self-reference and not polymorphic.
 * Contradiction BETWEEN kinds is not a pointer; it is resolved at read time by
 * the precedence rule, where raw history beats memory.
 */
export async function supersedeMemory(
  client: pg.Pool | pg.PoolClient,
  input: { memoryType: MemoryType; memoryId: number; replacedById: number },
): Promise<boolean> {
  if (input.memoryId === input.replacedById) return false;
  const table = TABLE_FOR[input.memoryType];
  const { rowCount } = await client.query(
    `UPDATE ${table}
        SET superseded_by_id = $2
      WHERE id = $1 AND superseded_by_id IS NULL`,
    [input.memoryId, input.replacedById],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Withdraw a belief and everything downstream of it. Returns how many rows were
 * stamped.
 *
 * A revoked memory is unusable, not gone — the record of the mistake has to
 * outlive the mistake, or the audit trail this feature exists to produce is
 * destroyed by the act of cleaning up.
 *
 * DESCENDANTS GO WITH IT. Following `superseded_by_id` forward gives the newer
 * rows this belief was refined into; revoking the root while leaving those live
 * would withdraw a claim and keep its restatement, which is containment that does
 * not contain. The walk is a recursive CTE over the chain, and `UNION` (not
 * `UNION ALL`) terminates it even if a chain were ever cyclic.
 *
 * Already-revoked rows are left alone rather than re-stamped, so the timestamp
 * keeps saying when the belief was actually withdrawn.
 */
export async function revokeMemory(
  client: pg.Pool | pg.PoolClient,
  input: { memoryType: MemoryType; memoryId: number; revokedByParticipantId?: number | null },
): Promise<number> {
  const table = TABLE_FOR[input.memoryType];
  const { rowCount } = await client.query(
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by_id FROM ${table} WHERE id = $1
       UNION
       SELECT m.id, m.superseded_by_id
         FROM ${table} m
         JOIN chain c ON m.id = c.superseded_by_id
     )
     UPDATE ${table} t
        SET revoked_at = now(), revoked_by_participant_id = $2
       FROM chain
      WHERE t.id = chain.id AND t.revoked_at IS NULL`,
    [input.memoryId, input.revokedByParticipantId ?? null],
  );
  return rowCount ?? 0;
}

// ── Read path ─────────────────────────────────────────────────────────────

/** A live memory as the default read returns it, with its evidence weighed. */
export type StoredMemory = {
  id: number;
  memoryType: MemoryType;
  content: string;
  /** The people it is about. Empty for a group-wide event or a self-state row. */
  subjectJids: string[];
  /** Only set for `self_state`. */
  facet: SelfStateFacet | null;
  observedAt: Date;
  /** Messages that argue for this belief. */
  supportingEvidence: number;
  /** Messages that argue against it. */
  contradictingEvidence: number;
};

/**
 * Every live memory for one group, strongest and most recent first.
 *
 * REVOKED AND SUPERSEDED ROWS ARE EXCLUDED HERE, at the query layer rather than
 * by asking callers to filter. Reaching @Aida with a withdrawn belief should take
 * deliberate effort, and a default that leaks one would make the revoke command
 * decorative. The partial indexes on each table match this predicate exactly.
 *
 * Ranked by supporting evidence, then recency. That ordering IS the confidence
 * this schema refuses to store as a number: it is derived from rows anyone can
 * count, and it moves when the evidence moves.
 *
 * `memory_type` breaks the remaining tie before `id` does, and it has to: the four
 * tables have four independent sequences, so an id alone means nothing across a
 * union of them and two equally-supported rows from different tables would come
 * back in whatever order the planner felt like. The choice of which kind sorts
 * first is arbitrary; that the order is stable at all is not.
 */
export async function listLiveMemories(
  client: pg.Pool | pg.PoolClient,
  input: { groupId: number; limit?: number },
): Promise<StoredMemory[]> {
  const branches = (Object.keys(TABLE_FOR) as MemoryType[]).map((memoryType) => {
    const table = TABLE_FOR[memoryType];
    const subjects =
      memoryType === "relational"
        ? "m.subject_jids"
        : memoryType === "semantic" || memoryType === "episodic"
          ? "CASE WHEN m.subject_jid IS NULL THEN ARRAY[]::text[] ELSE ARRAY[m.subject_jid] END"
          : "ARRAY[]::text[]";
    const facet = memoryType === "self_state" ? "m.facet" : "NULL::text";
    return `
      SELECT m.id, '${memoryType}'::text AS memory_type, m.content, ${subjects} AS subject_jids,
             ${facet} AS facet, m.observed_at,
             e.supporting, e.contradicting
        FROM ${table} m
        JOIN LATERAL (
          SELECT count(*) FILTER (WHERE stance = 'supports') AS supporting,
                 count(*) FILTER (WHERE stance = 'contradicts') AS contradicting
            FROM aida_memory_evidence
           WHERE memory_type = '${memoryType}' AND memory_id = m.id
        ) e ON true
       WHERE m.group_id = $1 AND m.revoked_at IS NULL AND m.superseded_by_id IS NULL`;
  });

  const { rows } = await client.query<{
    id: string;
    memory_type: MemoryType;
    content: string;
    subject_jids: string[];
    facet: SelfStateFacet | null;
    observed_at: Date;
    supporting: string;
    contradicting: string;
  }>(
    `${branches.join("\n      UNION ALL")}
     ORDER BY supporting DESC, observed_at DESC, memory_type ASC, id DESC
     LIMIT $2`,
    [input.groupId, input.limit ?? 200],
  );

  return rows.map((r) => ({
    id: Number(r.id),
    memoryType: r.memory_type,
    content: r.content,
    subjectJids: r.subject_jids,
    facet: r.facet,
    observedAt: r.observed_at,
    supportingEvidence: Number(r.supporting),
    contradictingEvidence: Number(r.contradicting),
  }));
}
