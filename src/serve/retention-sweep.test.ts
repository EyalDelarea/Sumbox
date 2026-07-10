import { describe, expect, it } from "vitest";
import { runRetentionSweep } from "./retention-sweep.js";

describe("runRetentionSweep", () => {
  it("purges with the configured window and unlinks freed media", async () => {
    const purgeCalls: number[] = [];
    const unlinked: string[] = [];
    const total = await runRetentionSweep({
      retentionDays: async () => 30,
      purgeChats: async (days) => {
        purgeCalls.push(days);
        return { chatsAffected: 2, mediaPaths: ["/a", "/b"] };
      },
      unlink: async (paths) => {
        unlinked.push(...paths);
        return paths.length;
      },
    });

    expect(total).toBe(2);
    expect(purgeCalls).toEqual([30]);
    expect(unlinked).toEqual(["/a", "/b"]);
  });

  it("skips unlink when the purge freed no media", async () => {
    let unlinkCalls = 0;
    const total = await runRetentionSweep({
      retentionDays: async () => 7,
      purgeChats: async () => ({ chatsAffected: 1, mediaPaths: [] }),
      unlink: async () => {
        unlinkCalls++;
        return 0;
      },
    });

    expect(total).toBe(1);
    expect(unlinkCalls).toBe(0);
  });

  it("warns and returns 0 when the purge fails", async () => {
    const warnings: string[] = [];
    const total = await runRetentionSweep({
      retentionDays: async () => 30,
      purgeChats: async () => {
        throw new Error("db down");
      },
      unlink: async (p) => p.length,
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });

    expect(total).toBe(0);
    expect(warnings.some((w) => w.includes("db down"))).toBe(true);
  });

  it("does nothing when retention is disabled", async () => {
    let purgeCount = 0;
    const total = await runRetentionSweep({
      retentionDays: async () => 0,
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
