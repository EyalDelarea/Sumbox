import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import type { EvidenceStance } from "./aida-memory.js";
import {
  canonicalSubjectJid,
  createMemory,
  listLiveMemories,
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

    const written = await createMemory(pool, {
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
      [written?.id],
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

    const viaLid = await createMemory(pool, {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "777@lid",
      content: "מגיע תמיד מאוחר",
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    const viaPn = await createMemory(pool, {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000777@s.whatsapp.net",
      content: "מגיע תמיד מאוחר",
      evidence: [{ messageId: m2, stance: "supports" }],
    });

    expect(viaPn?.id).toBe(viaLid?.id);
    expect(viaPn?.created).toBe(false);
    expect(await countRows("aida_semantic_memories", g)).toBe(1);
  });

  it("keeps two people who share a display name as two distinct subjects", async () => {
    const g = await newGroup("same-name");
    const m = await newMessage(g);
    // The display name is identical; the identities are not. Subjects key on the
    // identity, which is the whole reason they are JIDs and not participant ids.
    for (const jid of ["972500000001@s.whatsapp.net", "972500000002@s.whatsapp.net"]) {
      await createMemory(pool, {
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

    const first = await createMemory(pool, draft);
    const second = await createMemory(pool, draft);

    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.id).toBe(first?.id);
    expect(second?.evidenceRecorded, "a repeat citation is one citation").toBe(0);
    expect(await countRows("aida_semantic_memories", g)).toBe(1);
    expect(await evidenceCount("semantic", first?.id ?? 0)).toBe(1);
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

    await createMemory(pool, draft);
    const second = await createMemory(pool, draft);

    expect(second?.created).toBe(false);
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

    const first = await createMemory(pool, {
      ...base,
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    const second = await createMemory(pool, {
      ...base,
      evidence: [{ messageId: m2, stance: "supports" }],
    });

    expect(second?.id).toBe(first?.id);
    expect(second?.evidenceRecorded).toBe(1);
    expect(await evidenceCount("semantic", first?.id ?? 0)).toBe(2);
  });

  // ── Relational order-independence ────────────────────────────────────────

  it("treats a relational memory about the same pair in either order as one memory", async () => {
    const g = await newGroup("pair-order");
    const m1 = await newMessage(g);
    const m2 = await newMessage(g);
    const content = "מתכננים ביחד את הטיול";

    const forward = await createMemory(pool, {
      memoryType: "relational",
      groupId: g,
      subjectJids: ["972500000010@s.whatsapp.net", "972500000020@s.whatsapp.net"],
      content,
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    const reversed = await createMemory(pool, {
      memoryType: "relational",
      groupId: g,
      subjectJids: ["972500000020@s.whatsapp.net", "972500000010@s.whatsapp.net"],
      content,
      evidence: [{ messageId: m2, stance: "supports" }],
    });

    expect(reversed?.id).toBe(forward?.id);
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

    const written = await createMemory(pool, {
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
    expect(written?.evidenceRecorded).toBe(2);
    expect(memory?.supportingEvidence).toBe(1);
    expect(memory?.contradictingEvidence).toBe(1);
  });

  // ── Supersede ────────────────────────────────────────────────────────────

  it("leaves the old belief present and unmodified when it is superseded", async () => {
    const g = await newGroup("supersede");
    const m = await newMessage(g);
    const old = await createMemory(pool, {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000040@s.whatsapp.net",
      content: "גר בתל אביב",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const fresh = await createMemory(pool, {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000040@s.whatsapp.net",
      content: "עבר לחיפה",
      evidence: [{ messageId: m, stance: "supports" }],
    });

    expect(
      await supersedeMemory(pool, {
        memoryType: "semantic",
        memoryId: old?.id ?? 0,
        replacedById: fresh?.id ?? 0,
      }),
    ).toBe(true);

    const { rows } = await pool.query<{ content: string; superseded_by_id: string }>(
      `SELECT content, superseded_by_id FROM aida_semantic_memories WHERE id = $1`,
      [old?.id],
    );
    expect(rows[0]?.content, "the replaced belief is never rewritten").toBe("גר בתל אביב");
    expect(Number(rows[0]?.superseded_by_id)).toBe(fresh?.id);
  });

  it("refuses to re-point an already-superseded memory, or to point one at itself", async () => {
    const g = await newGroup("supersede-guard");
    const m = await newMessage(g);
    const a = await createMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      content: "גרסה א",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const b = await createMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      content: "גרסה ב",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const c = await createMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      content: "גרסה ג",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    const ids = { a: a?.id ?? 0, b: b?.id ?? 0, c: c?.id ?? 0 };

    expect(
      await supersedeMemory(pool, { memoryType: "episodic", memoryId: ids.a, replacedById: ids.b }),
    ).toBe(true);
    expect(
      await supersedeMemory(pool, { memoryType: "episodic", memoryId: ids.a, replacedById: ids.c }),
      "rewriting the pointer would destroy the history it exists to keep",
    ).toBe(false);
    expect(
      await supersedeMemory(pool, { memoryType: "episodic", memoryId: ids.b, replacedById: ids.b }),
    ).toBe(false);
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
      const written = await createMemory(pool, {
        memoryType: "episodic",
        groupId: g,
        content,
        evidence: [{ messageId: m, stance: "supports" }],
      });
      ids.push(written?.id ?? 0);
    }
    await supersedeMemory(pool, {
      memoryType: "episodic",
      memoryId: ids[0] ?? 0,
      replacedById: ids[1] ?? 0,
    });
    await supersedeMemory(pool, {
      memoryType: "episodic",
      memoryId: ids[1] ?? 0,
      replacedById: ids[2] ?? 0,
    });

    const stamped = await revokeMemory(pool, { memoryType: "episodic", memoryId: ids[0] ?? 0 });

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
    const written = await createMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      content: "טעות",
      evidence: [{ messageId: m, stance: "supports" }],
    });
    await revokeMemory(pool, { memoryType: "episodic", memoryId: written?.id ?? 0 });
    const { rows: first } = await pool.query<{ revoked_at: Date }>(
      `SELECT revoked_at FROM aida_episodic_memories WHERE id = $1`,
      [written?.id],
    );

    expect(await revokeMemory(pool, { memoryType: "episodic", memoryId: written?.id ?? 0 })).toBe(
      0,
    );
    const { rows: second } = await pool.query<{ revoked_at: Date }>(
      `SELECT revoked_at FROM aida_episodic_memories WHERE id = $1`,
      [written?.id],
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

    const written = await createMemory(pool, draft);
    await revokeMemory(pool, { memoryType: "semantic", memoryId: written?.id ?? 0 });
    const again = await createMemory(pool, draft);

    expect(again?.id).toBe(written?.id);
    expect(again?.created).toBe(false);
    expect(await countRows("aida_semantic_memories", g)).toBe(1);
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  // ── The default read ─────────────────────────────────────────────────────

  it("excludes revoked and superseded memories from the default read", async () => {
    const g = await newGroup("default-read");
    const m = await newMessage(g);
    const make = (content: string) =>
      createMemory(pool, {
        memoryType: "episodic",
        groupId: g,
        content,
        evidence: [{ messageId: m, stance: "supports" }],
      });

    const live = await make("חי");
    const revoked = await make("מבוטל");
    const replaced = await make("הוחלף");
    const replacement = await make("המחליף");
    await revokeMemory(pool, { memoryType: "episodic", memoryId: revoked?.id ?? 0 });
    await supersedeMemory(pool, {
      memoryType: "episodic",
      memoryId: replaced?.id ?? 0,
      replacedById: replacement?.id ?? 0,
    });

    const contents = (await listLiveMemories(pool, { groupId: g })).map((r) => r.content).sort();
    expect(contents).toEqual(["המחליף", "חי"]);
    expect(contents).not.toContain("מבוטל");
    expect(live?.created).toBe(true);
  });

  it("returns all four kinds, ranked by evidence and then recency", async () => {
    const g = await newGroup("read-all-kinds");
    const older = new Date("2026-03-01T10:00:00Z");
    const newer = new Date("2026-04-01T10:00:00Z");
    const m1 = await newMessage(g, { sentAt: older });
    const m2 = await newMessage(g, { sentAt: newer });

    await createMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      content: "אירוע",
      evidence: [{ messageId: m1, stance: "supports" }],
    });
    await createMemory(pool, {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000060@s.whatsapp.net",
      content: "תכונה",
      evidence: [{ messageId: m2, stance: "supports" }],
    });
    await createMemory(pool, {
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
    await createMemory(pool, {
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
    await createMemory(pool, {
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
    const written = await createMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      content: "ימחק עם הקבוצה",
      evidence: [{ messageId: m, stance: "supports" }],
    });

    // `messages` does NOT cascade from `groups` — the real deletion paths clear
    // messages first and the group last, so this follows the same order. Evidence
    // goes with the messages; the memories go with the group.
    await pool.query(`DELETE FROM messages WHERE group_id = $1`, [g]);
    expect(await evidenceCount("episodic", written?.id ?? 0)).toBe(0);

    await pool.query(`DELETE FROM groups WHERE id = $1`, [g]);
    expect(await countRows("aida_episodic_memories", g)).toBe(0);
  });

  it("leaves a memory unsupported rather than gone when its source message is deleted", async () => {
    const g = await newGroup("cascade-message");
    const m = await newMessage(g);
    const written = await createMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      content: "המקור נמחק",
      evidence: [{ messageId: m, stance: "supports" }],
    });

    await pool.query(`DELETE FROM messages WHERE id = $1`, [m]);

    // The belief survives with nothing behind it — which is the correct signal,
    // not a bug: the record has to show that it lost its support.
    expect(await countRows("aida_episodic_memories", g)).toBe(1);
    expect(await evidenceCount("episodic", written?.id ?? 0)).toBe(0);
    const [memory] = await listLiveMemories(pool, { groupId: g });
    expect(memory?.supportingEvidence).toBe(0);
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
