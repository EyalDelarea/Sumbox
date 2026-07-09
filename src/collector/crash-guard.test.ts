import { afterEach, describe, expect, it, vi } from "vitest";
import { installMediaStreamCrashGuard, isTransientStreamError } from "./crash-guard.js";

describe("isTransientStreamError", () => {
  it("matches undici HTTP/2 stream aborts by code", () => {
    expect(isTransientStreamError({ code: "ERR_HTTP2_STREAM_ERROR" })).toBe(true);
    expect(isTransientStreamError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientStreamError({ code: "UND_ERR_SOCKET" })).toBe(true);
  });

  it("matches the real 'terminated' shape (TypeError with nested cause)", () => {
    const err = Object.assign(new TypeError("terminated"), {
      cause: {
        code: "ERR_HTTP2_STREAM_ERROR",
        message: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
      },
    });
    expect(isTransientStreamError(err)).toBe(true);
  });

  it("matches by message fragment when no code is present", () => {
    expect(isTransientStreamError(new Error("socket hang up"))).toBe(true);
    expect(isTransientStreamError(new Error("other side closed"))).toBe(true);
  });

  it("does NOT match real logic bugs", () => {
    expect(isTransientStreamError(new TypeError("x is not a function"))).toBe(false);
    expect(isTransientStreamError(new Error("column does not exist"))).toBe(false);
    expect(isTransientStreamError(null)).toBe(false);
    expect(isTransientStreamError("nope")).toBe(false);
  });
});

describe("installMediaStreamCrashGuard", () => {
  let teardown: (() => void) | null = null;

  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  /** Grab the uncaughtException listener this guard just registered. */
  function lastUncaughtListener() {
    const ls = process.listeners("uncaughtException");
    return ls[ls.length - 1] as (err: unknown) => void;
  }

  it("swallows a transient stream error without calling onFatal", () => {
    const log = vi.fn();
    const onFatal = vi.fn();
    teardown = installMediaStreamCrashGuard({ log, onFatal });

    lastUncaughtListener()(
      Object.assign(new TypeError("terminated"), { cause: { code: "ERR_HTTP2_STREAM_ERROR" } }),
    );

    expect(onFatal).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("swallowed transient"));
  });

  it("treats a non-transient error as fatal", () => {
    const log = vi.fn();
    const onFatal = vi.fn();
    teardown = installMediaStreamCrashGuard({ log, onFatal });

    lastUncaughtListener()(new TypeError("boom is not a function"));

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("fatal uncaughtException"));
  });

  it("is idempotent (second install is a no-op while armed)", () => {
    const before = process.listeners("uncaughtException").length;
    teardown = installMediaStreamCrashGuard({ log: vi.fn(), onFatal: vi.fn() });
    const secondTeardown = installMediaStreamCrashGuard({ log: vi.fn(), onFatal: vi.fn() });
    secondTeardown(); // no-op teardown
    expect(process.listeners("uncaughtException").length).toBe(before + 1);
  });
});
