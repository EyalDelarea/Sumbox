import { afterEach, describe, expect, it, vi } from "vitest";
import { runPurgeBatch, startMediaPurgeLoop } from "./media-purge-loop.js";

const OLDER_THAN_MS = 30 * 86_400_000; // 30 days default

const baseDeps = (over: Partial<Parameters<typeof runPurgeBatch>[0]> = {}) => ({
  selectMinimizable: vi
    .fn()
    .mockResolvedValue([{ messageId: 1, mediaPath: "/data/media/backfill/bf-1.jpg" }]),
  unlinkFile: vi.fn().mockResolvedValue(undefined),
  markMinimized: vi.fn().mockResolvedValue(undefined),
  ...over,
});

const logSpy = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() });

describe("runPurgeBatch", () => {
  it("calls unlinkFile then markMinimized for each eligible row", async () => {
    const deps = baseDeps();
    const n = await runPurgeBatch(deps, OLDER_THAN_MS);
    expect(n).toBe(1);
    expect(deps.unlinkFile).toHaveBeenCalledWith("/data/media/backfill/bf-1.jpg");
    expect(deps.markMinimized).toHaveBeenCalledWith(1);
    // unlink must precede markMinimized
    const unlinkOrder = (deps.unlinkFile as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const markOrder = (deps.markMinimized as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(unlinkOrder).toBeLessThan(markOrder);
  });

  it("skips unlinkFile when mediaPath is null (row present but no file recorded)", async () => {
    const deps = baseDeps({
      selectMinimizable: vi.fn().mockResolvedValue([{ messageId: 2, mediaPath: null }]),
    });
    const n = await runPurgeBatch(deps, OLDER_THAN_MS);
    expect(n).toBe(1);
    expect(deps.unlinkFile).not.toHaveBeenCalled();
    expect(deps.markMinimized).toHaveBeenCalledWith(2);
  });

  it("passes olderThanMs to selectMinimizable", async () => {
    const deps = baseDeps({ selectMinimizable: vi.fn().mockResolvedValue([]) });
    await runPurgeBatch(deps, 999);
    expect(deps.selectMinimizable).toHaveBeenCalledWith(999);
  });

  it("continues processing remaining rows when one item fails", async () => {
    const deps = baseDeps({
      selectMinimizable: vi.fn().mockResolvedValue([
        { messageId: 10, mediaPath: "/tmp/10.jpg" },
        { messageId: 11, mediaPath: "/tmp/11.jpg" },
      ]),
      unlinkFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("permission denied"))
        .mockResolvedValue(undefined),
    });
    const n = await runPurgeBatch(deps, OLDER_THAN_MS);
    // First item failed → not counted; second succeeded
    expect(n).toBe(1);
    expect(deps.markMinimized).toHaveBeenCalledTimes(1);
    expect(deps.markMinimized).toHaveBeenCalledWith(11);
  });

  it("logs per-item failures at warn without crashing the batch", async () => {
    const log = logSpy();
    const deps = baseDeps({
      unlinkFile: vi.fn().mockRejectedValue(new Error("disk error")),
      log,
    });
    await runPurgeBatch(deps, OLDER_THAN_MS);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("disk error"));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logs count at info when rows were minimized", async () => {
    const log = logSpy();
    const deps = baseDeps({ log });
    await runPurgeBatch(deps, OLDER_THAN_MS);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("minimized 1"));
  });

  it("returns 0 and logs nothing when no rows are eligible", async () => {
    const log = logSpy();
    const deps = baseDeps({
      selectMinimizable: vi.fn().mockResolvedValue([]),
      log,
    });
    const n = await runPurgeBatch(deps, OLDER_THAN_MS);
    expect(n).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("startMediaPurgeLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires runPurgeBatch on interval and stop() clears it", async () => {
    vi.useFakeTimers();
    const deps = baseDeps({ selectMinimizable: vi.fn().mockResolvedValue([]) });
    const handle = startMediaPurgeLoop(deps, { intervalMs: 1000, olderThanMs: OLDER_THAN_MS });

    // No calls yet (first tick hasn't fired)
    expect(deps.selectMinimizable).not.toHaveBeenCalled();

    // Advance past one interval — one tick fires
    await vi.advanceTimersByTimeAsync(1001);
    expect(deps.selectMinimizable).toHaveBeenCalledTimes(1);

    // stop() prevents further ticks
    handle.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.selectMinimizable).toHaveBeenCalledTimes(1);
  });

  it("does not overlap: a running sweep blocks the next tick", async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((res) => {
      resolveFirst = res;
    });

    let callCount = 0;
    const deps = baseDeps({
      selectMinimizable: vi.fn(async () => {
        callCount++;
        if (callCount === 1) await firstPromise;
        return [];
      }),
    });

    const handle = startMediaPurgeLoop(deps, { intervalMs: 100, olderThanMs: OLDER_THAN_MS });

    // Advance timer to trigger two ticks while first is still running
    await vi.advanceTimersByTimeAsync(250);
    expect(callCount).toBe(1); // second tick skipped (overlap guard)

    resolveFirst();
    handle.stop();
  });
});
