import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertCommandPermission } from "../db/repositories/group-command-permissions.js";
import { upsertGroupByWhatsappId } from "../db/repositories/groups.js";
import {
  DEFAULT_SUMMARY_TRIGGER,
  setSummaryCommandTrigger,
} from "../db/repositories/user-preferences.js";
import { createTestDatabase } from "../test/db.js";
import { makeSummaryCommandDeps } from "./summary-command-deps.js";

describe("makeSummaryCommandDeps", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("does not read the DB at construction — never fails to construct", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const deps = makeSummaryCommandDeps(pool, log);
    expect(deps).not.toBeUndefined();
    expect(deps.inFlight.size).toBe(0);
    expect(deps.lastSummaryByGroup.size).toBe(0);
  });

  it("resolveEnabledJids reflects the DB live — reads the group enabled AFTER construction", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const deps = makeSummaryCommandDeps(pool, log);
    expect([...(await deps.resolveEnabledJids())]).toEqual([]);

    const groupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: "live-jid@g.us",
      name: "summary-command-deps live jid",
      source: "live",
    });
    await upsertCommandPermission(pool, { groupId, enabled: true });

    expect([...(await deps.resolveEnabledJids())]).toEqual(["live-jid@g.us"]);
  });

  it("resolveTrigger reflects the DB live — falls back to the default, then picks up a change", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const deps = makeSummaryCommandDeps(pool, log);
    expect(await deps.resolveTrigger()).toBe(DEFAULT_SUMMARY_TRIGGER);

    await setSummaryCommandTrigger(pool, "/סכם");
    expect(await deps.resolveTrigger()).toBe("/סכם");

    // Restore, so this test doesn't leak state into the other tests in this file.
    await setSummaryCommandTrigger(pool, DEFAULT_SUMMARY_TRIGGER);
  });
});
