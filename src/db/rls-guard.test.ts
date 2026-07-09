import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase } from "../test/db.js";
import { createAppPool } from "./client.js";
import { APP_ROLE, APP_ROLE_PASSWORD } from "./migrations/1748649600024_create_app_roles.js";

/**
 * T2 guard: isolation silently dies if the app ever connects as a superuser or
 * BYPASSRLS role (Postgres skips RLS for those). These tests pin the production
 * posture so a config/migration change that weakens it fails CI loudly.
 */

let uri: string;
let app: pg.Pool;

beforeAll(async () => {
  uri = await createTestDatabase();
  app = appPool(uri);
});

afterAll(async () => {
  await app?.end();
});

describe("the catchapp_app role (what production connects as)", () => {
  it("is NOT superuser and does NOT bypass RLS", async () => {
    const su = await app.query(`SELECT current_setting('is_superuser') AS s`);
    expect(su.rows[0]!.s).toBe("off");

    const role = await app.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("contrast: the admin/test connection IS privileged — so this guard can actually distinguish", async () => {
    const admin = new pg.Pool({ connectionString: uri });
    try {
      const su = await admin.query(`SELECT current_setting('is_superuser') AS s`);
      expect(su.rows[0]!.s).toBe("on");
    } finally {
      await admin.end();
    }
  });
});

describe("createAppPool wiring", () => {
  it("prefers APP_DATABASE_URL over DATABASE_URL (the production cutover knob)", async () => {
    const u = new URL(uri);
    u.username = APP_ROLE;
    u.password = APP_ROLE_PASSWORD;
    const prevApp = process.env.APP_DATABASE_URL;
    const prevDb = process.env.DATABASE_URL;
    process.env.APP_DATABASE_URL = u.toString();
    process.env.DATABASE_URL = "postgres://nobody:wrong@localhost:1/nope";
    try {
      const pool = createAppPool();
      try {
        const who = await pool.query(`SELECT current_user AS u`);
        expect(who.rows[0]!.u).toBe(APP_ROLE);
      } finally {
        await pool.end();
      }
    } finally {
      if (prevApp === undefined) delete process.env.APP_DATABASE_URL;
      else process.env.APP_DATABASE_URL = prevApp;
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
    }
  });
});
