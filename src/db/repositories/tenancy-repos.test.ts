import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase } from "../../test/db.js";
import { DEFAULT_TENANT_ID, withTenant } from "../tenant-context.js";
import { listGroups, upsertGroup } from "./groups.js";

/**
 * US2 — repository writes performed inside withTenant() are auto-attributed to the
 * active tenant (via the tenant_id column default) and are readable within that context.
 * Exercised as the catchapp_app role so RLS applies.
 */

let app: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
});

afterAll(async () => {
  await app?.end();
});

describe("repo writes under withTenant auto-attribute to the tenant", () => {
  it("a group upserted in the default-tenant context is visible there", async () => {
    const id = await withTenant(app, DEFAULT_TENANT_ID, (c) =>
      upsertGroup(c, { name: "Repo-wired group", source: "import" }),
    );
    expect(id).toBeGreaterThan(0);

    const names = await withTenant(app, DEFAULT_TENANT_ID, async (c) => {
      const groups = await listGroups(c);
      return groups.map((g) => g.name);
    });
    expect(names).toContain("Repo-wired group");
  });
});
