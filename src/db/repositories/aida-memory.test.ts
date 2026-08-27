import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import type { EvidenceStance, MemoryWriteResult } from "./aida-memory.js";
import {
  canonicalSubjectJid,
  correctMemory,
  createMemory,
  listLiveMemories,
  listMemoriesForReview,
  memoryContentHash,
  revokeMemory,
  supersedeMemory,
} from "./aida-memory.js";
import { upsertGroup } from "./groups.js";
import { recordLink } from "./identity-links.js";

/**
 * These tests assert SAFETY PROPERTIES against a real database, not column types
 * or index names. What they are trying to catch is a write path that lets a
 * belief exist without sources, a withdrawal that leaves a restatement standing,
 * or a default read that hands back something already withdrawn.
 *
 * These were mutation-checked while being written — each invariant was
 * deliberately broken and the suite confirmed red — because on this stack a
 * safety test has already passed a mutation it should have caught. What was
 * broken, and what caught it:
 *
 *   committing the memory before its evidence → "takes the memory down with it"
 *   a single-row revoke instead of the chain   → "revokes … everything it was refined into"
 *   canonicalizing a JID in both directions    → the two identity cases
 *   dropping BOTH group scopes on the write    → "cited message belongs to another chat"
 *   committing a memory with zero evidence     → the same case, once the first
 *                                                 group scope is also weakened
 *
 * One deliberate non-finding worth recording: removing EITHER group scope alone
 * leaves the suite green, because the write path guards the same breach twice —
 * once when deriving `observed_at` and once when writing the ledger. The property
 * survives the mutation, so the test is right to stay green; it takes removing
 * both to actually let a cross-chat belief through, and that does go red.
 */
describe("aida-memory", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  // ── Fixtures ─────────────────────────────────────────────────────────────

  async function newGroup(name: string): Promise<number> {
    return await upsertGroup(pool, { name: `${name}-${randomUUID().slice(0, 8)}`, source: "live" });
  }

  async function newMessage(
    groupId: number,
    opts: { sentAt?: Date; senderJid?: string } = {},
  ): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages (group_id, source, message_type, sent_at, dedupe_key, sender_jid)
       VALUES ($1, 'live', 'text', COALESCE($2, now()), $3, $4) RETURNING id`,
      [groupId, opts.sentAt ?? null, `dk-${randomUUID()}`, opts.senderJid ?? null],
    );
    return Number(rows[0]?.id);
  }

  /**
   * `createMemory`, with "it actually wrote something" asserted rather than
   * assumed.
   *
   * Reaching for `written.id` instead let three cases in the first draft of
   * this file pass in a world where `createMemory` returns null unconditionally —
   * they revoked id 0, or asserted a count was 0, and were satisfied. That is the
   * failure mode the #83 handoff warns about: a test that passes without the write
   * path being correct. Every case that needs an id goes through here.
   */
  async function write(draft: Parameters<typeof createMemory>[1]): Promise<MemoryWriteResult> {
    const result = await createMemory(pool, draft);
    expect(result, "expected this write to land").not.toBeNull();
    return result as MemoryWriteResult;
  }

  async function evidenceCount(memoryType: string, memoryId: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM aida_memory_evidence
        WHERE memory_type = $1 AND memory_id = $2`,
      [memoryType, memoryId],
    );
    return Number(rows[0]?.n);
  }

  // ── The hash ─────────────────────────────────────────────────────────────

  it("hashes past trivial whitespace differences, so re-extraction can converge", () => {
    expect(memoryContentHash("  רוני  אוהב   קפה ")).toBe(memoryContentHash("רוני אוהב קפה"));
    expect(memoryContentHash("רוני אוהב קפה")).not.toBe(memoryContentHash("רוני אוהב תה"));
  });

  // ── A belief cannot exist without sources ────────────────────────────────

  it("refuses to write a memory with no evidence offered at all", async () => {
    const g = await newGroup("no-ev");
    await expect(
      createMemory(pool, {
        memoryType: "episodic",
        groupId: g,
        content: "משהו קרה",
        evidence: [],
      }),
    ).rejects.toThrow(/without evidence/);
    expect(await countRows("aida_episodic_memories", g)).toBe(0);
  });

  it("writes nothing when every cited message is invented", async () => {
    const g = await newGroup("ghost-ev");
    const result = await createMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      content: "משהו שלא נאמר מעולם",
      evidence: [{ messageId: 999_999_999, stance: "supports" }],
    });
    // null, not a throw: a hallucinated id is a normal extractor outcome to count.
    expect(result).toBeNull();
    expect(await countRows("aida_episodic_memories", g)).toBe(0);
  });

  it("writes nothing when the cited message belongs to another chat", async () => {
    const mine = await newGroup("scope-mine");
    const theirs = await newGroup("scope-theirs");
    const foreign = await newMessage(theirs);

    const result = await createMemory(pool, {
      memoryType: "semantic",
      groupId: mine,
      subjectJid: "111@s.whatsapp.net",
      content: "טענה שנשענת על צ'אט אחר",
      evidence: [{ messageId: foreign, stance: "supports" }],
    });

    expect(result).toBeNull();
    expect(await countRows("aida_semantic_memories", mine)).toBe(0);
    // And nothing leaked into the other chat's ledger either.
    expect(
      await evidenceCountForMessage(foreign),
      "a cross-chat citation must record no evidence",
    ).toBe(0);
  });

  it("takes the memory down with it when the evidence write fails", async () => {
    // The invariant no foreign key can express: a memory and its evidence are ONE
    // unit. Nothing about the memory row is wrong here — it inserts fine, and the
    // ledger write is what fails — so the only thing that can undo it is the
    // transaction boundary.
    //
    // Mutation-checked: committing the memory before writing evidence leaves the
    // row standing and turns this case red while every other test stays green.
    const g = await newGroup("tx-boundary");
    const m = await newMessage(g);
    await expect(
      createMemory(pool, {
        memoryType: "episodic",
        groupId: g,
        content: "אמונה בלי מקור",
        evidence: [{ messageId: m, stance: "invented" as EvidenceStance }],
      }),
    ).rejects.toThrow();
    expect(await countRows("aida_episodic_memories", g)).toBe(0);
    expect(await evidenceCountForMessage(m)).toBe(0);
  });

  it("derives observed_at from the cited messages rather than from the clock", async () => {
    const g = await newGroup("observed-at");
    const older = new Date("2026-01-01T10:00:00Z");
    const newer = new Date("2026-02-01T10:00:00Z");
    const a = await newMessage(g, { sentAt: older });
    const b = await newMessage(g, { sentAt: newer });

    const written = await write({
      memoryType: "episodic",
      groupId: g,
      content: "הטיול נדחה ליום ראשון",
      evidence: [
        { messageId: a, stance: "supports" },
        { messageId: b, stance: "supports" },
      ],
    });

    const { rows } = await pool.query<{ observed_at: Date }>(
      `SELECT observed_at FROM aida_episodic_memories WHERE id = $1`,
      [written.id],
    );
    expect(rows[0]?.observed_at.toISOString()).toBe(newer.toISOString());
  });

  // ── Subjects are identities, not names ───────────────────────────────────

  it("canonicalizes a linked lid to its phone JID, and leaves a phone JID alone", async () => {
    await recordLink(pool, {
      lidJid: "555@lid",
      pnJid: "972500000555@s.whatsapp.net",
      source: "bridge",
    });
    // Both directions, because siblingForJid returns THE OTHER identity — called
    // blindly it would rewrite the phone JID into the lid and mirror the split
    // instead of closing it.
    expect(await canonicalSubjectJid(pool, "555@lid")).toBe("972500000555@s.whatsapp.net");
    expect(await canonicalSubjectJid(pool, "972500000555@s.whatsapp.net")).toBe(
      "972500000555@s.whatsapp.net",
    );
  });

  it("leaves an unlinked lid as it is — two subjects beat one wrong one", async () => {
    expect(await canonicalSubjectJid(pool, "404@lid")).toBe("404@lid");
  });

  it("gives the same human under two WhatsApp identities one subject", async () => {
    const g = await newGroup("one-human");
    const m1 = await newMessage(g);
    const m2 = await newMessage(g);
    await recordLink(pool, {
      lidJid: "777@lid",
      pnJid: "972500000777@s.whatsapp.net",
      source: "bridge",
    });

    const viaLid = await write({
      memoryType: "semantic",
      groupId: g,
      subjectJid: "777@lid",
      content: "מגיע תמיד מאוחר",
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    const viaPn = await write({
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000777@s.whatsapp.net",
      content: "מגיע תמיד מאוחר",
      evidence: [{ messageId: m2, stance: "supports" }],
    });

    expect(viaPn.id).toBe(viaLid.id);
    expect(viaPn.outcome).toBe("converged");
    expect(await countRows("aida_semantic_memories", g)).toBe(1);
  });

  it("keeps two people who share a display name as two distinct subjects", async () => {
    const g = await newGroup("same-name");
    const m = await newMessage(g);
    // The display name is identical; the identities are not. Subjects key on the
    // identity, which is the whole reason they are JIDs and not participant ids.
    for (const jid of ["972500000001@s.whatsapp.net", "972500000002@s.whatsapp.net"]) {
      await write({
        memoryType: "semantic",
        groupId: g,
        subjectJid: jid,
        content: "קוראים לו רון",
        evidence: [{ messageId: m, stance: "supports" }],
      });
    }
    expect(await countRows("aida_semantic_memories", g)).toBe(2);
  });

  // ── Convergence ──────────────────────────────────────────────────────────

  it("converges instead of duplicating when the same window is extracted twice", async () => {
    const g = await newGroup("converge");
    const m = await newMessage(g);
    const draft = {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "888@s.whatsapp.net",
      content: "שותה קפה שחור",
      evidence: [{ messageId: m, stance: "supports" }],
    } as const;

    const first = await write(draft);
    const second = await write(draft);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("converged");
    expect(second.id).toBe(first.id);
    expect(second.citationsRecorded, "a repeat citation is one citation").toBe(0);
    expect(await countRows("aida_semantic_memories", g)).toBe(1);
    expect(await evidenceCount("semantic", first.id)).toBe(1);
  });

  it("converges on a subject-less episodic memory too", async () => {
    // The case Postgres gets wrong by default: NULLs are DISTINCT in a unique
    // index, so without NULLS NOT DISTINCT the second write inserts a second row
    // and the convergence above silently does not happen for group-wide events.
    const g = await newGroup("converge-null");
    const m = await newMessage(g);
    const draft = {
      memoryType: "episodic",
      groupId: g,
      content: "המפגש עבר ליום שלישי",
      evidence: [{ messageId: m, stance: "supports" }],
    } as const;

    await write(draft);
    const second = await write(draft);

    expect(second.outcome).toBe("converged");
    expect(await countRows("aida_episodic_memories", g)).toBe(1);
  });

  it("adds newly cited evidence to a memory it converged onto", async () => {
    const g = await newGroup("converge-more-ev");
    const m1 = await newMessage(g);
    const m2 = await newMessage(g);
    const base = {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "999@s.whatsapp.net",
      content: "לא אוכל בשר",
    } as const;

    const first = await write({
      ...base,
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    const second = await write({
      ...base,
      evidence: [{ messageId: m2, stance: "supports" }],
    });

    expect(second.id).toBe(first.id);
    expect(second.citationsRecorded).toBe(1);
    expect(await evidenceCount("semantic", first.id)).toBe(2);
  });

  // ── Relational order-independence ────────────────────────────────────────

  it("treats a relational memory about the same pair in either order as one memory", async () => {
    const g = await newGroup("pair-order");
    const m1 = await newMessage(g);
    const m2 = await newMessage(g);
    const content = "מתכננים ביחד את הטיול";

    const forward = await write({
      memoryType: "relational",
      groupId: g,
      subjectJids: ["972500000010@s.whatsapp.net", "972500000020@s.whatsapp.net"],
      content,
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    const reversed = await write({
      memoryType: "relational",
      groupId: g,
      subjectJids: ["972500000020@s.whatsapp.net", "972500000010@s.whatsapp.net"],
      content,
      evidence: [{ messageId: m2, stance: "supports" }],
    });

    expect(reversed.id).toBe(forward.id);
    expect(await countRows("aida_relational_memories", g)).toBe(1);
  });

  it("cannot store a relational memory that is about fewer than two people", async () => {
    // Structural, not conventional: the CHECK rejects it whatever the writer meant.
    // The empty-array case is the one that nearly slipped through — array_length
    // of an empty array is NULL, and a CHECK that evaluates to NULL passes.
    const g = await newGroup("pair-too-few");
    const m = await newMessage(g);
    for (const subjectJids of [[], ["972500000010@s.whatsapp.net"]]) {
      await expect(
        createMemory(pool, {
          memoryType: "relational",
          groupId: g,
          subjectJids,
          content: "יחס בין אף אחד",
          evidence: [{ messageId: m, stance: "supports" }],
        }),
      ).rejects.toThrow();
    }
    expect(await countRows("aida_relational_memories", g)).toBe(0);
  });

  // ── Evidence records both directions ─────────────────────────────────────

  it("records a contradicting message alongside a supporting one", async () => {
    const g = await newGroup("stances");
    const forIt = await newMessage(g);
    const againstIt = await newMessage(g);

    const written = await write({
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000030@s.whatsapp.net",
      content: "שונא ריצה",
      evidence: [
        { messageId: forIt, stance: "supports" },
        { messageId: againstIt, stance: "contradicts" },
      ],
    });

    const [memory] = await listLiveMemories(pool, { groupId: g });
    expect(written.citationsRecorded).toBe(2);
    expect(memory?.supportingEvidence).toBe(1);
    expect(memory?.contradictingEvidence).toBe(1);
  });

  // ── Supersede ────────────────────────────────────────────────────────────

  it("leaves the old belief present and unmodified when it is superseded", async () => {
    const g = await newGroup("supersede");
    const m = await newMessage(g);
    const old = await write({
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000040@s.whatsapp.net",
      content: "גר בתל אביב",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const fresh = await write({
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000040@s.whatsapp.net",
      content: "עבר לחיפה",
      evidence: [{ messageId: m, stance: "supports" }],
    });

    expect(
      await supersedeMemory(pool, {
        memoryType: "semantic",
        groupId: g,
        memoryId: old.id,
        replacedById: fresh.id,
      }),
    ).toBe("superseded");

    const { rows } = await pool.query<{ content: string; superseded_by_id: string }>(
      `SELECT content, superseded_by_id FROM aida_semantic_memories WHERE id = $1`,
      [old.id],
    );
    expect(rows[0]?.content, "the replaced belief is never rewritten").toBe("גר בתל אביב");
    expect(Number(rows[0]?.superseded_by_id)).toBe(fresh.id);
  });

  it("refuses to re-point an already-superseded memory, or to point one at itself", async () => {
    const g = await newGroup("supersede-guard");
    const m = await newMessage(g);
    const a = await write({
      memoryType: "episodic",
      groupId: g,
      content: "גרסה א",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const b = await write({
      memoryType: "episodic",
      groupId: g,
      content: "גרסה ב",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const c = await write({
      memoryType: "episodic",
      groupId: g,
      content: "גרסה ג",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const ids = { a: a.id, b: b.id, c: c.id };
    const supersede = (memoryId: number, replacedById: number) =>
      supersedeMemory(pool, { memoryType: "episodic", groupId: g, memoryId, replacedById });

    expect(await supersede(ids.a, ids.b)).toBe("superseded");
    expect(
      await supersede(ids.a, ids.c),
      "rewriting the pointer would destroy the history it exists to keep",
    ).toBe("already_superseded");
    expect(await supersede(ids.b, ids.b)).toBe("would_cycle");
    // b → c → b would leave BOTH rows superseded and neither reachable, and a
    // per-row guard cannot see it: at this point c is still the head of its chain.
    expect(await supersede(ids.b, ids.c)).toBe("superseded");
    expect(await supersede(ids.c, ids.b)).toBe("would_cycle");
  });

  it("refuses a supersede pointer that would leave the chat it belongs to", async () => {
    // The FK only confines the pointer to the same TABLE. Left unguarded, a chain
    // that crosses chats means a revoke in one silently withdraws a belief in
    // another, and purging the second un-supersedes the first — both reproduced
    // before this guard existed.
    const mine = await newGroup("cross-mine");
    const theirs = await newGroup("cross-theirs");
    const ours = await write({
      memoryType: "episodic",
      groupId: mine,
      content: "אמונה שלנו",
      evidence: [{ messageId: await newMessage(mine), stance: "supports" }],
    });
    const foreign = await write({
      memoryType: "episodic",
      groupId: theirs,
      content: "אמונה שלהם",
      evidence: [{ messageId: await newMessage(theirs), stance: "supports" }],
    });

    expect(
      await supersedeMemory(pool, {
        memoryType: "episodic",
        groupId: mine,
        memoryId: ours.id,
        replacedById: foreign.id,
      }),
    ).toBe("cross_group");
    // And the withdrawal cannot walk out of the chat either.
    await revokeMemory(pool, { memoryType: "episodic", groupId: mine, memoryId: ours.id });
    expect(await listLiveMemories(pool, { groupId: theirs })).toHaveLength(1);
  });

  it("refuses to supersede a memory that is not in the named group", async () => {
    const mine = await newGroup("scoped-supersede");
    const m = await newMessage(mine);
    const a = await write({
      memoryType: "episodic",
      groupId: mine,
      content: "א",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const b = await write({
      memoryType: "episodic",
      groupId: mine,
      content: "ב",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const elsewhere = await newGroup("scoped-elsewhere");
    expect(
      await supersedeMemory(pool, {
        memoryType: "episodic",
        groupId: elsewhere,
        memoryId: a.id,
        replacedById: b.id,
      }),
    ).toBe("cross_group");
  });

  it("lets a superseded belief be formed again when the chat says it again", async () => {
    // The dedupe index is PARTIAL on superseded_by_id for this reason. A total one
    // would make a replaced belief permanently unwritable in the group — and
    // silently, since the write would report success onto the superseded row.
    const g = await newGroup("re-form");
    const draft = {
      memoryType: "episodic",
      groupId: g,
      content: "גר בתל אביב",
      evidence: [{ messageId: await newMessage(g), stance: "supports" }],
    } as const;

    const original = await write(draft);
    const replacement = await write({
      memoryType: "episodic",
      groupId: g,
      content: "עבר לחיפה",
      evidence: [{ messageId: await newMessage(g), stance: "supports" }],
    });
    await supersedeMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: original.id,
      replacedById: replacement.id,
    });

    const reformed = await write({
      ...draft,
      evidence: [{ messageId: await newMessage(g), stance: "supports" }],
    });

    expect(reformed.outcome, "new messages, so a new belief — not a converge").toBe("created");
    expect(reformed.id).not.toBe(original.id);
    expect((await listLiveMemories(pool, { groupId: g })).map((r) => r.content).sort()).toEqual([
      "גר בתל אביב",
      "עבר לחיפה",
    ]);
  });

  // ── Incoherent input is a caller bug, not a data outcome ─────────────────

  it("refuses a message cited as both supporting and contradicting", async () => {
    // The ledger's primary key would absorb the second row and keep whichever
    // stance the model listed first, so the extractor reordering its own output
    // could flip a belief between supported and contradicted.
    const g = await newGroup("both-stances");
    const m = await newMessage(g);
    await expect(
      createMemory(pool, {
        memoryType: "episodic",
        groupId: g,
        content: "גם וגם",
        evidence: [
          { messageId: m, stance: "supports" },
          { messageId: m, stance: "contradicts" },
        ],
      }),
    ).rejects.toThrow(/cited as both/);
    expect(await countRows("aida_episodic_memories", g)).toBe(0);
  });

  it("says so when canonicalization collapses a relationship to one person", async () => {
    // An ordinary extractor mistake, not an exotic one: a roster carrying both
    // forms of the same human yields a lid and its own phone sibling. Without this
    // the caller gets a bare CHECK-constraint name that explains nothing.
    const g = await newGroup("collapse");
    await recordLink(pool, {
      lidJid: "313@lid",
      pnJid: "972500000313@s.whatsapp.net",
      source: "bridge",
    });
    await expect(
      createMemory(pool, {
        memoryType: "relational",
        groupId: g,
        subjectJids: ["313@lid", "972500000313@s.whatsapp.net"],
        content: "יחס של אדם עם עצמו",
        evidence: [{ messageId: await newMessage(g), stance: "supports" }],
      }),
    ).rejects.toThrow(/collapsed to 1 distinct identity/);
  });

  it("separates a wrong group from an extractor that cited nothing real", async () => {
    // Both used to return null, so a caller bug inflated the reject rate that
    // exists to grade the model.
    const g = await newGroup("unknown-group");
    await expect(
      createMemory(pool, {
        memoryType: "episodic",
        groupId: 999_999_999,
        content: "קבוצה שלא קיימת",
        evidence: [{ messageId: await newMessage(g), stance: "supports" }],
      }),
    ).rejects.toThrow(/no such group/);
  });

  // ── Revoke ───────────────────────────────────────────────────────────────

  it("revokes a belief together with everything it was refined into", async () => {
    // Mutation-checked: with the recursive walk replaced by a single-row UPDATE,
    // this case goes red on the descendant assertions while every other revoke
    // test still passes.
    const g = await newGroup("revoke-chain");
    const m = await newMessage(g);
    const ids: number[] = [];
    for (const content of ["גרסה 1", "גרסה 2", "גרסה 3"]) {
      const written = await write({
        memoryType: "episodic",
        groupId: g,
        content,
        evidence: [{ messageId: m, stance: "supports" }],
      });
      ids.push(written.id);
    }
    await supersedeMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: ids[0],
      replacedById: ids[1],
    });
    await supersedeMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: ids[1],
      replacedById: ids[2],
    });

    const stamped = await revokeMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: ids[0],
    });

    expect(stamped, "the root and both descendants").toBe(3);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM aida_episodic_memories
        WHERE group_id = $1 AND revoked_at IS NULL`,
      [g],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("does not re-stamp a memory that was already withdrawn", async () => {
    const g = await newGroup("revoke-twice");
    const m = await newMessage(g);
    const written = await write({
      memoryType: "episodic",
      groupId: g,
      content: "טעות",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    await revokeMemory(pool, { memoryType: "episodic", groupId: g, memoryId: written.id });
    const { rows: first } = await pool.query<{ revoked_at: Date }>(
      `SELECT revoked_at FROM aida_episodic_memories WHERE id = $1`,
      [written.id],
    );

    expect(
      await revokeMemory(pool, { memoryType: "episodic", groupId: g, memoryId: written.id }),
    ).toBe(0);
    const { rows: second } = await pool.query<{ revoked_at: Date }>(
      `SELECT revoked_at FROM aida_episodic_memories WHERE id = $1`,
      [written.id],
    );
    expect(second[0]?.revoked_at.toISOString()).toBe(first[0]?.revoked_at.toISOString());
  });

  it("keeps a revoked memory unresurrectable — re-extraction converges onto it", async () => {
    const g = await newGroup("revoke-sticky");
    const m = await newMessage(g);
    const draft = {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000050@s.whatsapp.net",
      content: "אמונה שגויה",
      evidence: [{ messageId: m, stance: "supports" }],
    } as const;

    const written = await write(draft);
    await revokeMemory(pool, { memoryType: "semantic", groupId: g, memoryId: written.id });
    const again = await write(draft);

    expect(again.id).toBe(written.id);
    expect(again.outcome, "and the caller is told it was withdrawn, not merely known").toBe(
      "converged_onto_revoked",
    );
    expect(await countRows("aida_semantic_memories", g)).toBe(1);
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  // ── The default read ─────────────────────────────────────────────────────

  it("excludes revoked and superseded memories from the default read", async () => {
    const g = await newGroup("default-read");
    const m = await newMessage(g);
    const make = (content: string) =>
      write({
        memoryType: "episodic",
        groupId: g,
        content,
        evidence: [{ messageId: m, stance: "supports" }],
      });

    const live = await make("חי");
    const revoked = await make("מבוטל");
    const replaced = await make("הוחלף");
    const replacement = await make("המחליף");
    await revokeMemory(pool, { memoryType: "episodic", groupId: g, memoryId: revoked.id });
    await supersedeMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: replaced.id,
      replacedById: replacement.id,
    });

    const contents = (await listLiveMemories(pool, { groupId: g })).map((r) => r.content).sort();
    expect(contents).toEqual(["המחליף", "חי"]);
    expect(contents).not.toContain("מבוטל");
    expect(live.outcome).toBe("created");
  });

  it("returns all four kinds, ranked by evidence and then recency", async () => {
    const g = await newGroup("read-all-kinds");
    const older = new Date("2026-03-01T10:00:00Z");
    const newer = new Date("2026-04-01T10:00:00Z");
    const m1 = await newMessage(g, { sentAt: older });
    const m2 = await newMessage(g, { sentAt: newer });

    await write({
      memoryType: "episodic",
      groupId: g,
      content: "אירוע",
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    await write({
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000060@s.whatsapp.net",
      content: "תכונה",
      evidence: [{ messageId: m2, stance: "supports" }],
    });
    await write({
      memoryType: "relational",
      groupId: g,
      subjectJids: ["972500000060@s.whatsapp.net", "972500000070@s.whatsapp.net"],
      content: "יחס",
      // Two supporting messages, so this must outrank the single-evidence rows.
      evidence: [
        { messageId: m1, stance: "supports" },
        { messageId: m2, stance: "supports" },
      ],
    });
    await write({
      memoryType: "self_state",
      groupId: g,
      facet: "behaviour",
      content: "לענות בקצרה",
      evidence: [{ messageId: m1, stance: "supports" }],
    });

    const live = await listLiveMemories(pool, { groupId: g });
    // relational first on two supporting messages; then the three single-evidence
    // rows by recency, and the last two tie on observed_at so `memory_type` — not
    // an id, which means nothing across four independent sequences — decides.
    expect(live.map((r) => r.memoryType)).toEqual([
      "relational",
      "semantic",
      "episodic",
      "self_state",
    ]);
    expect(live[0]?.subjectJids).toEqual([
      "972500000060@s.whatsapp.net",
      "972500000070@s.whatsapp.net",
    ]);
    expect(live[1]?.subjectJids).toEqual(["972500000060@s.whatsapp.net"]);
    expect(live.find((r) => r.memoryType === "self_state")?.facet).toBe("behaviour");
    expect(live.find((r) => r.memoryType === "episodic")?.subjectJids).toEqual([]);
  });

  it("never returns another chat's memories", async () => {
    const mine = await newGroup("scoped-mine");
    const theirs = await newGroup("scoped-theirs");
    const m = await newMessage(theirs);
    await write({
      memoryType: "episodic",
      groupId: theirs,
      content: "של הקבוצה השנייה",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    expect(await listLiveMemories(pool, { groupId: mine })).toEqual([]);
  });

  // ── Removal ──────────────────────────────────────────────────────────────

  it("takes a group's memories and their evidence with the group", async () => {
    const g = await newGroup("cascade-group");
    const m = await newMessage(g);
    const written = await write({
      memoryType: "episodic",
      groupId: g,
      content: "ימחק עם הקבוצה",
      evidence: [{ messageId: m, stance: "supports" }],
    });

    // `messages` does NOT cascade from `groups` — the real deletion paths clear
    // messages first and the group last, so this follows the same order. Evidence
    // goes with the messages; the memories go with the group.
    await pool.query(`DELETE FROM messages WHERE group_id = $1`, [g]);
    expect(await evidenceCount("episodic", written.id)).toBe(0);

    await pool.query(`DELETE FROM groups WHERE id = $1`, [g]);
    expect(await countRows("aida_episodic_memories", g)).toBe(0);
  });

  it("leaves a memory unsupported rather than gone when its source message is deleted", async () => {
    const g = await newGroup("cascade-message");
    const m = await newMessage(g);
    const written = await write({
      memoryType: "episodic",
      groupId: g,
      content: "המקור נמחק",
      evidence: [{ messageId: m, stance: "supports" }],
    });

    await pool.query(`DELETE FROM messages WHERE id = $1`, [m]);

    // The belief survives with nothing behind it — which is the correct signal,
    // not a bug: the record has to show that it lost its support.
    expect(await countRows("aida_episodic_memories", g)).toBe(1);
    expect(await evidenceCount("episodic", written.id)).toBe(0);
    const [memory] = await listLiveMemories(pool, { groupId: g });
    expect(memory?.supportingEvidence).toBe(0);
  });

  // ── The review surface ───────────────────────────────────────────────────

  it("shows memories across every chat, with the chat each belongs to", async () => {
    const a = await newGroup("review-a");
    const b = await newGroup("review-b");
    await write({
      memoryType: "episodic",
      groupId: a,
      content: "בקבוצה א",
      evidence: [{ messageId: await newMessage(a), stance: "supports" }],
    });
    await write({
      memoryType: "episodic",
      groupId: b,
      content: "בקבוצה ב",
      evidence: [{ messageId: await newMessage(b), stance: "supports" }],
    });

    const all = await listMemoriesForReview(pool);
    const mine = all.filter((r) => r.groupId === a || r.groupId === b);
    expect(mine.map((r) => r.content).sort()).toEqual(["בקבוצה א", "בקבוצה ב"]);
    // The chat's name travels with the belief: a claim read out of the context
    // that produced it is not checkable.
    expect(mine.every((r) => r.groupName.length > 0)).toBe(true);
    // One chat only, when asked.
    expect((await listMemoriesForReview(pool, { groupId: a })).map((r) => r.content)).toEqual([
      "בקבוצה א",
    ]);
  });

  it("hides withdrawn and replaced rows unless they are asked for", async () => {
    const g = await newGroup("review-withdrawn");
    const m = await newMessage(g);
    const live = await write({
      memoryType: "episodic",
      groupId: g,
      content: "חי",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const gone = await write({
      memoryType: "episodic",
      groupId: g,
      content: "מבוטל",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    await revokeMemory(pool, { memoryType: "episodic", groupId: g, memoryId: gone.id });

    expect((await listMemoriesForReview(pool, { groupId: g })).map((r) => r.id)).toEqual([live.id]);

    const withWithdrawn = await listMemoriesForReview(pool, {
      groupId: g,
      includeWithdrawn: true,
    });
    expect(withWithdrawn.map((r) => r.content).sort()).toEqual(["חי", "מבוטל"]);
    expect(withWithdrawn.find((r) => r.id === gone.id)?.revokedAt).not.toBeNull();
  });

  it("carries the message a belief cites, so the source is one tap away", async () => {
    // Regression: the aggregate was computed in the lateral join and never
    // selected in the outer branch, so it arrived `undefined`, became NaN, and
    // serialized as null — a source-jump button that silently went nowhere while
    // the evidence count beside it said there was something to open.
    const g = await newGroup("review-source");
    const m = await newMessage(g);
    await write({
      memoryType: "episodic",
      groupId: g,
      content: "יש מקור",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const [row] = await listMemoriesForReview(pool, { groupId: g });
    expect(row?.firstSourceMessageId).toBe(m);
  });

  it("has no source to open once every message it cited is gone", async () => {
    const g = await newGroup("review-no-source");
    const m = await newMessage(g);
    await write({
      memoryType: "episodic",
      groupId: g,
      content: "המקור נמחק",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    await pool.query(`DELETE FROM messages WHERE id = $1`, [m]);
    const [row] = await listMemoriesForReview(pool, { groupId: g });
    expect(row?.firstSourceMessageId, "kept, but unsupported").toBeNull();
    expect(row?.supportingEvidence).toBe(0);
  });

  it("narrows to one kind of belief when asked", async () => {
    const g = await newGroup("review-type");
    const m = await newMessage(g);
    await write({
      memoryType: "episodic",
      groupId: g,
      content: "אירוע",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    await write({
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000090@s.whatsapp.net",
      content: "תכונה",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const semantic = await listMemoriesForReview(pool, { groupId: g, memoryType: "semantic" });
    expect(semantic.map((r) => r.content)).toEqual(["תכונה"]);
  });

  // ── Correcting a belief ──────────────────────────────────────────────────

  it("replaces a belief, keeps the original intact, and records why", async () => {
    const g = await newGroup("correct");
    const m = await newMessage(g);
    const original = await write({
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000091@s.whatsapp.net",
      content: "גיא גר בתל אביב",
      evidence: [{ messageId: m, stance: "supports" }],
    });

    const outcome = await correctMemory(pool, {
      memoryType: "semantic",
      groupId: g,
      memoryId: original.id,
      content: "גיא עבר לחיפה",
      note: "הוא אמר את זה בהודעה אחרת, היא הבינה לא נכון",
    });

    expect(outcome.ok).toBe(true);
    const live = await listMemoriesForReview(pool, { groupId: g });
    expect(live.map((r) => r.content)).toEqual(["גיא עבר לחיפה"]);
    // The reason is on the new row, and its presence is the ONLY thing marking
    // the row as human-written.
    expect(live[0]?.correctionNote).toBe("הוא אמר את זה בהודעה אחרת, היא הבינה לא נכון");

    const all = await listMemoriesForReview(pool, { groupId: g, includeWithdrawn: true });
    const kept = all.find((r) => r.id === original.id);
    expect(kept?.content, "the original is never rewritten").toBe("גיא גר בתל אביב");
    expect(kept?.supersededById).toBe(live[0]?.id);
    expect(kept?.correctionNote, "and it stays marked as hers").toBeNull();
  });

  it("gives the correction the original's citations, since it has none of its own", async () => {
    const g = await newGroup("correct-evidence");
    const m1 = await newMessage(g);
    const m2 = await newMessage(g);
    const original = await write({
      memoryType: "episodic",
      groupId: g,
      content: "גרסה ישנה",
      evidence: [
        { messageId: m1, stance: "supports" },
        { messageId: m2, stance: "supports" },
      ],
    });

    const outcome = await correctMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: original.id,
      content: "גרסה מתוקנת",
      note: "ניסוח מדויק יותר",
    });

    expect(outcome.ok).toBe(true);
    const [live] = await listMemoriesForReview(pool, { groupId: g });
    expect(live?.supportingEvidence, "same messages, read differently").toBe(2);
  });

  it("refuses a correction with no reason, because the reason is the only mark", async () => {
    const g = await newGroup("correct-no-note");
    const m = await newMessage(g);
    const original = await write({
      memoryType: "episodic",
      groupId: g,
      content: "משהו",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    for (const note of ["", "   "]) {
      await expect(
        correctMemory(pool, {
          memoryType: "episodic",
          groupId: g,
          memoryId: original.id,
          content: "משהו אחר",
          note,
        }),
      ).rejects.toThrow(/must say why/);
    }
  });

  it("refuses to correct a belief in another chat", async () => {
    const mine = await newGroup("correct-mine");
    const theirs = await newGroup("correct-theirs");
    const original = await write({
      memoryType: "episodic",
      groupId: mine,
      content: "שלי",
      evidence: [{ messageId: await newMessage(mine), stance: "supports" }],
    });
    const outcome = await correctMemory(pool, {
      memoryType: "episodic",
      groupId: theirs,
      memoryId: original.id,
      content: "נחטף",
      note: "לא אמור לעבוד",
    });
    expect(outcome).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses to correct something already withdrawn, rather than forking the chain", async () => {
    const g = await newGroup("correct-revoked");
    const original = await write({
      memoryType: "episodic",
      groupId: g,
      content: "מבוטל",
      evidence: [{ messageId: await newMessage(g), stance: "supports" }],
    });
    await revokeMemory(pool, { memoryType: "episodic", groupId: g, memoryId: original.id });
    const outcome = await correctMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: original.id,
      content: "תיקון",
      note: "מאוחר מדי",
    });
    expect(outcome).toEqual({ ok: false, reason: "already_revoked" });
  });

  it("refuses a correction that collides with a DIFFERENT belief, touching neither", async () => {
    // The serious one. `createMemory` COMMITS on the converge path, so deciding
    // `duplicate` after calling it meant the original's whole evidence ledger had
    // already been written onto whatever row it collided with. The dedupe key is
    // (group, subject, content_hash), so that row need not be the original —
    // `self_state` keys on just (group, facet, hash), which makes it easy to hit.
    const g = await newGroup("correct-collide");
    const m1 = await newMessage(g);
    const m2 = await newMessage(g);
    const a = await write({
      memoryType: "self_state",
      groupId: g,
      facet: "behaviour",
      content: "לענות בקצרה",
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    const b = await write({
      memoryType: "self_state",
      groupId: g,
      facet: "behaviour",
      content: "לענות בעברית",
      evidence: [{ messageId: m2, stance: "supports" }],
    });

    // Retype A's wording into B's exact wording.
    const outcome = await correctMemory(pool, {
      memoryType: "self_state",
      groupId: g,
      memoryId: a.id,
      content: "לענות בעברית",
      note: "התנגשות",
    });

    expect(outcome).toEqual({ ok: false, reason: "duplicate" });
    const all = await listMemoriesForReview(pool, { groupId: g, includeWithdrawn: true });
    expect(all, "no third row was written").toHaveLength(2);
    // The claim "nothing was written" has to be true of B's ledger too.
    expect(
      all.find((r) => r.id === b.id)?.supportingEvidence,
      "the collided-onto belief keeps its own evidence, and only its own",
    ).toBe(1);
    expect(all.find((r) => r.id === a.id)?.supersededById, "and A is untouched").toBeNull();
  });

  it("tells a replaced belief apart from a withdrawn one", async () => {
    const g = await newGroup("correct-superseded");
    const original = await write({
      memoryType: "episodic",
      groupId: g,
      content: "גרסה ראשונה",
      evidence: [{ messageId: await newMessage(g), stance: "supports" }],
    });
    await correctMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: original.id,
      content: "גרסה שנייה",
      note: "ניסוח",
    });
    // Correcting the REPLACED row would fork the chain into two live heads. The
    // remedy differs from a withdrawn belief's, so the reason has to differ too.
    expect(
      await correctMemory(pool, {
        memoryType: "episodic",
        groupId: g,
        memoryId: original.id,
        content: "גרסה שלישית",
        note: "מאוחר מדי",
      }),
    ).toEqual({ ok: false, reason: "already_superseded" });
  });

  it("refuses a correction that just restates the belief, and writes nothing", async () => {
    // The collision that would otherwise point a row at itself: same subject,
    // same words, same hash, so the dedupe converges onto the original — and
    // superseding it to itself would be refused, leaving the compensating revoke
    // to withdraw a belief that was never replaced.
    const g = await newGroup("correct-dup");
    const original = await write({
      memoryType: "episodic",
      groupId: g,
      content: "אותו דבר",
      evidence: [{ messageId: await newMessage(g), stance: "supports" }],
    });
    const outcome = await correctMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: original.id,
      content: "אותו דבר",
      note: "לא באמת תיקון",
    });
    expect(outcome).toEqual({ ok: false, reason: "duplicate" });
    const all = await listMemoriesForReview(pool, { groupId: g, includeWithdrawn: true });
    expect(all, "nothing was written and nothing was withdrawn").toHaveLength(1);
    expect(all[0]?.revokedAt).toBeNull();
  });

  // ── Local helpers that need `pool` ───────────────────────────────────────

  async function countRows(table: string, groupId: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE group_id = $1`,
      [groupId],
    );
    return Number(rows[0]?.n);
  }

  async function evidenceCountForMessage(messageId: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM aida_memory_evidence WHERE message_id = $1`,
      [messageId],
    );
    return Number(rows[0]?.n);
  }
});
