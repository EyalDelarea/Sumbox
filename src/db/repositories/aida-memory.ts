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
  /**
   * Why a human wrote this row, when one did.
   *
   * Absent for anything the extractor produced, which is what makes its presence
   * the only signal separating a human-written belief from an extracted one.
   */
  correctionNote?: string;
};

/**
 * What a write actually did.
 *
 * Three outcomes rather than a boolean, because `converged` and
 * `converged_onto_revoked` are the same shape and opposite meanings: one says
 * "already recorded, nothing to add", the other says "this belief was WITHDRAWN
 * and the evidence you brought was thrown away". Collapsing them would hide the
 * one number worth watching — how often the extractor keeps re-proposing a belief
 * a human already revoked, which is the signal that revocation is not reaching it.
 */
export type MemoryWriteOutcome = "created" | "converged" | "converged_onto_revoked";

export type MemoryWriteResult = {
  id: number;
  outcome: MemoryWriteOutcome;
  /** How many citations the caller offered. */
  citationsOffered: number;
  /**
   * How many became evidence rows on THIS call.
   *
   * Lower than `citationsOffered` for two different reasons — citations the
   * extractor invented, and citations already on file from an earlier run — so it
   * is a floor on what landed, not a hallucination count. Read it against
   * `outcome`: short on `created` means the model cited messages that do not
   * exist here; short on `converged` usually just means a repeat run.
   */
  citationsRecorded: number;
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
    case "relational": {
      const subjects = await canonicalSubjectJids(client, draft.subjectJids);
      // Canonicalization can COLLAPSE the list — two lids linked to one phone JID,
      // or a lid plus its own phone sibling, which an extractor reading a roster
      // that carries both forms produces routinely. The CHECK would reject the row
      // with a constraint name that explains nothing; say what actually happened.
      if (subjects.length < 2) {
        throw new Error(
          `createMemory: relational subjects collapsed to ${subjects.length} distinct ` +
            `identity after canonicalization (from ${draft.subjectJids.length} offered) — ` +
            "a relationship needs two different people",
        );
      }
      return subjects;
    }
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
  // One message takes ONE stance per belief — the ledger's primary key says so, and
  // `ON CONFLICT DO NOTHING` would absorb the second silently, leaving whichever
  // stance the model happened to list first. That would let a reordering of the
  // extractor's own output flip a belief between supported and contradicted, which
  // is exactly what the ledger records a stance to prevent. Reject it loudly.
  const stanceByMessage = new Map<number, EvidenceStance>();
  for (const e of draft.evidence) {
    const seen = stanceByMessage.get(e.messageId);
    if (seen !== undefined && seen !== e.stance) {
      throw new Error(
        `createMemory: message ${e.messageId} is cited as both "${seen}" and "${e.stance}"`,
      );
    }
    stanceByMessage.set(e.messageId, e.stance);
  }

  const table = TABLE_FOR[draft.memoryType];
  const contentHash = memoryContentHash(content);
  const messageIds = draft.evidence.map((e) => e.messageId);
  const stances = draft.evidence.map((e) => e.stance);

  const client = await pool.connect();
  let released = false;
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
      // `null` is reserved for "the extractor cited nothing real here", which is a
      // rate worth measuring. A groupId that does not exist would inflate that same
      // number with a caller bug, so separate the two before returning — one extra
      // query, and only on the path that was going to reject anyway.
      const { rows: groupRows } = await client.query(`SELECT 1 FROM groups WHERE id = $1`, [
        draft.groupId,
      ]);
      await client.query("ROLLBACK");
      if (groupRows.length === 0) {
        throw new Error(`createMemory: no such group ${draft.groupId}`);
      }
      return null;
    }

    const columns = [
      "group_id",
      ...target.extraColumns,
      "content",
      "content_hash",
      "observed_at",
      "correction_note",
    ];
    const values = [
      draft.groupId,
      ...target.extraValues,
      content,
      contentHash,
      observedAt,
      draft.correctionNote ?? null,
    ] as unknown[];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (${target.columns.join(", ")}) WHERE superseded_by_id IS NULL DO NOTHING
       RETURNING id`,
      values,
    );

    let id: number;
    let outcome: MemoryWriteOutcome;
    if (inserted[0]) {
      id = Number(inserted[0].id);
      outcome = "created";
    } else {
      // The same predicate as the dedupe index, or this would find a superseded
      // row the index deliberately no longer covers.
      const { rows: existing } = await client.query<{ id: string; revoked_at: Date | null }>(
        `SELECT id, revoked_at FROM ${table}
          WHERE group_id = $1 AND content_hash = $2
            AND ${target.extraColumns[0]} IS NOT DISTINCT FROM $3
            AND superseded_by_id IS NULL`,
        [draft.groupId, contentHash, target.extraValues[0]],
      );
      const row = existing[0];
      if (!row) {
        // The dedupe fired but the row is not findable — a schema/key mismatch,
        // not a data outcome. Fail loudly rather than return a fabricated id.
        throw new Error(`createMemory: dedupe conflict on ${table} with no matching row`);
      }
      id = Number(row.id);
      if (row.revoked_at !== null) {
        // Converged onto a withdrawn belief. Do not feed it new evidence.
        await client.query("COMMIT");
        return {
          id,
          outcome: "converged_onto_revoked",
          citationsOffered: draft.evidence.length,
          citationsRecorded: 0,
        };
      }
      outcome = "converged";
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
    const citationsRecorded = rowCount ?? 0;

    // THE INVARIANT. A memory this call created with nothing behind it must not
    // survive the call. Only checked for a fresh row: a converged one already has
    // the evidence of the run that created it.
    if (outcome === "created" && citationsRecorded === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("COMMIT");
    return { id, outcome, citationsOffered: draft.evidence.length, citationsRecorded };
  } catch (err) {
    // A ROLLBACK that itself fails leaves this connection inside an aborted
    // transaction. Releasing it clean would put it back in the idle pool, and the
    // next unrelated query in the process would fail with "current transaction is
    // aborted" in a stack trace nowhere near here. Release WITH the error so the
    // pool destroys the connection instead of reusing it.
    let rollbackFailed = false;
    await client.query("ROLLBACK").catch(() => {
      rollbackFailed = true;
    });
    client.release(rollbackFailed ? (err as Error) : undefined);
    released = true;
    throw err;
  } finally {
    if (!released) client.release();
  }
}

// ── Supersede and revoke ──────────────────────────────────────────────────

/**
 * Why a supersede was refused, when it was.
 *
 * Not a boolean, because the four refusals mean different things and a caller
 * that cannot tell them apart cannot tell a race ("someone already replaced this")
 * from a bug ("you named a row in another chat").
 */
export type SupersedeOutcome =
  | "superseded"
  | "already_superseded"
  | "not_found"
  | "cross_group"
  | "would_cycle";

/**
 * Point a memory at the newer one that replaced it.
 *
 * Guarded to `superseded_by_id IS NULL`, so this can only ever move a row from
 * unset to set. Re-pointing an already-superseded row at a different replacement
 * would rewrite the very history this column exists to keep.
 *
 * SCOPED TO ONE GROUP, and the caller has to say which. Memory is per-group —
 * that is the privacy boundary — but the foreign key only confines the pointer to
 * the same TABLE, so nothing in the schema stops a chain from leaving the chat it
 * belongs to. Left unguarded that is not cosmetic: `revokeMemory` follows the
 * chain, so withdrawing a belief in one chat would silently withdraw one in
 * another, and `ON DELETE SET NULL` means purging the second chat would quietly
 * un-supersede the first belief and bring it back to life.
 *
 * REFUSES A CYCLE. `a → b` then `b → a` passes a per-row guard — at the second
 * call `b` is still the head of its chain — and leaves BOTH rows superseded, so a
 * live belief disappears from every default read with no way back. The walk
 * forward from the replacement catches it, along with the degenerate self-pointer.
 *
 * WHAT THIS STILL CANNOT CATCH: the four tables have four independent sequences,
 * so a low id exists in all of them and a caller that pairs the right id with the
 * wrong `memoryType` names a real, unrelated row. Requiring the group narrows the
 * blast radius to a collision inside one chat; it does not close it. A caller
 * should carry the pair it read from {@link listLiveMemories}, never re-type an id.
 */
export async function supersedeMemory(
  client: pg.Pool | pg.PoolClient,
  input: { memoryType: MemoryType; groupId: number; memoryId: number; replacedById: number },
): Promise<SupersedeOutcome> {
  const table = TABLE_FOR[input.memoryType];
  const { rows } = await client.query<{ id: string; superseded_by_id: string | null }>(
    `SELECT id, superseded_by_id FROM ${table} WHERE id = ANY($1::bigint[]) AND group_id = $2`,
    [[input.memoryId, input.replacedById], input.groupId],
  );
  const found = new Map(rows.map((r) => [Number(r.id), r]));
  const target = found.get(input.memoryId);
  if (!target || !found.has(input.replacedById)) {
    // Either id may be missing outright or sitting in another chat; from here the
    // two are indistinguishable, and `cross_group` is the more useful guess only
    // when both rows exist somewhere.
    return (await existsAnywhere(client, table, [input.memoryId, input.replacedById]))
      ? "cross_group"
      : "not_found";
  }
  if (target.superseded_by_id !== null) return "already_superseded";

  const { rowCount } = await client.query(
    `WITH RECURSIVE forward AS (
       SELECT id, superseded_by_id FROM ${table} WHERE id = $2 AND group_id = $3
       UNION
       SELECT m.id, m.superseded_by_id
         FROM ${table} m
         JOIN forward f ON m.id = f.superseded_by_id
     )
     UPDATE ${table} t
        SET superseded_by_id = $2
      WHERE t.id = $1
        AND t.group_id = $3
        AND t.superseded_by_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM forward WHERE forward.id = t.id)`,
    [input.memoryId, input.replacedById, input.groupId],
  );
  return (rowCount ?? 0) > 0 ? "superseded" : "would_cycle";
}

/** Do these ids exist in this table at all, in any group? Only used to explain a refusal. */
async function existsAnywhere(
  client: pg.Pool | pg.PoolClient,
  table: string,
  ids: number[],
): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return Number(rows[0]?.n) === ids.length;
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
 * THE WALK IS SCOPED TO THE GROUP, not just seeded inside it. `supersedeMemory`
 * refuses to build a chain that leaves the chat, but this is the function that
 * would pay for it if one ever existed, so it re-asserts the boundary rather than
 * trusting the writer — a withdrawal in one chat must never reach another.
 *
 * Already-revoked rows are left alone rather than re-stamped, so the timestamp
 * keeps saying when the belief was actually withdrawn.
 */
export async function revokeMemory(
  client: pg.Pool | pg.PoolClient,
  input: {
    memoryType: MemoryType;
    groupId: number;
    memoryId: number;
    revokedByParticipantId?: number | null;
  },
): Promise<number> {
  const table = TABLE_FOR[input.memoryType];
  const { rowCount } = await client.query(
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by_id FROM ${table} WHERE id = $1 AND group_id = $3
       UNION
       SELECT m.id, m.superseded_by_id
         FROM ${table} m
         JOIN chain c ON m.id = c.superseded_by_id
        WHERE m.group_id = $3
     )
     UPDATE ${table} t
        SET revoked_at = now(), revoked_by_participant_id = $2
       FROM chain
      WHERE t.id = chain.id AND t.revoked_at IS NULL`,
    [input.memoryId, input.revokedByParticipantId ?? null, input.groupId],
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
  /**
   * Messages that argue for this belief.
   *
   * ZERO IS MEANINGFUL, and it is the one value a consumer must not render like
   * any other. It says every message this belief was traced to has been deleted,
   * so the claim can no longer be checked against anything — the unfalsifiable
   * assertion the evidence ledger exists to make impossible. The row is kept
   * rather than removed on purpose (the record must show it lost its support),
   * which is exactly why the surface showing it has to say so.
   */
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
 *
 * THE LIMIT TRUNCATES SILENTLY, and this is a general-purpose read, not the read
 * path. Slice 5 forces `self_state` into every turn; it must NOT do that through
 * this function, whose global evidence ranking would let a one-message behaviour
 * rule fall off the end once a chatty group accumulates better-cited memories.
 * That query wants its own, scoped to the facet and taking the newest rows.
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

// ── The review surface ────────────────────────────────────────────────────

/** A memory as the review screen shows it: across groups, withdrawal visible. */
export type MemoryForReview = StoredMemory & {
  groupId: number;
  groupName: string;
  /** Why a human overruled her. Null means the extractor wrote this row. */
  correctionNote: string | null;
  /** Set when a newer row replaced this one. */
  supersededById: number | null;
  /** Set when a human withdrew it. */
  revokedAt: Date | null;
  /**
   * The earliest message this belief cites, or null when every one has been
   * deleted.
   *
   * Carried so the review surface can open the conversation on it in one tap. A
   * belief you cannot check against what was actually said is the failure this
   * whole design exists to prevent, so the check must not be a second request.
   */
  firstSourceMessageId: number | null;
};

/** Rows plus whether the cap hid any. */
export type MemoryReviewPage = {
  rows: MemoryForReview[];
  /**
   * More memories exist than were returned.
   *
   * The cap keeps the NEWEST, and nothing in this schema is ever deleted, so the
   * rows it hides are the OLDEST — which is exactly the set the withdrawn toggle
   * exists to reach. A screen that truncated silently would quietly stop being
   * the complete record it promises to be.
   */
  truncated: boolean;
};

export type ReviewFilter = {
  /** One chat, or every chat when omitted. */
  groupId?: number;
  memoryType?: MemoryType;
  /**
   * Include rows a human already withdrew or replaced.
   *
   * A SEPARATE ARGUMENT rather than a default, because the screen's job is "what
   * does she believe now" and a default that leaked a withdrawn belief into that
   * would make the revoke button decorative. The rows are kept forever precisely
   * so they can be read, so the option exists — it just has to be asked for.
   */
  includeWithdrawn?: boolean;
  limit?: number;
};

/**
 * Every memory the review screen needs, across chats.
 *
 * Distinct from {@link listLiveMemories}, which answers "what does @Aida believe
 * in THIS chat" for the read path. This one answers "what is on file, and what
 * did a human do about it", carries the chat's name so a belief is never read out
 * of the context that produced it, and can reach withdrawn rows.
 */
export async function listMemoriesForReview(
  client: pg.Pool | pg.PoolClient,
  filter: ReviewFilter = {},
): Promise<MemoryReviewPage> {
  const limit = filter.limit ?? 200;
  const types = filter.memoryType ? [filter.memoryType] : (Object.keys(TABLE_FOR) as MemoryType[]);
  const withdrawal = filter.includeWithdrawn
    ? ""
    : "AND m.revoked_at IS NULL AND m.superseded_by_id IS NULL";

  const branches = types.map((memoryType) => {
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
             ${facet} AS facet, m.observed_at, m.group_id, g.name AS group_name,
             m.correction_note, m.superseded_by_id, m.revoked_at,
             e.supporting, e.contradicting, e.first_source
        FROM ${table} m
        JOIN groups g ON g.id = m.group_id
        JOIN LATERAL (
          SELECT count(*) FILTER (WHERE stance = 'supports') AS supporting,
                 count(*) FILTER (WHERE stance = 'contradicts') AS contradicting,
                 min(message_id) FILTER (WHERE stance = 'supports') AS first_source
            FROM aida_memory_evidence
           WHERE memory_type = '${memoryType}' AND memory_id = m.id
        ) e ON true
       WHERE ($1::bigint IS NULL OR m.group_id = $1) ${withdrawal}`;
  });

  const { rows } = await client.query<{
    id: string;
    memory_type: MemoryType;
    content: string;
    subject_jids: string[];
    facet: SelfStateFacet | null;
    observed_at: Date;
    group_id: string;
    group_name: string;
    correction_note: string | null;
    superseded_by_id: string | null;
    revoked_at: Date | null;
    supporting: string;
    contradicting: string;
    first_source: string | null;
  }>(
    `${branches.join("\n      UNION ALL")}
     ORDER BY observed_at DESC, memory_type ASC, id DESC
     LIMIT $2`,
    // One more than the cap, so "there are more" is distinguishable from "there
    // are exactly this many" — see the same trick in `selectCandidates`.
    [filter.groupId ?? null, limit + 1],
  );

  const truncated = rows.length > limit;
  return {
    truncated,
    rows: (truncated ? rows.slice(0, limit) : rows).map((r) => ({
      id: Number(r.id),
      memoryType: r.memory_type,
      content: r.content,
      subjectJids: r.subject_jids,
      facet: r.facet,
      observedAt: r.observed_at,
      supportingEvidence: Number(r.supporting),
      contradictingEvidence: Number(r.contradicting),
      groupId: Number(r.group_id),
      groupName: r.group_name,
      correctionNote: r.correction_note,
      supersededById: r.superseded_by_id === null ? null : Number(r.superseded_by_id),
      revokedAt: r.revoked_at,
      firstSourceMessageId:
        r.first_source === null || r.first_source === undefined ? null : Number(r.first_source),
    })),
  };
}

/** Which messages a memory cites, so a correction can inherit them. */
export async function listMemoryEvidence(
  client: pg.Pool | pg.PoolClient,
  input: { memoryType: MemoryType; memoryId: number },
): Promise<{ messageId: number; stance: EvidenceStance }[]> {
  const { rows } = await client.query<{ message_id: string; stance: EvidenceStance }>(
    `SELECT message_id, stance FROM aida_memory_evidence
      WHERE memory_type = $1 AND memory_id = $2
      ORDER BY observed_at, message_id`,
    [input.memoryType, input.memoryId],
  );
  return rows.map((r) => ({ messageId: Number(r.message_id), stance: r.stance }));
}

export type CorrectionOutcome =
  | { ok: true; memoryId: number }
  | {
      ok: false;
      reason:
        | "not_found"
        | "already_revoked"
        | "already_superseded"
        | "no_evidence"
        | "duplicate"
        | "supersede_failed";
    };

/**
 * Replace a belief with your own wording, and say why.
 *
 * WRITES A NEW ROW AND POINTS THE OLD ONE AT IT. The original is never edited —
 * the record has to show what she thought, and when you stopped agreeing.
 *
 * THE CORRECTION INHERITS THE ORIGINAL'S CITATIONS, because it has none of its
 * own: a correction is YOUR reading of the same messages she read. A correction
 * learned from a later conversation is a different thing and belongs to the
 * extractor, which can cite the message that changed it.
 *
 * THE NOTE IS REQUIRED. It is also the only thing distinguishing a human-written
 * row from an extracted one, so an empty one would make your correction look like
 * her conclusion — see the `correction-note` migration.
 *
 * NOT ONE TRANSACTION, and it cannot be: `createMemory` owns its own, which is
 * what makes "no memory without evidence" enforceable. So if the supersede fails
 * the new row is withdrawn again immediately, rather than left standing beside
 * the belief it was meant to replace where the screen would show both.
 */
export async function correctMemory(
  pool: pg.Pool,
  input: {
    memoryType: MemoryType;
    groupId: number;
    memoryId: number;
    content: string;
    note: string;
  },
): Promise<CorrectionOutcome> {
  const content = input.content.trim();
  const note = input.note.trim();
  if (content.length === 0) throw new Error("correctMemory: content is empty");
  if (note.length === 0) throw new Error("correctMemory: a correction must say why");

  const table = TABLE_FOR[input.memoryType];
  // The correction keeps the original's subject: it is the same claim about the
  // same people, worded differently. Re-deriving it would be a second chance to
  // attribute it to somebody else.
  const subjectColumn =
    input.memoryType === "relational"
      ? "subject_jids"
      : input.memoryType === "self_state"
        ? "facet"
        : "subject_jid";
  const { rows } = await pool.query<{
    revoked_at: Date | null;
    superseded_by_id: string | null;
    subject: string | string[] | null;
  }>(
    `SELECT revoked_at, superseded_by_id, ${subjectColumn} AS subject
       FROM ${table} WHERE id = $1 AND group_id = $2`,
    [input.memoryId, input.groupId],
  );
  const original = rows[0];
  if (!original) return { ok: false, reason: "not_found" };
  // Told apart because the remedies differ: a withdrawn belief is finished, while
  // a replaced one has a live head the user should be correcting instead.
  if (original.revoked_at !== null) return { ok: false, reason: "already_revoked" };
  if (original.superseded_by_id !== null) {
    // Correcting a replaced row would fork the chain into two live heads.
    return { ok: false, reason: "already_superseded" };
  }

  // Decide `duplicate` BEFORE writing, not after. `createMemory` COMMITS on the
  // converge path — it writes the inherited citations onto whatever row it
  // collided with and returns "converged" — so refusing afterwards would report
  // "nothing was written" about a transaction that had already landed.
  //
  // When the collision is with the original itself (someone "corrects" a belief
  // to what it already says) the citations are the same rows and nothing moves.
  // But the dedupe key is (group, subject, content_hash), so the collision can be
  // with a DIFFERENT live belief — most easily a `self_state` row, whose key is
  // just (group, facet, hash), or a subject-less `episodic` one. Then the
  // original's whole evidence ledger, contradictions included, lands on somebody
  // else's belief and permanently changes how it ranks at read time, while the
  // caller is told the correction was refused.
  const { rows: collision } = await pool.query<{ id: string }>(
    `SELECT id FROM ${table}
      WHERE group_id = $1 AND content_hash = $2
        AND ${subjectColumn} IS NOT DISTINCT FROM $3
        AND superseded_by_id IS NULL`,
    [input.groupId, memoryContentHash(content), original.subject],
  );
  if (collision.length > 0) return { ok: false, reason: "duplicate" };

  // ONLY THE SUPPORTING CITATIONS CARRY OVER. A stance is assigned relative to a
  // particular wording: a message she recorded as CONTRADICTING her phrasing says
  // nothing about yours, and is very often the message that prompted the
  // correction. Copying it across would write the correction carrying evidence
  // against itself, and rendering it would show contradictions of text that no
  // longer exists on the live head. Re-stamping them as supporting would be worse
  // — it would put an assertion in your mouth that you never made.
  const evidence = (await listMemoryEvidence(pool, input)).filter((e) => e.stance === "supports");
  if (evidence.length === 0) {
    // Either every cited message has been deleted, or none of them supported the
    // belief in the first place. In both cases a correction has nothing to stand
    // on, and `createMemory` would refuse it. Revoking is the honest action on a
    // belief that can no longer be checked against anything.
    return { ok: false, reason: "no_evidence" };
  }

  const subject =
    input.memoryType === "relational"
      ? { memoryType: "relational" as const, subjectJids: original.subject as string[] }
      : input.memoryType === "self_state"
        ? { memoryType: "self_state" as const, facet: original.subject as SelfStateFacet }
        : input.memoryType === "semantic"
          ? { memoryType: "semantic" as const, subjectJid: original.subject as string }
          : { memoryType: "episodic" as const, subjectJid: original.subject as string | null };

  const written = await createMemory(pool, {
    ...subject,
    groupId: input.groupId,
    content,
    evidence,
    correctionNote: note,
  });
  if (written === null) return { ok: false, reason: "no_evidence" };
  if (written.outcome !== "created") {
    // The pre-check above should have caught this. Reaching here means a
    // concurrent write took the dedupe slot between the check and the insert —
    // rare, and not something to report as a tidy refusal, because citations may
    // already have landed on a row this call did not create.
    throw new Error(
      `correctMemory: raced onto an existing ${input.memoryType} memory ${written.id}`,
    );
  }

  const outcome = await supersedeMemory(pool, {
    memoryType: input.memoryType,
    groupId: input.groupId,
    memoryId: input.memoryId,
    replacedById: written.id,
  });
  if (outcome !== "superseded") {
    // The replacement is live and points at nothing, so the screen would show it
    // beside the belief it was meant to replace. Withdrawing it is the whole
    // reason this branch exists — so CHECK that it happened. Swallowing a failed
    // or no-op revoke here would leave a live orphan carrying the user's wording
    // and their correction note, while telling them the correction failed.
    const undone = await revokeMemory(pool, {
      memoryType: input.memoryType,
      groupId: input.groupId,
      memoryId: written.id,
    }).catch(() => 0);
    if (undone === 0) {
      throw new Error(
        `correctMemory: supersede of ${input.memoryId} failed (${outcome}) and the ` +
          `replacement ${written.id} could not be withdrawn — a live orphan correction ` +
          `now exists on ${table}`,
      );
    }
    return { ok: false, reason: "supersede_failed" };
  }
  return { ok: true, memoryId: written.id };
}
