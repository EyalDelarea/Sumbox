import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { createAdminPool } from "../client.js";
import { DEFAULT_TENANT_ID } from "../tenant-context.js";
import {
  createTenant,
  getTenant,
  listTenants,
  markTenantDeleted,
  PURGE_EXCLUDED_TENANT_TABLES,
  purgeTenantData,
  SCOPED_TABLES_DELETE_ORDER,
} from "./tenants.js";

/**
 * US3 — provisioning + lifecycle + the hard data-deletion path. Tenant management is
 * operator-level (the tenants table is not itself RLS-scoped), so these run on the
 * admin/operator connection.
 */

let admin: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  admin = createAdminPool(uri);
});

afterAll(async () => {
  await admin?.end();
});

describe("createTenant / getTenant / listTenants", () => {
  it("creates an active tenant and reads it back", async () => {
    const t = await createTenant(admin, { name: "Acme" });
    expect(t.id).toMatch(/[0-9a-f-]{36}/);
    expect(t.status).toBe("active");

    const got = await getTenant(admin, t.id);
    expect(got?.name).toBe("Acme");
  });

  it("lists tenants including the default", async () => {
    const ids = (await listTenants(admin)).map((t) => t.id);
    expect(ids).toContain(DEFAULT_TENANT_ID);
  });
});

describe("markTenantDeleted", () => {
  it("sets status=deleted and a deleted_at timestamp", async () => {
    const t = await createTenant(admin, { name: "ToDelete" });
    await markTenantDeleted(admin, t.id);
    const got = await getTenant(admin, t.id);
    expect(got?.status).toBe("deleted");
    expect(got?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("purgeTenantData (FR-013)", () => {
  it("removes all of a tenant's scoped rows and leaves other tenants intact", async () => {
    const victim = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name, status) VALUES ($1, 'Victim', 'active')`, [
      victim,
    ]);
    // One group per tenant (admin bypasses RLS; set tenant_id explicitly).
    await admin.query(
      `INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'victim-g', 'import')`,
      [victim],
    );
    await admin.query(
      `INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'keep-g', 'import')`,
      [DEFAULT_TENANT_ID],
    );

    await purgeTenantData(admin, victim);

    const victimRows = await admin.query(`SELECT 1 FROM groups WHERE tenant_id = $1`, [victim]);
    expect(victimRows.rows).toHaveLength(0);
    const keepRows = await admin.query(`SELECT 1 FROM groups WHERE name = 'keep-g'`);
    expect(keepRows.rows).toHaveLength(1);
  });

  it("removes the tenant's auth rows (users/sessions/email tokens) so the tenant row itself can be deleted", async () => {
    const victim = randomUUID();
    await admin.query(
      `INSERT INTO tenants (id, name, status) VALUES ($1, 'AuthVictim', 'active')`,
      [victim],
    );
    const {
      rows: [u],
    } = await admin.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'victim@purge.test', 'h') RETURNING id`,
      [victim],
    );
    await admin.query(
      `INSERT INTO user_sessions (tenant_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, 'purge-session-hash', now() + interval '1 hour')`,
      [victim, u.id],
    );
    await admin.query(
      `INSERT INTO email_tokens (tenant_id, user_id, kind, token_hash, expires_at)
       VALUES ($1, $2, 'verify', 'purge-email-hash', now() + interval '1 hour')`,
      [victim, u.id],
    );

    await purgeTenantData(admin, victim);

    for (const table of ["users", "user_sessions", "email_tokens"]) {
      const left = await admin.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [victim]);
      expect(left.rows).toHaveLength(0);
    }
    // The whole point of the purge: the tenant row is now deletable (no FK holds).
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [victim]);
    expect((await admin.query(`SELECT 1 FROM tenants WHERE id = $1`, [victim])).rows).toHaveLength(
      0,
    );
  });
});

/**
 * Schema guard — a purge that misses a tenant-scoped table silently leaks that tenant's
 * data. Rather than trust the hand-maintained list, assert it against the LIVE schema so a
 * new `tenant_id` table can't ship without being purged (or explicitly excused).
 */
describe("SCOPED_TABLES_DELETE_ORDER schema coverage", () => {
  it("covers every table that carries a tenant_id column (minus explicit exclusions)", async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'`,
    );
    const scopedInDb = new Set(rows.map((r) => r.table_name));
    const listed = new Set([...SCOPED_TABLES_DELETE_ORDER, ...PURGE_EXCLUDED_TENANT_TABLES]);

    // Every scoped table is accounted for (the leak-catcher).
    const missing = [...scopedInDb].filter((t) => !listed.has(t)).sort();
    expect(missing, `tenant-scoped tables missing from the purge list: ${missing}`).toEqual([]);

    // No stale entries (a listed table that no longer carries tenant_id).
    const stale = SCOPED_TABLES_DELETE_ORDER.filter((t) => !scopedInDb.has(t)).sort();
    expect(stale, `purge-list tables that no longer have a tenant_id column: ${stale}`).toEqual([]);
  });

  it("orders children before parents for every intra-list foreign key", async () => {
    const { rows } = await admin.query<{ child: string; parent: string }>(
      `SELECT cl.relname AS child, pl.relname AS parent
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_class pl ON pl.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'`,
    );
    const pos = new Map(SCOPED_TABLES_DELETE_ORDER.map((t, i) => [t, i]));
    const violations: string[] = [];
    for (const { child, parent } of rows) {
      if (child === parent) continue; // self-reference: one DELETE handles the whole set
      const ci = pos.get(child);
      const pi = pos.get(parent);
      if (ci === undefined || pi === undefined) continue; // edge to a non-scoped table (e.g. tenants)
      if (ci > pi) violations.push(`${child} (#${ci}) must precede ${parent} (#${pi})`);
    }
    expect(violations, `FK ordering violations:\n${violations.join("\n")}`).toEqual([]);
  });
});
