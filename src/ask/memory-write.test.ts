import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listLiveMemories, revokeMemory } from "../db/repositories/aida-memory.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { createTestDatabase } from "../test/db.js";
import type { CandidateMessage } from "./memory-extract.js";
import { storeAccepted } from "./memory-write.js";

/**
 * What these are trying to catch: a run that reports success while storing
 * nothing, a belief filed against the wrong person, and — the one that matters
 * most — a withdrawn belief quietly coming back because a later run re-proposed
 * it and nothing said so.
 */
describe("storeAccepted", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const JID = "972500000042@s.whatsapp.net";

  async function newGroup(name: string): Promise<number> {
    return await upsertGroup(pool, { name: `${name}-${randomUUID().slice(0, 8)}`, source: "live" });
  }

  async function newMessage(groupId: number, senderJid: string | null = JID): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key, sender_jid)
       VALUES ($1,'live','text','אני לא אוכלת בשר', now(), $2, $3) RETURNING id`,
      [groupId, `dk-${randomUUID()}`, senderJid],
    );
    return Number(rows[0]?.id);
  }

  function shownFor(
    messageId: number,
    senderJid: string | null = JID,
  ): Map<number, CandidateMessage> {
    return new Map([
      [
        messageId,
        {
          messageId,
          sender: "רוני",
          senderJid,
          content: "אני לא אוכלת בשר",
          sentAt: new Date("2026-05-01T10:00:00.000Z"),
        },
      ],
    ]);
  }

  it("stores an accepted candidate as a memory anyone can read back", async () => {
    const g = await newGroup("store");
    const m = await newMessage(g);

    const tally = await storeAccepted(
      pool,
      [{ sourceMessageId: m, content: "רוני לא אוכלת בשר" }],
      shownFor(m),
      g,
    );

    expect(tally.created).toBe(1);
    const [memory] = await listLiveMemories(pool, { groupId: g });
    expect(memory?.content).toBe("רוני לא אוכלת בשר");
    expect(memory?.memoryType).toBe("semantic");
    expect(memory?.supportingEvidence, "and it names the message it came from").toBe(1);
  });

  it("converges on a second run over the same window instead of duplicating", async () => {
    const g = await newGroup("converge");
    const m = await newMessage(g);
    const run = () =>
      storeAccepted(pool, [{ sourceMessageId: m, content: "רוני לא אוכלת בשר" }], shownFor(m), g);

    expect((await run()).created).toBe(1);
    expect((await run()).converged).toBe(1);
    expect(await listLiveMemories(pool, { groupId: g })).toHaveLength(1);
  });

  it("cannot resurrect a belief that was revoked, and says which happened", async () => {
    // The property the whole cleanup surface rests on. A run that re-proposed a
    // withdrawn belief and reported `converged` would be indistinguishable from
    // one that found nothing new — and the number that says "revocation is not
    // reaching the extractor" would be unmeasurable.
    const g = await newGroup("revoked");
    const m = await newMessage(g);
    const run = () =>
      storeAccepted(pool, [{ sourceMessageId: m, content: "אמונה שגויה" }], shownFor(m), g);

    await run();
    const [stored] = await listLiveMemories(pool, { groupId: g });
    await revokeMemory(pool, { memoryType: "semantic", groupId: g, memoryId: stored?.id ?? 0 });

    const tally = await run();

    expect(tally.convergedOntoRevoked).toBe(1);
    expect(tally.created, "nothing new was written").toBe(0);
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("refuses a candidate whose author has no identity, and counts it", async () => {
    const g = await newGroup("no-identity");
    const m = await newMessage(g, null);

    const tally = await storeAccepted(
      pool,
      [{ sourceMessageId: m, content: "מישהו לא אוכל בשר" }],
      shownFor(m, null),
      g,
    );

    expect(tally.unattributable).toBe(1);
    expect(tally.created).toBe(0);
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("counts a candidate that cited a message from another chat, and stores nothing", async () => {
    const mine = await newGroup("cross-mine");
    const theirs = await newGroup("cross-theirs");
    const foreign = await newMessage(theirs);

    const tally = await storeAccepted(
      pool,
      [{ sourceMessageId: foreign, content: "טענה שנשענת על צ׳אט אחר" }],
      shownFor(foreign),
      mine,
    );

    expect(tally.citedNothingReal).toBe(1);
    expect(await listLiveMemories(pool, { groupId: mine })).toEqual([]);
  });

  it("stores nothing at all when there is nothing accepted", async () => {
    const g = await newGroup("empty");
    const tally = await storeAccepted(pool, [], new Map(), g);
    expect(tally).toEqual({
      created: 0,
      converged: 0,
      convergedOntoRevoked: 0,
      unattributable: 0,
      citedNothingReal: 0,
    });
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("keeps going after one candidate fails, rather than losing the rest of the run", async () => {
    const g = await newGroup("partial");
    const good = await newMessage(g);
    const bad = await newMessage(g, null);

    const tally = await storeAccepted(
      pool,
      [
        { sourceMessageId: bad, content: "לא ניתן לייחוס" },
        { sourceMessageId: good, content: "רוני לא אוכלת בשר" },
      ],
      new Map([...shownFor(bad, null), ...shownFor(good)]),
      g,
    );

    expect(tally).toMatchObject({ unattributable: 1, created: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toHaveLength(1);
  });
});
