import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { isAidaMessage, recordAidaMessage } from "./aida-messages.js";
import { upsertGroup } from "./groups.js";

describe("aida-messages", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("records a reply and recognises it", async () => {
    const g = await upsertGroup(pool, { name: "AM-1", source: "live" });
    await recordAidaMessage(pool, { groupId: g, externalId: "3EB0", question: "מה נאמר?" });
    expect(await isAidaMessage(pool, { groupId: g, externalId: "3EB0" })).toBe(true);
  });

  it("does not recognise a message she did not send", async () => {
    const g = await upsertGroup(pool, { name: "AM-2", source: "live" });
    expect(await isAidaMessage(pool, { groupId: g, externalId: "NOPE" })).toBe(false);
  });

  it("is scoped per group — the same external_id in another group is not hers", async () => {
    const a = await upsertGroup(pool, { name: "AM-3a", source: "live" });
    const b = await upsertGroup(pool, { name: "AM-3b", source: "live" });
    await recordAidaMessage(pool, { groupId: a, externalId: "SHARED" });
    expect(await isAidaMessage(pool, { groupId: b, externalId: "SHARED" })).toBe(false);
  });

  it("is idempotent — a duplicate echo cannot fork a second row", async () => {
    const g = await upsertGroup(pool, { name: "AM-4", source: "live" });
    await recordAidaMessage(pool, { groupId: g, externalId: "DUP", question: "first" });
    await recordAidaMessage(pool, { groupId: g, externalId: "DUP", question: "second" });
    const { rows } = await pool.query(
      `SELECT question FROM aida_messages WHERE group_id = $1 AND external_id = 'DUP'`,
      [g],
    );
    expect(rows).toHaveLength(1);
    // First write wins — DO NOTHING, not DO UPDATE.
    expect(rows[0]?.question).toBe("first");
  });

  it("recognises a reply whose echo was NEVER ingested into messages", async () => {
    // The whole reason for keying on external_id: the marker must not depend on
    // the collector having ingested her echo yet, or ever.
    const g = await upsertGroup(pool, { name: "AM-5", source: "live" });
    await recordAidaMessage(pool, { groupId: g, externalId: "NO-ECHO" });
    const { rows } = await pool.query(`SELECT 1 FROM messages WHERE external_id = 'NO-ECHO'`);
    expect(rows).toHaveLength(0);
    expect(await isAidaMessage(pool, { groupId: g, externalId: "NO-ECHO" })).toBe(true);
  });
});
