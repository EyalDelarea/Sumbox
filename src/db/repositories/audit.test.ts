import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase, operatorPool } from "../../test/db.js";
import { DEFAULT_TENANT_ID, withTenant } from "../tenant-context.js";
import { appendAudit, listAudit } from "./audit.js";

/**
 * T6 — append-only audit log. It is GLOBAL (no RLS): the app role writes events while
 * in a tenant context, and the operator reads the whole trail across tenants. The
 * trail also outlives a tenant purge (tenant_id is a bare attribute, not an FK).
 */

let app: pg.Pool;
let op: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
});

afterAll(async () => {
  await app?.end();
  await op?.end();
});

describe("appendAudit / listAudit", () => {
  it("records an event from within a tenant context and reads it back (operator pool)", async () => {
    const userId = randomUUID();
    await withTenant(app, DEFAULT_TENANT_ID, (c) =>
      appendAudit(c, {
        tenantId: DEFAULT_TENANT_ID,
        actorUserId: userId,
        actorEmail: "u@audit.test",
        action: "auth.login",
        ip: "10.0.0.1",
        metadata: { ua: "test" },
      }),
    );
    const rows = await listAudit(op, { limit: 10 });
    const row = rows.find((r) => r.actorEmail === "u@audit.test");
    expect(row).toMatchObject({
      action: "auth.login",
      tenantId: DEFAULT_TENANT_ID,
      actorEmail: "u@audit.test",
      ip: "10.0.0.1",
    });
    expect(row?.metadata).toEqual({ ua: "test" });
    expect(row?.at).toBeInstanceOf(Date);
  });

  it("returns newest-first and honors the limit", async () => {
    for (const action of ["a1", "a2", "a3"]) {
      await appendAudit(op, { action, actorEmail: "seq@audit.test" });
    }
    const rows = await listAudit(op, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.at.getTime()).toBeGreaterThanOrEqual(rows[1]!.at.getTime());
  });

  it("can filter to a single tenant's trail", async () => {
    const t = randomUUID();
    await op.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Audit T')`, [t]);
    await appendAudit(op, { tenantId: t, action: "onboarding.link" });
    const rows = await listAudit(op, { tenantId: t, limit: 10 });
    expect(rows.every((r) => r.tenantId === t)).toBe(true);
    expect(rows.some((r) => r.action === "onboarding.link")).toBe(true);
  });

  it("survives a tenant purge — the trail is not FK'd to tenants", async () => {
    const t = randomUUID();
    await op.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Doomed')`, [t]);
    await appendAudit(op, { tenantId: t, action: "tenant.purged", actorEmail: "boss@audit.test" });
    // Deleting the tenant row must NOT cascade/blow up the audit entry.
    await op.query(`DELETE FROM tenants WHERE id = $1`, [t]);
    const rows = await listAudit(op, { tenantId: t, limit: 10 });
    expect(rows.some((r) => r.action === "tenant.purged")).toBe(true);
  });
});
