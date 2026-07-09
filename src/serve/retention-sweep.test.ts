import { describe, expect, it } from "vitest";
import { runRetentionSweep } from "./retention-sweep.js";

describe("runRetentionSweep", () => {
  it("purges each opted-in tenant with its own window and unlinks freed media", async () => {
    const purgeCalls: Array<{ tenantId: string; days: number }> = [];
    const unlinked: string[] = [];
    const total = await runRetentionSweep({
      listTenants: async () => [
        { tenantId: "t1", retentionDays: 30 },
        { tenantId: "t2", retentionDays: 7 },
      ],
      purgeChats: async (tenantId, days) => {
        purgeCalls.push({ tenantId, days });
        return tenantId === "t1"
          ? { chatsAffected: 2, mediaPaths: ["/a", "/b"] }
          : { chatsAffected: 1, mediaPaths: [] };
      },
      unlink: async (paths) => {
        unlinked.push(...paths);
        return paths.length;
      },
    });

    expect(total).toBe(3);
    expect(purgeCalls).toEqual([
      { tenantId: "t1", days: 30 },
      { tenantId: "t2", days: 7 },
    ]);
    expect(unlinked).toEqual(["/a", "/b"]); // t2 had no media → unlink not called with empty
  });

  it("isolates a failing tenant — the rest of the sweep still runs", async () => {
    const purged: string[] = [];
    const warnings: string[] = [];
    const total = await runRetentionSweep({
      listTenants: async () => [
        { tenantId: "boom", retentionDays: 30 },
        { tenantId: "ok", retentionDays: 30 },
      ],
      purgeChats: async (tenantId) => {
        if (tenantId === "boom") throw new Error("db down");
        purged.push(tenantId);
        return { chatsAffected: 1, mediaPaths: [] };
      },
      unlink: async (p) => p.length,
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });

    expect(total).toBe(1);
    expect(purged).toEqual(["ok"]);
    expect(warnings.some((w) => w.includes("boom"))).toBe(true);
  });

  it("does nothing when no tenant opted into retention", async () => {
    let purgeCount = 0;
    const total = await runRetentionSweep({
      listTenants: async () => [],
      purgeChats: async () => {
        purgeCount++;
        return { chatsAffected: 0, mediaPaths: [] };
      },
      unlink: async () => 0,
    });
    expect(total).toBe(0);
    expect(purgeCount).toBe(0);
  });
});
