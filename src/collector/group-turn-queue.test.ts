import { describe, expect, it } from "vitest";
import { GroupTurnQueue } from "./group-turn-queue.js";

describe("GroupTurnQueue", () => {
  it("acquires immediately when the group is idle", async () => {
    const q = new GroupTurnQueue();
    expect(await q.take(1)).toBe("acquired");
  });

  it("queues the second caller and hands it the turn on release", async () => {
    const q = new GroupTurnQueue();
    expect(await q.take(1)).toBe("acquired");

    const order: string[] = [];
    const second = q.take(1, { onQueued: async () => void order.push("queued") });
    await Promise.resolve();
    expect(order).toEqual(["queued"]); // acked BEFORE the turn, not after

    q.release(1);
    expect(await second).toBe("acquired");
    order.push("ran");
    expect(order).toEqual(["queued", "ran"]);
  });

  it("rejects a third caller as busy — the queue is one deep", async () => {
    const q = new GroupTurnQueue();
    await q.take(1);
    const second = q.take(1);
    await Promise.resolve();

    expect(await q.take(1)).toBe("busy");

    q.release(1);
    expect(await second).toBe("acquired");
  });

  it("frees the waiting slot once the waiter is promoted", async () => {
    const q = new GroupTurnQueue();
    await q.take(1);
    const second = q.take(1);
    await Promise.resolve();
    q.release(1);
    await second;

    // Second now holds the turn, so a new caller queues rather than being busy.
    const third = q.take(1);
    await Promise.resolve();
    q.release(1);
    expect(await third).toBe("acquired");
  });

  it("drops a queued turn that waited past the TTL", async () => {
    let clock = 0;
    const q = new GroupTurnQueue({ ttlMs: 1000, now: () => clock });
    await q.take(1);
    const second = q.take(1);
    await Promise.resolve();

    clock = 1001;
    q.release(1);
    expect(await second).toBe("stale");
  });

  it("hands the turn on rather than deadlocking when a waiter goes stale", async () => {
    let clock = 0;
    const q = new GroupTurnQueue({ ttlMs: 1000, now: () => clock });
    await q.take(1);
    const second = q.take(1);
    await Promise.resolve();
    clock = 1001;
    q.release(1);
    expect(await second).toBe("stale");

    // The stale waiter must not leave the group permanently locked.
    expect(await q.take(1)).toBe("acquired");
  });

  it("keeps groups independent", async () => {
    const q = new GroupTurnQueue();
    expect(await q.take(1)).toBe("acquired");
    expect(await q.take(2)).toBe("acquired");
  });

  it("does not let a new caller jump ahead of an already-queued waiter", async () => {
    const q = new GroupTurnQueue();
    await q.take(1);
    const second = q.take(1);
    await Promise.resolve();

    q.release(1);
    // Synchronously after release, before the waiter's continuation runs.
    const jumper = q.take(1);

    expect(await second).toBe("acquired");
    expect(await jumper).not.toBe("acquired");
  });

  it("survives an onQueued that throws", async () => {
    const q = new GroupTurnQueue();
    await q.take(1);
    const second = q.take(1, {
      onQueued: () => Promise.reject(new Error("reaction failed")),
    });
    await Promise.resolve();
    q.release(1);
    expect(await second).toBe("acquired");
  });

  it("releasing an idle group is a no-op", () => {
    const q = new GroupTurnQueue();
    expect(() => q.release(99)).not.toThrow();
  });

  it("promotes the waiter only after the holder releases", async () => {
    const q = new GroupTurnQueue();
    const log: string[] = [];

    await q.take(1);
    const waiter = (async () => {
      log.push(`waiter:${await q.take(1)}`);
    })();

    // Give the waiter every chance to resolve early; it must not.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual([]);

    log.push("holder-released");
    q.release(1);
    await waiter;

    expect(log).toEqual(["holder-released", "waiter:acquired"]);
  });
});
