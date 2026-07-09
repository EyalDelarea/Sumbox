import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { createCategory, listCategories, seedSystemCategories } from "./scope-categories.js";

describe("scope-categories repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("lists the migration-seeded system categories ordered by sort_order", async () => {
    const cats = await listCategories(pool);
    const systems = cats.filter((c) => c.isSystem).map((c) => c.name);
    expect(systems).toEqual(["עבודה", "אישי", "לקוחות"]);
  });

  it("creates a user category with the next sort_order", async () => {
    const before = await listCategories(pool);
    const created = await createCategory(pool, "ספק חדש");
    expect(created.id).toBeGreaterThan(0);
    expect(created.isSystem).toBe(false);
    expect(created.sortOrder).toBe(Math.max(...before.map((c) => c.sortOrder)) + 1);
  });

  it("is idempotent on a duplicate name (returns the existing row)", async () => {
    const first = await createCategory(pool, "כפול");
    const second = await createCategory(pool, "כפול");
    expect(second.id).toBe(first.id);
    const names = (await listCategories(pool)).filter((c) => c.name === "כפול");
    expect(names).toHaveLength(1);
  });

  it("seedSystemCategories is idempotent (no duplicates)", async () => {
    await seedSystemCategories(pool);
    const work = (await listCategories(pool)).filter((c) => c.name === "עבודה");
    expect(work).toHaveLength(1);
  });
});
