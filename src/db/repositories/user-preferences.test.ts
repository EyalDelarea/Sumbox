import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { getPreferences, setSummaryCommandTrigger, upsertPreferences } from "./user-preferences.js";

describe("user-preferences repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns null before anything is saved", async () => {
    expect(await getPreferences(pool)).toBeNull();
  });

  it("inserts then partially updates, leaving untouched fields intact", async () => {
    await upsertPreferences(pool, { digestTimes: "07:00,20:00", morningNotification: false });
    let prefs = await getPreferences(pool);
    expect(prefs).toMatchObject({ digestTimes: "07:00,20:00", morningNotification: false });

    // touch only theme — digest_times / notification must persist
    const updated = await upsertPreferences(pool, { theme: "dark" });
    expect(updated).toMatchObject({
      digestTimes: "07:00,20:00",
      morningNotification: false,
      theme: "dark",
    });
    prefs = await getPreferences(pool);
    expect(prefs?.theme).toBe("dark");
  });

  it("round-trips engine_config jsonb opaquely", async () => {
    const cfg = { enabled: true, kinds: ["task", "meeting"], proactiveness: "מאוזן" };
    const out = await upsertPreferences(pool, { engineConfig: cfg });
    expect(out.engineConfig).toEqual(cfg);
  });

  it("getPreferences returns the saved digest times", async () => {
    await upsertPreferences(pool, { digestTimes: "06:30,21:00" });
    expect((await getPreferences(pool))?.digestTimes).toBe("06:30,21:00");
  });

  it("round-trips a custom summary command trigger", async () => {
    expect((await getPreferences(pool))?.summaryCommandTrigger ?? null).toBeNull();
    await setSummaryCommandTrigger(pool, "/סכם");
    expect((await getPreferences(pool))!.summaryCommandTrigger).toBe("/סכם");
  });

  it("rejects a trigger that is empty or lacks a leading slash", async () => {
    // Seed a valid trigger first
    await setSummaryCommandTrigger(pool, "/סכם");
    expect((await getPreferences(pool))!.summaryCommandTrigger).toBe("/סכם");

    // Attempt invalid triggers and verify the stored value remains unchanged
    await expect(setSummaryCommandTrigger(pool, "")).rejects.toThrow(/trigger/i);
    expect((await getPreferences(pool))!.summaryCommandTrigger).toBe("/סכם");

    await expect(setSummaryCommandTrigger(pool, "סכם")).rejects.toThrow(/trigger/i);
    expect((await getPreferences(pool))!.summaryCommandTrigger).toBe("/סכם");

    await expect(setSummaryCommandTrigger(pool, "/" + "x".repeat(64))).rejects.toThrow(/trigger/i);
    expect((await getPreferences(pool))!.summaryCommandTrigger).toBe("/סכם");
  });
});
