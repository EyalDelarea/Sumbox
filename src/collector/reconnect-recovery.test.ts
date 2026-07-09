import { describe, expect, it, vi } from "vitest";
import { recoverOnReconnect } from "./reconnect-recovery.js";

const baseDeps = () => ({
  snapshots: [
    { id: 1, name: "A", tLast: new Date(1000) },
    { id: 2, name: "B", tLast: null }, // nothing stored before → no active extend
  ],
  gapFill: vi.fn(async () => ({ fetched: 0, durationMs: 5, partial: false })),
  // group 1 got 3 new messages newer than its snapshot; group 2 got 1.
  countReadableSince: vi.fn(async (groupId: number) => (groupId === 1 ? 3 : 1)),
  logger: { info: vi.fn() },
});

describe("recoverOnReconnect", () => {
  it("active-extends only groups with a pre-outage anchor, using the frozen tLast", async () => {
    const deps = baseDeps();
    await recoverOnReconnect(deps);
    // group 1 has tLast → gapFill(1, snapshot); group 2 tLast null → skipped
    expect(deps.gapFill).toHaveBeenCalledTimes(1);
    expect(deps.gapFill).toHaveBeenCalledWith(1, new Date(1000));
  });

  it("measures recovery as messages newer than the snapshot, across both channels", async () => {
    const deps = baseDeps();
    const res = await recoverOnReconnect(deps);
    // group 1 measured since its tLast; group 2 measured since epoch 0
    expect(deps.countReadableSince).toHaveBeenCalledWith(1, new Date(1000));
    expect(deps.countReadableSince).toHaveBeenCalledWith(2, new Date(0));
    expect(res).toEqual({ groups: 2, recovered: 4 });
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ evt: "reconnect-sync", groupId: 1, recovered: 3 }),
      expect.any(String),
    );
  });

  it("does not log a reconnect-sync line for groups that recovered nothing", async () => {
    const deps = baseDeps();
    deps.countReadableSince = vi.fn(async () => 0);
    const res = await recoverOnReconnect(deps);
    expect(res).toEqual({ groups: 2, recovered: 0 });
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it("never throws if a single group's gapFill rejects", async () => {
    const deps = baseDeps();
    deps.gapFill = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(recoverOnReconnect(deps)).resolves.toEqual(expect.objectContaining({ groups: 2 }));
  });
});
