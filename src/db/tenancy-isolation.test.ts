import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase } from "../test/db.js";
import { createAdminPool } from "./client.js";
import { DEFAULT_TENANT_ID, withTenant } from "./tenant-context.js";

/**
 * US1 — Tenant data is provably isolated (RLS-enforced), exercised by connecting as
 * the non-superuser catchapp_app role. Tenant A = the default tenant; tenant B is a
 * second tenant seeded via the admin (RLS-bypassing) connection.
 */

const TENANT_A = DEFAULT_TENANT_ID;
let TENANT_B: string;

let admin: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  admin = createAdminPool(uri);
  app = appPool(uri);

  TENANT_B = randomUUID();
  // Seed via admin (bypasses RLS): a second tenant + one group per tenant.
  await admin.query(`INSERT INTO tenants (id, name, status) VALUES ($1, 'B', 'active')`, [
    TENANT_B,
  ]);
  await admin.query(
    `INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'A-group', 'import')`,
    [TENANT_A],
  );
  await admin.query(
    `INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'B-group', 'import')`,
    [TENANT_B],
  );
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

describe("read isolation (SC-001)", () => {
  it("a tenant sees only its own rows", async () => {
    const namesA = await withTenant(app, TENANT_A, async (c) => {
      const { rows } = await c.query<{ name: string }>(`SELECT name FROM groups`);
      return rows.map((r) => r.name);
    });
    expect(namesA).toEqual(["A-group"]);

    const namesB = await withTenant(app, TENANT_B, async (c) => {
      const { rows } = await c.query<{ name: string }>(`SELECT name FROM groups`);
      return rows.map((r) => r.name);
    });
    expect(namesB).toEqual(["B-group"]);
  });
});

describe("write rejection (FR-007 / SC-001)", () => {
  it("rejects inserting a row labelled with a different tenant", async () => {
    await expect(
      withTenant(app, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'sneaky', 'import')`,
          [TENANT_B],
        );
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

describe("DB backstop independent of app-layer filtering (SC-002)", () => {
  it("a raw SELECT with no WHERE tenant_id still returns only the active tenant", async () => {
    const names = await withTenant(app, TENANT_A, async (c) => {
      // Deliberately no tenant filter in the query — RLS must still scope it.
      const { rows } = await c.query<{ name: string }>(`SELECT name FROM groups`);
      return rows.map((r) => r.name);
    });
    expect(names).toEqual(["A-group"]);
  });
});

describe("new-tenant isolation is mutual (US3 / SC-006)", () => {
  it("data written under B is invisible to A and vice versa", async () => {
    await withTenant(app, TENANT_B, async (c) => {
      await c.query(
        `INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'B-only', 'import')`,
        [TENANT_B],
      );
    });
    const aSees = await withTenant(app, TENANT_A, async (c) => {
      const { rows } = await c.query(`SELECT 1 FROM groups WHERE name = 'B-only'`);
      return rows.length;
    });
    expect(aSees).toBe(0);
  });
});
