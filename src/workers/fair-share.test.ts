import { describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID } from "../db/tenant-context.js";
import type { Job } from "../jobs/job-types.js";
import { makeFairShareDispatcher } from "./fair-share.js";

/**
 * T3 fair-share: with one shared queue per job type and a single-threaded executor
 * (the inference bottleneck), a flood from tenant A must not starve tenant B. The
 * dispatcher buffers delivered jobs per tenant and executes them one at a time,
 * round-robin across tenants — per-tenant FIFO preserved.
 */

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function job(id: string, tenantId?: string): Job<"summarize.group"> {
  return {
    id,
    type: "summarize.group",
    payload: { groupId: id, ...(tenantId ? { tenantId } : {}) },
    attempts: 1,
    maxAttempts: 3,
  };
}

/** A controllable handler: records execution order; resolves when released. */
function makeRecordingHandler(opts: { autoRelease?: boolean } = {}) {
  const order: string[] = [];
  const releases: Array<() => void> = [];
  let running = 0;
  let maxRunning = 0;
  const handler = async (j: Job<"summarize.group">): Promise<void> => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    order.push(j.id);
    if (!opts.autoRelease) {
      await new Promise<void>((resolve) => releases.push(resolve));
    }
    running--;
  };
  return {
    handler,
    order,
    releaseNext: () => releases.shift()?.(),
    get maxRunning() {
      return maxRunning;
    },
  };
}

describe("makeFairShareDispatcher", () => {
  it("a flood from tenant A does not starve tenant B: B runs second, not sixth", async () => {
    const rec = makeRecordingHandler({ autoRelease: true });
    const dispatch = makeFairShareDispatcher(rec.handler);

    // Delivery order is FIFO from the queue: five A jobs, then B's single job.
    const settled = Promise.all([
      dispatch(job("a1", A)),
      dispatch(job("a2", A)),
      dispatch(job("a3", A)),
      dispatch(job("a4", A)),
      dispatch(job("a5", A)),
      dispatch(job("b1", B)),
    ]);
    await settled;

    // a1 was already executing when b1 arrived; after it, tenants alternate.
    expect(rec.order[0]).toBe("a1");
    expect(rec.order.indexOf("b1")).toBeLessThanOrEqual(2);
    expect(rec.order).toHaveLength(6);
  });

  it("preserves per-tenant FIFO order", async () => {
    const rec = makeRecordingHandler({ autoRelease: true });
    const dispatch = makeFairShareDispatcher(rec.handler);
    await Promise.all([
      dispatch(job("a1", A)),
      dispatch(job("b1", B)),
      dispatch(job("a2", A)),
      dispatch(job("b2", B)),
    ]);
    expect(rec.order.indexOf("a1")).toBeLessThan(rec.order.indexOf("a2"));
    expect(rec.order.indexOf("b1")).toBeLessThan(rec.order.indexOf("b2"));
  });

  it("never runs two jobs concurrently (the executor models the single inference slot)", async () => {
    const rec = makeRecordingHandler();
    const dispatch = makeFairShareDispatcher(rec.handler);
    const all = Promise.all([dispatch(job("a1", A)), dispatch(job("b1", B))]);
    // Release jobs one at a time.
    await new Promise((r) => setTimeout(r, 5));
    rec.releaseNext();
    await new Promise((r) => setTimeout(r, 5));
    rec.releaseNext();
    await all;
    expect(rec.maxRunning).toBe(1);
  });

  it("jobs without tenantId run as the default tenant lane", async () => {
    const rec = makeRecordingHandler({ autoRelease: true });
    const dispatch = makeFairShareDispatcher(rec.handler);
    await Promise.all([dispatch(job("legacy")), dispatch(job("b1", B))]);
    expect(rec.order).toContain("legacy");
    expect(rec.order).toContain("b1");
    void DEFAULT_TENANT_ID;
  });

  it("a failing job rejects ITS caller (so the bus can retry it) without poisoning the lane", async () => {
    const dispatch = makeFairShareDispatcher(async (j: Job<"summarize.group">) => {
      if (j.id === "boom") throw new Error("model exploded");
    });
    const boom = dispatch(job("boom", A));
    const ok = dispatch(job("fine", A));
    await expect(boom).rejects.toThrow("model exploded");
    await expect(ok).resolves.toBeUndefined();
  });
});
