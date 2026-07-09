import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase } from "../../test/db.js";
import { createAdminPool } from "../client.js";
import { DEFAULT_TENANT_ID, withTenant } from "../tenant-context.js";
import { recordLink, siblingForJid } from "./identity-links.js";

const TENANT_A = DEFAULT_TENANT_ID;

describe("identity-links repository", () => {
  let app: pg.Pool;
  let admin: pg.Pool;
  let TENANT_B: string;

  beforeAll(async () => {
    const uri = await createTestDatabase();
    app = appPool(uri);
    admin = createAdminPool(uri);
    TENANT_B = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name, status) VALUES ($1, 'B', 'active')`, [
      TENANT_B,
    ]);
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it("records a link and resolves the sibling in both directions", async () => {
    await withTenant(app, TENANT_A, async (c) => {
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
    await withTenant(app, TENANT_A, async (c) => {
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
    await withTenant(app, TENANT_A, async (c) => {
      expect(await siblingForJid(c, "nope@lid")).toBeNull();
    });
  });

  it("isolates links per tenant", async () => {
    await withTenant(app, TENANT_A, async (c) => {
      await recordLink(c, {
        lidJid: "789@lid",
        pnJid: "972522222222@s.whatsapp.net",
        source: "bridge",
      });
    });
    await withTenant(app, TENANT_B, async (c) => {
      expect(await siblingForJid(c, "789@lid")).toBeNull();
    });
  });
});
