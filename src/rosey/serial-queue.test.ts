import { describe, expect, it } from "vitest";
import { GroupSerialQueue } from "./serial-queue.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("GroupSerialQueue", () => {
  it("runs one group's jobs strictly in order, never overlapping, and drops none", async () => {
    const q = new GroupSerialQueue();
    const log: string[] = [];
    let running = 0;
    const job = (name: string) => async () => {
      running++;
      expect(running).toBe(1);
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      running--;
      return name;
    };
    const results = await Promise.all(["a", "b", "c", "d"].map((n) => q.run(1, job(n))));
    expect(results).toEqual(["a", "b", "c", "d"]);
    expect(log).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
      "start d",
      "end d",
    ]);
  });

  it("a failed job rejects its own caller but does not wedge the group", async () => {
    const q = new GroupSerialQueue();
    const failed = q.run(1, async () => {
      throw new Error("boom");
    });
    const next = q.run(1, async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("different groups do not wait for each other", async () => {
    const q = new GroupSerialQueue();
    let release!: () => void;
    const blocked = q.run(1, () => new Promise<void>((r) => (release = r)));
    await expect(q.run(2, async () => "other group")).resolves.toBe("other group");
    release();
    await blocked;
  });

  it("forgets a group once its queue drains", async () => {
    const q = new GroupSerialQueue();
    await q.run(7, async () => {});
    await tick();
    expect(q.size).toBe(0);
  });
});
