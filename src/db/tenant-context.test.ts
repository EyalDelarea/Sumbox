import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase, operatorPool } from "../test/db.js";
import {
  currentTenantId,
  DEFAULT_TENANT_ID,
  runWithTenantContext,
  scopedPool,
  withTenant,
} from "./tenant-context.js";

/**
 * The T2 cutover building blocks: a per-query tenant-scoped pool adapter (so a
 * request/job can hold tenant context without one giant long-lived transaction)
 * and an AsyncLocalStorage tenant carrier for worker jobs whose dependency
 * closures were built at startup. Connects as catchapp_app so RLS is REAL here.
 */

let app: pg.Pool;
let op: pg.Pool;
let tenantB: string;
let adminUri: string;

beforeAll(async () => {
  const uri = await createTestDatabase();
  adminUri = uri;
  app = appPool(uri);
  op = operatorPool(uri);
  const { rows } = await op.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('scoped-b') RETURNING id`,
  );
  tenantB = rows[0]!.id;
});

afterAll(async () => {
  await app?.end();
  await op?.end();
});

describe("scopedPool", () => {
  it("attributes writes to its tenant and isolates reads from other tenants (RLS live)", async () => {
    const asB = scopedPool(app, () => tenantB);
    await asB.query(`INSERT INTO groups (name, source) VALUES ('b-group', 'import')`);

    const fromB = await asB.query(`SELECT name FROM groups WHERE name = 'b-group'`);
    expect(fromB.rows).toHaveLength(1);

    const asDefault = scopedPool(app, () => DEFAULT_TENANT_ID);
    const fromDefault = await asDefault.query(`SELECT name FROM groups WHERE name = 'b-group'`);
    expect(fromDefault.rows).toHaveLength(0);

    // The row really belongs to tenant B (checked cross-tenant on the operator pool).
    const truth = await op.query(`SELECT tenant_id FROM groups WHERE name = 'b-group'`);
    expect(truth.rows[0]!.tenant_id).toBe(tenantB);
  });

  it("supports the (text, values) call shape used by every repo", async () => {
    const asB = scopedPool(app, () => tenantB);
    const { rows } = await asB.query<{ name: string }>(`SELECT name FROM groups WHERE name = $1`, [
      "b-group",
    ]);
    expect(rows[0]!.name).toBe("b-group");
  });

  it("re-reads the tenant on every query (late binding for ALS-driven callers)", async () => {
    let active = DEFAULT_TENANT_ID;
    const dynamic = scopedPool(app, () => active);
    const before = await dynamic.query(`SELECT name FROM groups WHERE name = 'b-group'`);
    expect(before.rows).toHaveLength(0);
    active = tenantB;
    const after = await dynamic.query(`SELECT name FROM groups WHERE name = 'b-group'`);
    expect(after.rows).toHaveLength(1);
  });
});

describe("GUC hygiene after withTenant (the empty-string poisoning bug)", () => {
  it("a later UN-scoped query on the same connection still default-attributes instead of erroring", async () => {
    // SET LOCAL leaves the custom GUC DEFINED-as-'' on the session after COMMIT, so the
    // naive current_setting(...)::uuid in column defaults/policies blows up with
    // `invalid input syntax for type uuid: ""` on the next un-scoped query. max:1 pool
    // forces both queries onto the same poisoned connection.
    const single = new (await import("pg")).default.Pool({
      connectionString: adminUri,
      max: 1,
    });
    try {
      await withTenant(single, tenantB, async (c) => {
        await c.query("SELECT 1");
      });
      const r = await single.query(
        `INSERT INTO groups (name, source) VALUES ('post-scoped-raw', 'import') RETURNING tenant_id`,
      );
      expect(r.rows[0]!.tenant_id).toBe(DEFAULT_TENANT_ID);
    } finally {
      await single.end();
    }
  });
});

describe("runWithTenantContext / currentTenantId", () => {
  it("defaults to DEFAULT_TENANT_ID outside any context", () => {
    expect(currentTenantId()).toBe(DEFAULT_TENANT_ID);
  });

  it("carries the tenant across awaits inside the context", async () => {
    const seen = await runWithTenantContext(tenantB, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentTenantId();
    });
    expect(seen).toBe(tenantB);
    expect(currentTenantId()).toBe(DEFAULT_TENANT_ID);
  });

  it("a scopedPool reading currentTenantId routes queries to the job's tenant", async () => {
    const jobPool = scopedPool(app, currentTenantId);
    const inB = await runWithTenantContext(tenantB, () =>
      jobPool.query(`SELECT name FROM groups WHERE name = 'b-group'`),
    );
    expect(inB.rows).toHaveLength(1);
    const outside = await jobPool.query(`SELECT name FROM groups WHERE name = 'b-group'`);
    expect(outside.rows).toHaveLength(0);
  });
});
