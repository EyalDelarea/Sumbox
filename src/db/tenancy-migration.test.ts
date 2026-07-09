import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db.js";

/**
 * T010 — Foundational: the tenancy migrations (021–025) establish the expected
 * structure on a freshly-migrated database. Connects as the admin (owner) role.
 *
 * Tenant-scoped tables MUST get a NOT NULL tenant_id FK + RLS (enabled & forced) +
 * the tenant_isolation policy. Global tables MUST NOT.
 */

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const SCOPED_TABLES = [
  "groups",
  "participants",
  "imports",
  "messages",
  "transcripts",
  "summaries",
  "total_summaries",
  "media_analyses",
  "message_media",
  "read_watermarks",
  "job_runs",
  "scheduler_state",
] as const;

const GLOBAL_TABLES = ["service_status", "status_snapshots"] as const;

let pool: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  pool = new pg.Pool({ connectionString: uri });
});

afterAll(async () => {
  await pool?.end();
});

describe("tenants table", () => {
  it("exists with the expected columns", async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'tenants'`,
    );
    const cols = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(cols).toMatchObject({
      id: "NO",
      name: "NO",
      status: "NO",
      created_at: "NO",
      deleted_at: "YES",
    });
  });

  it("contains the seeded default tenant", async () => {
    const { rows } = await pool.query(`SELECT id, name, status FROM tenants WHERE id = $1`, [
      DEFAULT_TENANT_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "default", status: "active" });
  });
});

describe("tenant_id on scoped tables", () => {
  it.each(SCOPED_TABLES)("%s has a NOT NULL tenant_id column", async (table) => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_name = $1 AND column_name = 'tenant_id'`,
      [table],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].data_type).toBe("uuid");
  });

  it.each(SCOPED_TABLES)("%s has a FK from tenant_id to tenants(id)", async (table) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_name = $1 AND kcu.column_name = 'tenant_id'`,
      [table],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("RLS on scoped tables", () => {
  it.each(SCOPED_TABLES)("%s has RLS enabled and forced", async (table) => {
    const { rows } = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    expect(rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each(SCOPED_TABLES)("%s has the tenant_isolation policy", async (table) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_isolation'`,
      [table],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("global tables are NOT tenant-scoped", () => {
  it.each(GLOBAL_TABLES)("%s has no tenant_id column", async (table) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = 'tenant_id'`,
      [table],
    );
    expect(rows).toHaveLength(0);
  });

  it.each(GLOBAL_TABLES)("%s does not have RLS enabled", async (table) => {
    const { rows } = await pool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    expect(rows[0]?.relrowsecurity).toBe(false);
  });
});

describe("database roles", () => {
  it("catchapp_app exists, can login, is not superuser, does not bypass RLS", async () => {
    const { rows } = await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'catchapp_app'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  });

  it("catchapp_operator exists and bypasses RLS", async () => {
    const { rows } = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'catchapp_operator'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rolbypassrls: true, rolsuper: false });
  });
});
