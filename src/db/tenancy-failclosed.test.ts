import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase } from "../test/db.js";
import { createAdminPool } from "./client.js";
import { DEFAULT_TENANT_ID } from "./tenant-context.js";

/**
 * US1 — fail-closed (FR-006 / SC-005): using the catchapp_app role with NO tenant
 * context, every scoped-table read returns zero rows and every write is rejected.
 * The system must fail closed, never open.
 *
 * Two GUC states must both fail closed:
 *  - UNSET   — the GUC was never set on the connection (NULL).
 *  - EMPTY   — `SET LOCAL app.tenant_id` left it defined-as-empty-string after COMMIT,
 *              which is the state a pooled connection is in after a `withTenant()` txn.
 *              The EMPTY case is the one the GUC empty-string hardening (migrations 031 +
 *              harden-tenant-guc-new-tables) guards: with the naive
 *              `current_setting(...)::uuid` form, `''::uuid` throws `invalid input syntax
 *              for type uuid: ""` instead of failing closed. The catalog-driven test below
 *              covers EVERY table carrying the `tenant_isolation` policy, so a future
 *              scoped table that regresses the hardened form is caught automatically.
 */

let admin: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  admin = createAdminPool(uri);
  app = appPool(uri);
  // Seed rows for the default tenant via admin (RLS-bypassing) so "0 rows" under a
  // no-context read is meaningful — it proves the policy filters them out, not that the
  // tables are simply empty.
  await admin.query(`INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'seed', 'import')`, [
    DEFAULT_TENANT_ID,
  ]);
  await admin.query(
    `INSERT INTO identity_links (tenant_id, lid_jid, pn_jid, source)
       VALUES ($1, 'l@seed', 'p@seed', 'bridge')`,
    [DEFAULT_TENANT_ID],
  );
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

describe("no tenant context (UNSET GUC)", () => {
  it("reads return zero rows", async () => {
    const { rows } = await app.query(`SELECT * FROM groups`);
    expect(rows).toHaveLength(0);
  });

  it("writes are rejected", async () => {
    await expect(
      app.query(`INSERT INTO groups (name, source) VALUES ('nope', 'import')`),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

describe("empty-string GUC (post-withTenant pooled-connection state)", () => {
  it("reads return zero rows for every tenant-scoped table (no uuid-parse error)", async () => {
    // Every table carrying the tenant_isolation policy must be hardened. Driving this off
    // pg_catalog means a newly-added scoped table is covered without editing this test.
    const { rows: scoped } = await admin.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation' ORDER BY tablename`,
    );
    expect(scoped.length).toBeGreaterThan(0);

    const client = await app.connect();
    try {
      await client.query(`SET app.tenant_id = ''`);
      for (const { tablename } of scoped) {
        // With the naive GUC form this throws `invalid input syntax for type uuid: ""`;
        // with the hardened form it fails closed to zero rows.
        const res = await client.query(`SELECT * FROM ${tablename}`);
        expect(res.rows, `${tablename} should fail closed to 0 rows`).toHaveLength(0);
      }
    } finally {
      await client.query(`RESET app.tenant_id`);
      client.release();
    }
  });

  it("writes are rejected by RLS, not a uuid-parse error", async () => {
    // Tables with clean inserts (no FK to a row that must be seeded first). The default
    // tenant_id resolves to the default tenant via COALESCE, then WITH CHECK rejects it.
    const writeCases = [
      { table: "groups", sql: `INSERT INTO groups (name, source) VALUES ('nope', 'import')` },
      {
        table: "identity_links",
        sql: `INSERT INTO identity_links (lid_jid, pn_jid, source) VALUES ('l@x', 'p@x', 'bridge')`,
      },
    ];

    const client = await app.connect();
    try {
      await client.query(`SET app.tenant_id = ''`);
      for (const { table, sql } of writeCases) {
        // The regex deliberately excludes the uuid-parse error: a regressed (naive) policy
        // throws `invalid input syntax for type uuid: ""`, which does NOT match and fails
        // this assertion.
        await expect(client.query(sql), `${table} write should be RLS-rejected`).rejects.toThrow(
          /row-level security|policy/i,
        );
      }
    } finally {
      await client.query(`RESET app.tenant_id`);
      client.release();
    }
  });
});
