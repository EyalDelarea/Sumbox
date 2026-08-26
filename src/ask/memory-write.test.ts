import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listLiveMemories, revokeMemory } from "../db/repositories/aida-memory.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { createTestDatabase } from "../test/db.js";
import type { CandidateMessage } from "./memory-extract.js";
import { storeAccepted, tally, toSemanticDraft } from "./memory-write.js";

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

    const results = await storeAccepted(
      pool,
      [{ sourceMessageId: m, content: "רוני לא אוכלת בשר" }],
      shownFor(m),
      g,
    );

    expect(results[0]?.outcome).toBe("created");
    // The id comes back, because revoking takes one and this run is the only
    // moment where the id, the words and the author are all in hand at once.
    expect(results[0]?.memoryId, "the stored id is reported").toBeGreaterThan(0);
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

    expect(tally(await run())).toEqual({ created: 1 });
    expect(tally(await run())).toEqual({ converged: 1 });
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

    const results = await run();

    expect(tally(results), "nothing new was written").toEqual({ converged_onto_revoked: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("refuses a candidate whose author has no identity, and counts it", async () => {
    const g = await newGroup("no-identity");
    const m = await newMessage(g, null);

    const results = await storeAccepted(
      pool,
      [{ sourceMessageId: m, content: "מישהו לא אוכל בשר" }],
      shownFor(m, null),
      g,
    );

    expect(tally(results)).toEqual({ no_author_identity: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("counts a candidate that cited a message from another chat, and stores nothing", async () => {
    const mine = await newGroup("cross-mine");
    const theirs = await newGroup("cross-theirs");
    const foreign = await newMessage(theirs);

    const results = await storeAccepted(
      pool,
      [{ sourceMessageId: foreign, content: "טענה שנשענת על צ׳אט אחר" }],
      shownFor(foreign),
      mine,
    );

    expect(tally(results)).toEqual({ cited_nothing_real: 1 });
    expect(await listLiveMemories(pool, { groupId: mine })).toEqual([]);
  });

  it("stores nothing at all when there is nothing accepted", async () => {
    const g = await newGroup("empty");
    const results = await storeAccepted(pool, [], new Map(), g);
    expect(results).toEqual([]);
    expect(tally(results)).toEqual({});
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("keeps the record of what it stored when a later candidate throws", async () => {
    // The failure both reviews called critical. `createMemory` owns a transaction
    // PER candidate, so by the time a later one fails, earlier beliefs about real
    // named people are already committed. A throw unwinding out of here would take
    // the record of them with it — the operator would see only an error, having
    // stored things the run never mentioned.
    const g = await newGroup("throws");
    const good = await newMessage(g);
    const results = await storeAccepted(
      pool,
      [
        { sourceMessageId: good, content: "רוני לא אוכלת בשר" },
        // Content the schema refuses: `createMemory` throws on empty content.
        { sourceMessageId: good, content: "   " },
      ],
      shownFor(good),
      g,
    );

    expect(tally(results)).toEqual({ created: 1, failed: 1 });
    expect(results[1]?.error, "and says what went wrong").toBeTruthy();
    expect(
      await listLiveMemories(pool, { groupId: g }),
      "the belief that did land is on file, and reported",
    ).toHaveLength(1);
  });

  it("keeps going after one candidate fails, rather than losing the rest of the run", async () => {
    const g = await newGroup("partial");
    const good = await newMessage(g);
    const bad = await newMessage(g, null);

    const results = await storeAccepted(
      pool,
      [
        { sourceMessageId: bad, content: "לא ניתן לייחוס" },
        { sourceMessageId: good, content: "רוני לא אוכלת בשר" },
      ],
      new Map([...shownFor(bad, null), ...shownFor(good)]),
      g,
    );

    expect(tally(results)).toEqual({ no_author_identity: 1, created: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toHaveLength(1);
  });
});

/**
 * Attribution: who a belief ends up being about. Pure, so the failure that
 * matters here — filing a fact about one person against another — is testable
 * without a model or a database.
 */
describe("toSemanticDraft", () => {
  const shown = (over: Partial<CandidateMessage> = {}): Map<number, CandidateMessage> =>
    new Map([
      [
        7,
        {
          messageId: 7,
          sender: "רוני",
          senderJid: "972500000042@s.whatsapp.net",
          content: "אני לא אוכלת בשר",
          sentAt: new Date("2026-05-01T10:00:00.000Z"),
          ...over,
        },
      ],
    ]);

  it("files the belief against the author of the message it cites", () => {
    expect(
      toSemanticDraft({ sourceMessageId: 7, content: "רוני לא אוכלת בשר" }, shown(), 3),
    ).toEqual({
      draft: {
        memoryType: "semantic",
        groupId: 3,
        subjectJid: "972500000042@s.whatsapp.net",
        content: "רוני לא אוכלת בשר",
        evidence: [{ messageId: 7, stance: "supports" }],
      },
    });
  });

  it("refuses an author identity that is missing, blank, or only whitespace", () => {
    // The alternative considered and rejected on #95: file it as `episodic`,
    // whose subject is nullable. That keeps the row by calling a fact about a
    // person an event, which corrupts the one thing four tables exist to say.
    for (const jid of [null, "", "   "]) {
      expect(
        toSemanticDraft({ sourceMessageId: 7, content: "x" }, shown({ senderJid: jid }), 3),
      ).toEqual({ rejected: "no_author_identity" });
    }
  });

  it("reports a candidate it was never shown as its own thing, not as a missing identity", () => {
    // `validateCandidate` already rejects an invented id, so reaching this means
    // validation was skipped or `shown` came from a different window — an alarm.
    // Filed under the routine historical gap it would read as expected.
    expect(toSemanticDraft({ sourceMessageId: 999, content: "x" }, shown(), 3)).toEqual({
      rejected: "not_shown",
    });
  });

  it("trims the stored identity, so a padded jid is not a second subject", () => {
    const mapped = toSemanticDraft(
      { sourceMessageId: 7, content: "x" },
      shown({ senderJid: " 972500000042@s.whatsapp.net " }),
      3,
    );
    expect("draft" in mapped && mapped.draft.subjectJid).toBe("972500000042@s.whatsapp.net");
  });
});
