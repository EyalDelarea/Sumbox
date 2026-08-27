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
import {
  createMemory,
  listMemoriesForReview,
  type MemoryType,
} from "../../db/repositories/aida-memory.js";
import { upsertGroup } from "../../db/repositories/groups.js";
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

  // ── Reading ──────────────────────────────────────────────────────────────

  it("lists a belief with the chat it belongs to", async () => {
    const g = await newGroup("api-list");
    await newMemory(g, "משהו קרה");
    const { status, json } = await get(`?group=${g}`);
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({
      content: "משהו קרה",
      memoryType: "episodic",
      groupId: g,
      byHuman: false,
      revoked: false,
      superseded: false,
    });
    expect(json[0].groupName.length).toBeGreaterThan(0);
  });

  it("hides withdrawn beliefs until they are explicitly asked for", async () => {
    const g = await newGroup("api-withdrawn");
    const id = await newMemory(g, "מבוטל");
    await post("/api/memories/revoke", ref(g, id));

    expect((await get(`?group=${g}`)).json, "the default is what she believes NOW").toEqual([]);
    const withdrawn = (await get(`?group=${g}&withdrawn=1`)).json;
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

    const all = await listMemoriesForReview(pool, { groupId: g, includeWithdrawn: true });
    expect(all, "the row survives — the record outlives the mistake").toHaveLength(1);
    expect(all[0]?.revokedAt).not.toBeNull();
  });

  it("refuses to revoke a belief in another chat", async () => {
    const mine = await newGroup("api-rev-mine");
    const theirs = await newGroup("api-rev-theirs");
    const id = await newMemory(mine, "שלי");

    const { status } = await post("/api/memories/revoke", ref(theirs, id));
    expect(status).toBe(404);
    expect((await listMemoriesForReview(pool, { groupId: mine }))[0]?.revokedAt).toBeNull();
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
    expect((await get(`?group=${g}`)).json[0].content, "and the belief is untouched").toBe(
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

    const live = (await get(`?group=${g}`)).json;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ content: "עבר לחיפה", byHuman: true });
    expect(live[0].correctionNote).toBe("היא הבינה לא נכון");

    const all = (await get(`?group=${g}&withdrawn=1`)).json;
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
    expect((await get(`?group=${g}`)).json[0].content, "and changes nothing").toBe("משהו");
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
    expect((await get(`?group=${mine}`)).json[0].content).toBe("שלי");
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
});
