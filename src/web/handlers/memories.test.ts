/**
 * Tests for the memories cleanup surface.
 *
 * What these are trying to catch is an endpoint that says it did something it
 * did not: a correction that reports success while the original is still the
 * live belief, a revoke that reports success having stamped nothing, or a list
 * that hands back a belief a human already withdrew. Post-hoc cleanup is the
 * whole safety model for this feature, so an endpoint lying about it is the
 * failure — not a 500.
 *
 * Real database, no mocks. Every assertion checks the tables, not the response.
 */
import { randomUUID } from "node:crypto";
import type http from "node:http";
import { PassThrough } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPAIR_NOTE_PREFIX } from "../../ask/memory-repair-run.js";
import {
  correctMemory,
  createMemory,
  flagMemory,
  listMemoriesForReview,
  type MemoryType,
} from "../../db/repositories/aida-memory.js";
import { upsertGroup } from "../../db/repositories/groups.js";
import { recordLink } from "../../db/repositories/identity-links.js";
import { createTestDatabase } from "../../test/db.js";
import type { ServerDeps } from "./context.js";
import { handleMemories } from "./memories.js";

describe("/api/memories", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  function deps(): ServerDeps {
    return {
      pool,
      summarizer: null as unknown as ServerDeps["summarizer"],
      tokenBudget: 0,
      model: "fake",
    };
  }

  function postRequest(body: unknown): http.IncomingMessage {
    const json = JSON.stringify(body);
    const stream = new PassThrough();
    stream.push(Buffer.from(json));
    stream.push(null);
    return Object.assign(stream, {
      method: "POST",
      headers: { "content-length": String(Buffer.byteLength(json)) },
    }) as unknown as http.IncomingMessage;
  }

  function collect(): { res: http.ServerResponse; body: Promise<string>; status: () => number } {
    const chunks: Buffer[] = [];
    let code = 200;
    let resolve: (v: string) => void = () => {};
    const body = new Promise<string>((r) => {
      resolve = r;
    });
    const res = {
      headersSent: false,
      setHeader: () => {},
      writeHead(c: number) {
        code = c;
      },
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        return true;
      },
      end(chunk?: Buffer | string) {
        if (chunk) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        resolve(Buffer.concat(chunks).toString("utf8"));
      },
    } as unknown as http.ServerResponse;
    return { res, body, status: () => code };
  }

  async function get(query: string) {
    const { res, body, status } = collect();
    await handleMemories(
      new URL(`http://x/api/memories${query}`),
      { method: "GET" } as http.IncomingMessage,
      res,
      deps(),
    );
    return { status: status(), json: JSON.parse(await body) };
  }

  async function post(path: string, payload: unknown) {
    const { res, body, status } = collect();
    await handleMemories(new URL(`http://x${path}`), postRequest(payload), res, deps());
    return { status: status(), json: JSON.parse(await body) };
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────

  async function newGroup(name: string): Promise<number> {
    return await upsertGroup(pool, { name: `${name}-${randomUUID().slice(0, 8)}`, source: "live" });
  }
  async function newMessage(groupId: number): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key)
       VALUES ($1,'live','text','נאמר בצ׳אט', now(), $2) RETURNING id`,
      [groupId, `dk-${randomUUID()}`],
    );
    return Number(rows[0]?.id);
  }
  async function newMemory(groupId: number, content: string): Promise<number> {
    const written = await createMemory(pool, {
      memoryType: "episodic",
      groupId,
      content,
      evidence: [{ messageId: await newMessage(groupId), stance: "supports" }],
    });
    expect(written, "fixture write must land").not.toBeNull();
    return written?.id ?? 0;
  }
  const ref = (groupId: number, memoryId: number, memoryType: MemoryType = "episodic") => ({
    memoryType,
    groupId,
    memoryId,
  });

  /** A message from a named person, carrying the lid form the real corpus uses. */
  async function newMessageFrom(groupId: number, name: string, lid: string): Promise<number> {
    const { rows: p } = await pool.query<{ id: string }>(
      `INSERT INTO participants (display_name) VALUES ($1)
       ON CONFLICT (tenant_id, display_name) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [name],
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key, sender_jid, participant_id)
       VALUES ($1,'live','text','נאמר בצ׳אט', now(), $2, $3, $4) RETURNING id`,
      [groupId, `dk-${randomUUID()}`, lid, Number(p[0]?.id)],
    );
    return Number(rows[0]?.id);
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  it("lists a belief with the chat it belongs to", async () => {
    const g = await newGroup("api-list");
    await newMemory(g, "משהו קרה");
    const { status, json } = await get(`?group=${g}`);
    expect(status).toBe(200);
    expect(json.memories).toHaveLength(1);
    expect(json.memories[0]).toMatchObject({
      content: "משהו קרה",
      memoryType: "episodic",
      groupId: g,
      byHuman: false,
      revoked: false,
      superseded: false,
    });
    expect(json.memories[0].groupName.length).toBeGreaterThan(0);
  });

  // Under the four-type extractor the subject is no longer the author of the
  // message the card links to, so a card that cannot name it cannot be judged.
  it("says who each belief is about, by name and across the bridge", async () => {
    const g = await newGroup("api-subjects");
    const lid = `${randomUUID().slice(0, 10)}@lid`;
    const pn = `9725${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
    const messageId = await newMessageFrom(g, "רוני", lid);
    await recordLink(pool, { lidJid: lid, pnJid: pn, source: "bridge" });
    // Stored against the canonical PHONE form, while the name is on the lid.
    await createMemory(pool, {
      memoryType: "semantic",
      groupId: g,
      subjectJid: pn,
      content: "לא אוכלת בשר",
      evidence: [{ messageId, stance: "supports" }],
    });

    const { json } = await get(`?group=${g}`);
    expect(json.memories[0].subjects).toEqual(["רוני"]);
  });

  it("names a subject nobody has a name for as a number, never as a raw JID", async () => {
    const g = await newGroup("api-nameless");
    const messageId = await newMessage(g);
    await createMemory(pool, {
      memoryType: "semantic",
      groupId: g,
      subjectJid: "972500000123@s.whatsapp.net",
      content: "מישהו",
      evidence: [{ messageId, stance: "supports" }],
    });

    const { json } = await get(`?group=${g}`);
    expect(json.memories[0].subjects).toEqual(["+972500000123"]);
  });

  it("gives an event about nobody no subjects at all", async () => {
    const g = await newGroup("api-nosubject");
    await newMemory(g, "משהו קרה לקבוצה");
    const { json } = await get(`?group=${g}`);
    expect(json.memories[0].subjects).toEqual([]);
  });

  it("hides withdrawn beliefs until they are explicitly asked for", async () => {
    const g = await newGroup("api-withdrawn");
    const id = await newMemory(g, "מבוטל");
    await post("/api/memories/revoke", ref(g, id));

    expect(
      (await get(`?group=${g}`)).json.memories,
      "the default is what she believes NOW",
    ).toEqual([]);
    const withdrawn = (await get(`?group=${g}&withdrawn=1`)).json.memories;
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0].revoked).toBe(true);
  });

  it("refuses a malformed filter rather than silently widening the list", async () => {
    expect((await get("?group=abc")).status).toBe(400);
    expect((await get("?type=nonsense")).status).toBe(400);
  });

  // ── Revoking ─────────────────────────────────────────────────────────────

  it("withdraws a belief without deleting it", async () => {
    const g = await newGroup("api-revoke");
    const id = await newMemory(g, "טעות");

    const { status, json } = await post("/api/memories/revoke", ref(g, id));
    expect(status).toBe(200);
    expect(json.revoked).toBe(1);

    const all = (await listMemoriesForReview(pool, { groupId: g, includeWithdrawn: true })).rows;
    expect(all, "the row survives — the record outlives the mistake").toHaveLength(1);
    expect(all[0]?.revokedAt).not.toBeNull();
  });

  it("refuses to revoke a belief in another chat", async () => {
    const mine = await newGroup("api-rev-mine");
    const theirs = await newGroup("api-rev-theirs");
    const id = await newMemory(mine, "שלי");

    const { status } = await post("/api/memories/revoke", ref(theirs, id));
    expect(status).toBe(404);
    expect((await listMemoriesForReview(pool, { groupId: mine })).rows[0]?.revokedAt).toBeNull();
  });

  it("tells an already-withdrawn belief apart from one that does not exist", async () => {
    // Both used to be 404. Telling someone their belief does not exist when it is
    // merely already withdrawn reads as data loss on a screen whose whole promise
    // is that the record stays.
    const g = await newGroup("api-rev-twice");
    const id = await newMemory(g, "כבר בוטל");
    await post("/api/memories/revoke", ref(g, id));

    const again = await post("/api/memories/revoke", ref(g, id));
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("already_revoked");

    const missing = await post("/api/memories/revoke", ref(g, 999_999));
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
  });

  it("refuses an id with trailing garbage instead of targeting the row it prefixes", async () => {
    // `parseInt` read "5x" as 5, so a malformed reference silently revoked a real
    // belief. Digits only.
    const g = await newGroup("api-strict-id");
    const id = await newMemory(g, "לא לגעת");
    const { status } = await post("/api/memories/revoke", {
      memoryType: "episodic",
      groupId: g,
      memoryId: `${id}x`,
    });
    expect(status).toBe(400);
    expect((await get(`?group=${g}`)).json.memories[0].content, "and the belief is untouched").toBe(
      "לא לגעת",
    );
  });

  it("refuses a group filter with trailing garbage rather than widening the list", async () => {
    expect((await get("?group=12abc")).status).toBe(400);
  });

  // ── Correcting ───────────────────────────────────────────────────────────

  it("replaces a belief and marks the replacement as yours", async () => {
    const g = await newGroup("api-correct");
    const id = await newMemory(g, "גר בתל אביב");

    const { status, json } = await post("/api/memories/correct", {
      ...ref(g, id),
      content: "עבר לחיפה",
      note: "היא הבינה לא נכון",
    });
    expect(status).toBe(200);
    expect(json.memoryId).toBeGreaterThan(0);

    const live = (await get(`?group=${g}`)).json.memories;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ content: "עבר לחיפה", byHuman: true });
    expect(live[0].correctionNote).toBe("היא הבינה לא נכון");

    const all = (await get(`?group=${g}&withdrawn=1`)).json.memories;
    const original = all.find((r: { id: number }) => r.id === id);
    expect(original.content, "the original is never rewritten").toBe("גר בתל אביב");
    expect(original.superseded).toBe(true);
    expect(original.byHuman, "and stays marked as hers").toBe(false);
  });

  it("refuses a correction with no reason", async () => {
    const g = await newGroup("api-correct-note");
    const id = await newMemory(g, "משהו");
    for (const note of ["", "   ", undefined]) {
      const { status } = await post("/api/memories/correct", {
        ...ref(g, id),
        content: "משהו אחר",
        note,
      });
      expect(status).toBe(400);
    }
    expect((await get(`?group=${g}`)).json.memories[0].content, "and changes nothing").toBe("משהו");
  });

  // The prefix that marks a repair's note is a literal string `provenanceOf`
  // matches on — a human whose own reason happened to start with it would
  // otherwise be silently stored and rendered as the model's repair, not
  // theirs. The endpoint is the only place that can make that impossible.
  it("refuses a human correction note that starts with the repair prefix", async () => {
    const g = await newGroup("api-correct-reserved");
    const id = await newMemory(g, "משהו");

    const { status, json } = await post("/api/memories/correct", {
      ...ref(g, id),
      content: "אחר",
      note: `${REPAIR_NOTE_PREFIX} זו לא הודעה אמיתית מהמודל`,
    });
    expect(status).toBe(400);
    expect(json.error).toBe("reserved_prefix");

    const memories = (await get(`?group=${g}`)).json.memories;
    expect(memories, "no supersede landed — still exactly the original row").toHaveLength(1);
    expect(memories[0].content, "nothing written").toBe("משהו");
    expect(memories[0].byHuman).toBe(false);
    expect(memories[0].correctionNote).toBeNull();
  });

  it("refuses a correction naming a belief in another chat", async () => {
    const mine = await newGroup("api-cor-mine");
    const theirs = await newGroup("api-cor-theirs");
    const id = await newMemory(mine, "שלי");
    const { status } = await post("/api/memories/correct", {
      ...ref(theirs, id),
      content: "נחטף",
      note: "לא אמור לעבוד",
    });
    expect(status).toBe(404);
    expect((await get(`?group=${mine}`)).json.memories[0].content).toBe("שלי");
  });

  it("refuses a malformed memory reference on either write", async () => {
    for (const path of ["/api/memories/correct", "/api/memories/revoke"]) {
      const { status } = await post(path, {
        memoryType: "not-a-type",
        groupId: 1,
        memoryId: 1,
        content: "x",
        note: "y",
      });
      expect(status).toBe(400);
    }
  });

  // ── Provenance: human correction vs model repair vs neither ────────────────

  it("marks a human correction as byHuman, with the note exposed", async () => {
    const g = await newGroup("api-prov-human");
    const id = await newMemory(g, "משהו");
    const outcome = await correctMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: id,
      content: "תוקן",
      note: "היא טעתה",
    });
    expect(outcome.ok).toBe(true);

    const live = (await get(`?group=${g}`)).json.memories[0];
    expect(live).toMatchObject({
      byHuman: true,
      correctionNote: "היא טעתה",
      repairReason: null,
    });
  });

  // This is the bug the feature exists to fix: a repair supersede used to render
  // identically to a human's, because both are a non-null `correction_note`.
  it("tells a model repair apart from a human correction on the same field", async () => {
    const g = await newGroup("api-prov-repair");
    const id = await newMemory(g, "משהו");
    const outcome = await correctMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: id,
      content: "תוקן על ידה",
      note: `${REPAIR_NOTE_PREFIX} המקור לא תומך בזה`,
    });
    expect(outcome.ok).toBe(true);

    const live = (await get(`?group=${g}`)).json.memories[0];
    expect(live).toMatchObject({
      byHuman: false,
      correctionNote: null,
      repairReason: "המקור לא תומך בזה",
    });
  });

  it("marks an untouched belief as neither human nor repair", async () => {
    const g = await newGroup("api-prov-none");
    await newMemory(g, "משהו");
    const live = (await get(`?group=${g}`)).json.memories[0];
    expect(live).toMatchObject({ byHuman: false, correctionNote: null, repairReason: null });
  });

  it("carries what a repair replaced alongside the reason it did", async () => {
    const g = await newGroup("api-prov-repair-previous");
    const id = await newMemory(g, "משהו ישן");
    const outcome = await correctMemory(pool, {
      memoryType: "episodic",
      groupId: g,
      memoryId: id,
      content: "תוקן על ידה",
      note: `${REPAIR_NOTE_PREFIX} המקור לא תומך בזה`,
    });
    expect(outcome.ok).toBe(true);

    const live = (await get(`?group=${g}`)).json.memories[0];
    expect(live).toMatchObject({
      repairReason: "המקור לא תומך בזה",
      previousContent: "משהו ישן",
    });
  });

  // ── Flags ────────────────────────────────────────────────────────────────

  it("carries an open flag's reason on the belief it doubts", async () => {
    const g = await newGroup("api-flag-list");
    const id = await newMemory(g, "מוטל בספק");
    await flagMemory(pool, { memoryType: "episodic", memoryId: id, reason: "אין תמיכה בהודעות" });

    const live = (await get(`?group=${g}`)).json.memories[0];
    expect(live.flagReason).toBe("אין תמיכה בהודעות");
    expect(typeof live.flaggedAt).toBe("string");
  });

  it("gives an unflagged belief a null flag reason", async () => {
    const g = await newGroup("api-flag-none");
    await newMemory(g, "בסדר גמור");
    const live = (await get(`?group=${g}`)).json.memories[0];
    expect(live.flagReason).toBeNull();
    expect(live.flaggedAt).toBeNull();
  });

  it("dismisses an open flag, and the card stops carrying it", async () => {
    const g = await newGroup("api-unflag");
    const id = await newMemory(g, "מוטל בספק");
    await flagMemory(pool, { memoryType: "episodic", memoryId: id, reason: "בדיקה" });

    const { status, json } = await post("/api/memories/unflag", ref(g, id));
    expect(status).toBe(200);
    expect(json.cleared).toBe(1);

    const live = (await get(`?group=${g}`)).json.memories[0];
    expect(live.flagReason).toBeNull();
    // The belief itself is untouched — unflag answers the doubt, it never
    // withdraws or rewrites the row it was raised against.
    expect(live.content).toBe("מוטל בספק");
    expect(live.revoked).toBe(false);
  });

  it("refuses to unflag a belief that has no open flag", async () => {
    const g = await newGroup("api-unflag-none");
    const id = await newMemory(g, "אין ספק");
    const { status, json } = await post("/api/memories/unflag", ref(g, id));
    expect(status).toBe(404);
    expect(json.error).toBe("not_flagged");
  });

  it("refuses to unflag a belief in another chat", async () => {
    const mine = await newGroup("api-unflag-mine");
    const theirs = await newGroup("api-unflag-theirs");
    const id = await newMemory(mine, "שלי");
    await flagMemory(pool, { memoryType: "episodic", memoryId: id, reason: "בדיקה" });

    const { status, json } = await post("/api/memories/unflag", ref(theirs, id));
    expect(status).toBe(404);
    expect(json.error).toBe("not_found");

    // And the flag is still there to answer, from the chat it actually belongs to.
    const live = (await get(`?group=${mine}`)).json.memories[0];
    expect(live.flagReason).toBe("בדיקה");
  });

  it("refuses a malformed memory reference on unflag too", async () => {
    const { status } = await post("/api/memories/unflag", {
      memoryType: "not-a-type",
      groupId: 1,
      memoryId: 1,
    });
    expect(status).toBe(400);
  });
});
