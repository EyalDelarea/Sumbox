import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listLiveMemories, revokeMemory } from "../db/repositories/aida-memory.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { recordLink } from "../db/repositories/identity-links.js";
import { createTestDatabase } from "../test/db.js";
import type { SubjectIdentity, ValidatedCandidate } from "./memory-extract.js";
import { storeAccepted, tally, toDraft } from "./memory-write.js";

const RONI = "972500000042@s.whatsapp.net";
const DANA = "972500000043@s.whatsapp.net";

function person(name: string, ...jids: string[]): SubjectIdentity {
  return { name, jids };
}

function belief(over: Partial<ValidatedCandidate> = {}): ValidatedCandidate {
  return {
    memoryType: "semantic",
    subjects: [person("רוני", RONI)],
    content: "רוני לא אוכלת בשר",
    citations: [],
    ...over,
  };
}

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

  async function newGroup(name: string): Promise<number> {
    return await upsertGroup(pool, { name: `${name}-${randomUUID().slice(0, 8)}`, source: "live" });
  }

  async function newMessage(groupId: number, senderJid: string | null = RONI): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key, sender_jid)
       VALUES ($1,'live','text','אני לא אוכלת בשר', now(), $2, $3) RETURNING id`,
      [groupId, `dk-${randomUUID()}`, senderJid],
    );
    return Number(rows[0]?.id);
  }

  it("stores an accepted candidate as a memory anyone can read back", async () => {
    const g = await newGroup("store");
    const m = await newMessage(g);

    const results = await storeAccepted(pool, [belief({ citations: [m] })], g);

    expect(results[0]?.outcome).toBe("created");
    // The id comes back, because revoking takes one and this run is the only
    // moment where the id, the words and the author are all in hand at once.
    expect(results[0]?.memoryId, "the stored id is reported").toBeGreaterThan(0);
    const [memory] = await listLiveMemories(pool, { groupId: g });
    expect(memory?.content).toBe("רוני לא אוכלת בשר");
    expect(memory?.memoryType).toBe("semantic");
    expect(memory?.supportingEvidence, "and it names the message it came from").toBe(1);
  });

  it("records every message a corroborated belief cited, not just the first", async () => {
    // The corroboration rule is only worth anything if the second voice is
    // traceable. Storing one citation would leave a belief about somebody else
    // looking, on the screen, exactly like one person's say-so.
    const g = await newGroup("multi");
    const first = await newMessage(g);
    const second = await newMessage(g, DANA);

    await storeAccepted(pool, [belief({ citations: [first, second] })], g);

    const [memory] = await listLiveMemories(pool, { groupId: g });
    expect(memory?.supportingEvidence).toBe(2);
  });

  it("converges on a second run over the same window instead of duplicating", async () => {
    const g = await newGroup("converge");
    const m = await newMessage(g);
    const run = () => storeAccepted(pool, [belief({ citations: [m] })], g);

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
    const run = () => storeAccepted(pool, [belief({ content: "אמונה שגויה", citations: [m] })], g);

    await run();
    const [stored] = await listLiveMemories(pool, { groupId: g });
    await revokeMemory(pool, { memoryType: "semantic", groupId: g, memoryId: stored?.id ?? 0 });

    const results = await run();

    expect(tally(results), "nothing new was written").toEqual({ converged_onto_revoked: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("stores a relationship between two people, and an event about nobody", async () => {
    const g = await newGroup("types");
    const m = await newMessage(g);
    const other = await newMessage(g, DANA);

    const results = await storeAccepted(
      pool,
      [
        belief({
          memoryType: "relational",
          subjects: [person("רוני", RONI), person("דנה", DANA)],
          content: "רוני ודנה מתאמות נסיעות ביחד",
          citations: [m, other],
        }),
        belief({
          memoryType: "episodic",
          subjects: [],
          content: "הקבוצה תכננה מפגש",
          citations: [m],
        }),
        belief({
          memoryType: "self_state",
          facet: "behaviour",
          subjects: [],
          content: "לענות בקצרה בקבוצה הזאת",
          citations: [m, other],
        }),
      ],
      g,
    );

    expect(tally(results)).toEqual({ created: 3 });
    const stored = await listLiveMemories(pool, { groupId: g });
    expect(stored.map((s) => s.memoryType).sort()).toEqual([
      "episodic",
      "relational",
      "self_state",
    ]);
  });

  it("refuses a named subject who left no identity behind, and counts it", async () => {
    const g = await newGroup("no-identity");
    const m = await newMessage(g, null);

    const results = await storeAccepted(
      pool,
      [belief({ subjects: [person("רוני")], citations: [m] })],
      g,
    );

    expect(tally(results)).toEqual({ no_author_identity: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("collapses one person's two identities, and refuses a label two people share", async () => {
    const g = await newGroup("identities");
    const m = await newMessage(g);
    const other = await newMessage(g, DANA);
    await recordLink(pool, { lidJid: "4578552635558@lid", pnJid: RONI, source: "bridge" });

    // The ordinary case: the same human reached the group as a lid and as a phone
    // JID. Canonicalization makes that one subject rather than two.
    const linked = await storeAccepted(
      pool,
      [belief({ subjects: [person("רוני", "4578552635558@lid", RONI)], citations: [m] })],
      g,
    );
    expect(tally(linked)).toEqual({ created: 1 });

    // What survives canonicalization and is still two identities is a label two
    // different people answer to — an operator alias collapsing two members. There
    // is no honest way to pick one, and picking wrong is the mis-attribution the
    // design calls unrecoverable.
    const ambiguous = await storeAccepted(
      pool,
      [belief({ subjects: [person("רוני", RONI, DANA)], content: "x", citations: [other] })],
      g,
    );
    expect(tally(ambiguous)).toEqual({ ambiguous_subject: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toHaveLength(1);
  });

  it("refuses a relationship whose two people turn out to be one", async () => {
    const g = await newGroup("collapsed");
    const m = await newMessage(g);
    const other = await newMessage(g, DANA);
    await recordLink(pool, { lidJid: "160782268526832@lid", pnJid: DANA, source: "bridge" });

    const results = await storeAccepted(
      pool,
      [
        belief({
          memoryType: "relational",
          subjects: [person("דנה", DANA), person("דנה ל׳", "160782268526832@lid")],
          content: "יחס בין אדם לעצמו",
          citations: [m, other],
        }),
      ],
      g,
    );

    // Counted, not thrown: a model reading a roster that carries both forms
    // proposes this routinely, and `createMemory` would raise a constraint error.
    expect(tally(results)).toEqual({ subjects_collapsed: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toEqual([]);
  });

  it("counts a candidate that cited a message from another chat, and stores nothing", async () => {
    const mine = await newGroup("cross-mine");
    const theirs = await newGroup("cross-theirs");
    const foreign = await newMessage(theirs);

    const results = await storeAccepted(
      pool,
      [belief({ content: "טענה שנשענת על צ׳אט אחר", citations: [foreign] })],
      mine,
    );

    expect(tally(results)).toEqual({ cited_nothing_real: 1 });
    expect(await listLiveMemories(pool, { groupId: mine })).toEqual([]);
  });

  it("stores nothing at all when there is nothing accepted", async () => {
    const g = await newGroup("empty");
    const results = await storeAccepted(pool, [], g);
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
        belief({ citations: [good] }),
        // Content the schema refuses: `createMemory` throws on empty content.
        belief({ content: "   ", citations: [good] }),
      ],
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

    const results = await storeAccepted(
      pool,
      [
        belief({ subjects: [person("אלמוני")], content: "לא ניתן לייחוס", citations: [good] }),
        belief({ citations: [good] }),
      ],
      g,
    );

    expect(tally(results)).toEqual({ no_author_identity: 1, created: 1 });
    expect(await listLiveMemories(pool, { groupId: g })).toHaveLength(1);
  });
});

/**
 * Attribution: who a belief ends up being about. The failure that matters here is
 * filing a fact about one person against another — and under the four-type
 * extractor the subject is a NAME the model chose rather than the author of the
 * message, which is exactly why the two containment rules run before this.
 */
describe("toDraft", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("files the belief against the identity of the person the model named", async () => {
    expect(await toDraft(pool, belief({ citations: [7] }), 3)).toEqual({
      draft: {
        memoryType: "semantic",
        groupId: 3,
        subjectJid: RONI,
        content: "רוני לא אוכלת בשר",
        evidence: [{ messageId: 7, stance: "supports" }],
      },
    });
  });

  it("carries every citation through as supporting evidence", async () => {
    const mapped = await toDraft(pool, belief({ citations: [7, 9] }), 3);
    expect("draft" in mapped && mapped.draft.evidence).toEqual([
      { messageId: 7, stance: "supports" },
      { messageId: 9, stance: "supports" },
    ]);
  });

  it("refuses a named subject with no identity rather than downgrading the belief", async () => {
    // The alternative considered and rejected on #95: file it as `episodic`,
    // whose subject is nullable. That keeps the row by calling a fact about a
    // person an event, which corrupts the one thing four tables exist to say.
    expect(await toDraft(pool, belief({ subjects: [person("רוני")], citations: [7] }), 3)).toEqual({
      rejected: "no_author_identity",
    });
  });

  it("gives an event that named nobody a null subject, which only that may have", async () => {
    const mapped = await toDraft(
      pool,
      belief({ memoryType: "episodic", subjects: [], content: "מפגש", citations: [7] }),
      3,
    );
    expect("draft" in mapped && mapped.draft).toEqual({
      memoryType: "episodic",
      groupId: 3,
      subjectJid: null,
      content: "מפגש",
      evidence: [{ messageId: 7, stance: "supports" }],
    });
  });
});
