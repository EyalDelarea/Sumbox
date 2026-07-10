import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordLink } from "../db/repositories/identity-links.js";
import { createTestDatabase } from "../test/db.js";
import { reconcileIdentities } from "./identity-reconcile.js";

describe("reconcileIdentities", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("merges a split pair using only the DB map (no live session)", async () => {
    const lid = "123@lid";
    const pn = "972500000000@s.whatsapp.net";
    // Named lid row + unnamed pn row (name == jid) for the same person + a link.
    await pool.query("INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, 'Dana', 'live')", [
      lid,
    ]);
    await pool.query("INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $1, 'live')", [
      pn,
    ]);
    await recordLink(pool, { lidJid: lid, pnJid: pn, source: "message_alt" });

    const merged = await reconcileIdentities(pool);
    expect(merged).toBe(1);

    // Exactly one of the two rows remains, and it is named (not a raw jid).
    const { rows } = await pool.query(
      "SELECT whatsapp_id, name FROM groups WHERE whatsapp_id IN ($1, $2)",
      [lid, pn],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Dana");
  });

  it("returns 0 when there is nothing to merge", async () => {
    const merged = await reconcileIdentities(pool);
    expect(merged).toBe(0);
  });
});
