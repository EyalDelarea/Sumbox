import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { createAdminPool } from "../client.js";
import { withTransaction } from "../transaction.js";
import { recordLink, siblingForJid } from "./identity-links.js";

describe("identity-links repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const uri = await createTestDatabase();
    pool = createAdminPool(uri);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("records a link and resolves the sibling in both directions", async () => {
    await withTransaction(pool, async (c) => {
      await recordLink(c, {
        lidJid: "123@lid",
        pnJid: "972500000000@s.whatsapp.net",
        source: "message_alt",
      });
      expect(await siblingForJid(c, "123@lid")).toBe("972500000000@s.whatsapp.net");
      expect(await siblingForJid(c, "972500000000@s.whatsapp.net")).toBe("123@lid");
    });
  });

  it("is idempotent on repeat and updates source", async () => {
    await withTransaction(pool, async (c) => {
      await recordLink(c, {
        lidJid: "456@lid",
        pnJid: "972511111111@s.whatsapp.net",
        source: "message_alt",
      });
      await recordLink(c, {
        lidJid: "456@lid",
        pnJid: "972511111111@s.whatsapp.net",
        source: "bridge",
      });
      const { rows } = await c.query("SELECT source FROM identity_links WHERE lid_jid = '456@lid'");
      expect(rows.length).toBe(1);
      expect(rows[0].source).toBe("bridge");
    });
  });

  it("returns null for an unknown jid", async () => {
    await withTransaction(pool, async (c) => {
      expect(await siblingForJid(c, "nope@lid")).toBeNull();
    });
  });
});
