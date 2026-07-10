import { describe, expect, it, vi } from "vitest";
import { startReconcileLoop } from "./identity-reconcile-loop.js";

vi.mock("./identity-reconcile.js", () => ({
  reconcileIdentities: vi.fn().mockResolvedValue(0),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startReconcileLoop", () => {
  it("runs once on startup and reschedules with the interval", async () => {
    const { reconcileIdentities } = await import("./identity-reconcile.js");
    (reconcileIdentities as ReturnType<typeof vi.fn>).mockClear();

    let scheduled: (() => void) | null = null;
    let scheduledMs: number | null = null;
    const setTimer = ((cb: () => void, ms: number) => {
      scheduled = cb;
      scheduledMs = ms;
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as (cb: () => void, ms: number) => NodeJS.Timeout;

    const handle = startReconcileLoop({
      pool: {} as never,
      intervalMs: 1000,
      setTimer,
    });
    await flush();

    expect(reconcileIdentities).toHaveBeenCalledTimes(1);
    expect(reconcileIdentities).toHaveBeenCalledWith({});
    expect(scheduledMs).toBe(1000);
    expect(typeof scheduled).toBe("function");

    // Drive the scheduled second tick and confirm it reconciles again.
    scheduled?.();
    await flush();
    expect(reconcileIdentities).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("reports a thrown tick via onError and still reschedules", async () => {
    const { reconcileIdentities } = await import("./identity-reconcile.js");
    const fn = reconcileIdentities as ReturnType<typeof vi.fn>;
    fn.mockReset();
    fn.mockResolvedValue(0);
    fn.mockRejectedValueOnce(new Error("boom"));

    const onError = vi.fn();
    let scheduled: (() => void) | null = null;
    const setTimer = ((cb: () => void) => {
      scheduled = cb;
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as (cb: () => void, ms: number) => NodeJS.Timeout;

    const handle = startReconcileLoop({
      pool: {} as never,
      intervalMs: 1000,
      setTimer,
      onError,
    });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(typeof scheduled).toBe("function"); // still rescheduled despite the throw

    // Drive the rescheduled tick; it should run again and not error this time.
    scheduled?.();
    await flush();
    expect(reconcileIdentities).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});
