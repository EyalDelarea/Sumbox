import { describe, expect, it, vi } from "vitest";
import { makeIdempotentHandler } from "./idempotent-handler.js";

describe("makeIdempotentHandler", () => {
  it("runs work when not already done", async () => {
    const work = vi.fn(async () => {});
    const handler = makeIdempotentHandler({ isDone: async () => false, work });
    await handler("x");
    expect(work).toHaveBeenCalledWith("x");
  });

  it("skips work (idempotent) when already done", async () => {
    const work = vi.fn(async () => {});
    const handler = makeIdempotentHandler({ isDone: async () => true, work });
    await handler("x");
    expect(work).not.toHaveBeenCalled();
  });

  it("passes all args to both isDone and work (variadic — the analyze job,type shape)", async () => {
    const isDone = vi.fn(async () => false);
    const work = vi.fn(async () => {});
    const handler = makeIdempotentHandler({ isDone, work });
    await handler({ payload: { messageId: "7" } }, "analyze.video");
    expect(isDone).toHaveBeenCalledWith({ payload: { messageId: "7" } }, "analyze.video");
    expect(work).toHaveBeenCalledWith({ payload: { messageId: "7" } }, "analyze.video");
  });

  it("propagates a work() rejection so the bus can retry", async () => {
    const handler = makeIdempotentHandler({
      isDone: async () => false,
      work: async () => {
        throw new Error("boom");
      },
    });
    await expect(handler("x")).rejects.toThrow("boom");
  });
});
