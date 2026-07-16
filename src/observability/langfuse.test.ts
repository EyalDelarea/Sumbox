import { describe, expect, it, vi } from "vitest";
import { createLangfuseTelemetry } from "./langfuse.js";

function makeDeps() {
  const sdk = { start: vi.fn(), shutdown: vi.fn(async () => {}) };
  const register = vi.fn();
  const makeSdk = vi.fn(() => sdk);
  return { sdk, register, makeSdk, deps: { makeSdk, register } };
}

describe("createLangfuseTelemetry", () => {
  it("starts the OTel SDK and registers the integration exactly once (idempotent)", () => {
    const { sdk, register, makeSdk, deps } = makeDeps();
    const t = createLangfuseTelemetry(deps);
    t.start();
    t.start(); // second call must be a no-op — no double registration
    expect(makeSdk).toHaveBeenCalledOnce();
    expect(sdk.start).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
  });

  it("shutdown flushes the SDK, and is safe before start and when called twice", async () => {
    const { sdk, deps } = makeDeps();
    const t = createLangfuseTelemetry(deps);
    await t.shutdown(); // before start → no-op, no throw
    expect(sdk.shutdown).not.toHaveBeenCalled();
    t.start();
    await t.shutdown();
    await t.shutdown(); // second shutdown → still only one flush
    expect(sdk.shutdown).toHaveBeenCalledOnce();
  });

  it("can restart after shutdown", async () => {
    const { makeSdk, deps } = makeDeps();
    const t = createLangfuseTelemetry(deps);
    t.start();
    await t.shutdown();
    t.start();
    expect(makeSdk).toHaveBeenCalledTimes(2);
  });
});
