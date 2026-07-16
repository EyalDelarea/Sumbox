import { describe, expect, it, vi } from "vitest";
import {
  createLangfuseTelemetry,
  defaultLangfuseDeps,
  isLocalLangfuseUrl,
  withTraceAttributes,
} from "./langfuse.js";

describe("withTraceAttributes", () => {
  it("runs the callback and returns its result (attrs propagate to spans within)", async () => {
    const fn = vi.fn(async () => "answer");
    const out = await withTraceAttributes({ sessionId: "group:7", tags: ["aida", "live"] }, fn);
    expect(out).toBe("answer");
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("isLocalLangfuseUrl (privacy guard)", () => {
  it("accepts only on-device hosts", () => {
    for (const u of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://0.0.0.0:3000",
      "http://[::1]:3000",
    ]) {
      expect(isLocalLangfuseUrl(u)).toBe(true);
    }
  });

  it("rejects the cloud default and any off-device / malformed host", () => {
    for (const u of [
      "https://cloud.langfuse.com",
      "https://us.cloud.langfuse.com",
      "http://192.168.1.5:3000",
      "http://langfuse.example.com",
      "not-a-url",
      "",
    ]) {
      expect(isLocalLangfuseUrl(u)).toBe(false);
    }
  });
});

describe("defaultLangfuseDeps", () => {
  it("refuses to build an exporter for a non-local baseUrl (no off-device leak)", () => {
    expect(() =>
      defaultLangfuseDeps({
        baseUrl: "https://cloud.langfuse.com",
        publicKey: "pk",
        secretKey: "sk",
      }),
    ).toThrow(/must be local/);
  });
});

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
