import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { installConsoleGuard } from "./install-console.js";

/** Build a pino logger that collects emitted records as parsed objects. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk));
    },
  };
  const logger = pino({ level: "trace" }, stream);
  return { logger, lines };
}

describe("installConsoleGuard", () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
  });

  it("drops the libsignal 'Closing session:' dump", () => {
    const { logger, lines } = captureLogger();
    restore = installConsoleGuard(logger);
    console.info("Closing session:", { privKey: Buffer.from([1, 2, 3]) });
    expect(lines).toHaveLength(0);
  });

  it("routes a plain console.log to pino info tagged source:console", () => {
    const { logger, lines } = captureLogger();
    restore = installConsoleGuard(logger);
    console.log("hi there");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: "console", msg: "hi there", level: 30 });
  });

  it("maps console levels: warn->40, error->50, debug->20, info->30", () => {
    const { logger, lines } = captureLogger();
    restore = installConsoleGuard(logger);
    console.warn("w");
    console.error("e");
    console.debug("d");
    console.info("i");
    expect(lines.map((l) => l.level)).toEqual([40, 50, 20, 30]);
  });

  it("redacts Buffer / Uint8Array arguments", () => {
    const { logger, lines } = captureLogger();
    restore = installConsoleGuard(logger);
    console.log("key is", Buffer.from([9, 9, 9]));
    expect(lines[0].detail).toBe("[redacted]");
  });

  it("redacts sensitive key fields inside objects", () => {
    const { logger, lines } = captureLogger();
    restore = installConsoleGuard(logger);
    console.log("session", {
      registrationId: 42,
      currentRatchet: { rootKey: Buffer.from([1]), privKey: Buffer.from([2]) },
    });
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("42"); // non-sensitive field preserved
  });

  it("attaches an Error argument as err", () => {
    const { logger, lines } = captureLogger();
    restore = installConsoleGuard(logger);
    console.error("boom", new Error("kaboom"));
    expect(lines[0].level).toBe(50);
    expect(JSON.stringify(lines[0])).toContain("kaboom");
  });

  it("never propagates a failure from inside the guard", () => {
    const { logger } = captureLogger();
    restore = installConsoleGuard(logger);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => console.log("circular", circular)).not.toThrow();
  });

  it("is idempotent and restore() returns the originals", () => {
    const original = console.log;
    const { logger } = captureLogger();
    const r1 = installConsoleGuard(logger);
    const guarded = console.log;
    const r2 = installConsoleGuard(logger);
    expect(console.log).toBe(guarded); // second install does not re-wrap
    r2();
    r1();
    expect(console.log).toBe(original);
  });
});
