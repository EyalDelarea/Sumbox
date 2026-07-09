import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase, operatorPool } from "../../test/db.js";
import { DEFAULT_TENANT_ID, withTenant } from "../tenant-context.js";
import { listTenantStats } from "./operator-stats.js";

/**
 * T5 — cross-tenant aggregates for the operator dashboard. These MUST run on the
 * BYPASSRLS operator pool: by definition they read every tenant's rows at once, which
 * the RLS-enforced app role can never do. The test connects as catchapp_operator to
 * mirror production, and seeds two tenants via the app pool (RLS-attributed).
 */

let app: pg.Pool;
let op: pg.Pool;
let tenantA: string;

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
  tenantA = randomUUID();
  await op.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Acme A')`, [tenantA]);

  // Seed A with a group + 2 messages, default tenant with a group + 1 message.
  await withTenant(app, tenantA, async (c) => {
    const g = await c.query(
      `INSERT INTO groups (name, source) VALUES ('a-grp', 'import') RETURNING id`,
    );
    const gid = g.rows[0].id;
    await c.query(
      `INSERT INTO messages (group_id, source, message_type, text_content, dedupe_key, sent_at)
       VALUES ($1,'import','text','hi',$2, now()), ($1,'import','text','yo',$3, now())`,
      [gid, "a1", "a2"],
    );
  });
  await withTenant(app, DEFAULT_TENANT_ID, async (c) => {
    const g = await c.query(
      `INSERT INTO groups (name, source) VALUES ('d-grp', 'import') RETURNING id`,
    );
    await c.query(
      `INSERT INTO messages (group_id, source, message_type, text_content, dedupe_key, sent_at)
       VALUES ($1,'import','text','def',$2, now())`,
      [g.rows[0].id, "d1"],
    );
  });
});

afterAll(async () => {
  await app?.end();
  await op?.end();
});

describe("listTenantStats", () => {
  it("returns per-tenant group + message counts across ALL tenants (operator pool)", async () => {
    const stats = await listTenantStats(op);
    const a = stats.find((s) => s.tenantId === tenantA);
    const def = stats.find((s) => s.tenantId === DEFAULT_TENANT_ID);

    expect(a).toMatchObject({ name: "Acme A", groupCount: 1, messageCount: 2 });
    expect(def?.messageCount).toBeGreaterThanOrEqual(1);
    // Both tenants are present — this is the cross-tenant view RLS would forbid.
    expect(stats.length).toBeGreaterThanOrEqual(2);
  });

  it("includes deleted tenants' status so the operator can see lifecycle state", async () => {
    const victim = randomUUID();
    await op.query(`INSERT INTO tenants (id, name, status) VALUES ($1, 'Gone', 'deleted')`, [
      victim,
    ]);
    const stats = await listTenantStats(op);
    expect(stats.find((s) => s.tenantId === victim)).toMatchObject({
      status: "deleted",
      groupCount: 0,
      messageCount: 0,
    });
  });
});
