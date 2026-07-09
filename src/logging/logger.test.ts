import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { childLogger, createLogger } from "./logger.js";

/** Capture stream that collects all written JSON lines. */
function captureStream(): { stream: Writable; lines: () => string[] } {
  const collected: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      collected.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => collected };
}

describe("logger", () => {
  describe("structured JSON output", () => {
    it("emits structured JSON to the provided destination", async () => {
      const { stream, lines } = captureStream();
      const captureLogger = pino({ level: "debug" }, stream);
      captureLogger.info({ foo: "bar" }, "test message");

      // flush
      await new Promise((r) => stream.once("drain", r).end(r));

      const parsed = lines()
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));

      expect(parsed.length).toBeGreaterThan(0);
      const entry = parsed[0];
      expect(entry).toMatchObject({ foo: "bar", msg: "test message" });
      // pino emits 'level' as number by default — just check it's there
      expect(entry).toHaveProperty("level");
      expect(entry).toHaveProperty("time");
    });
  });

  describe("createLogger", () => {
    it("returns a pino logger with the configured level", () => {
      const logger = createLogger({ level: "warn" });
      expect(logger.level).toBe("warn");
    });

    it("emits JSON-structured logs to stdout (does not throw)", () => {
      // Just confirm instantiation and logging does not throw
      const logger = createLogger({ level: "info" });
      expect(() => logger.info("startup")).not.toThrow();
    });
  });

  describe("childLogger", () => {
    it("includes correlation fields on log lines", async () => {
      const { stream, lines } = captureStream();
      const base = pino({ level: "debug" }, stream);
      const ctx = {
        jobId: "550e8400-e29b-41d4-a716-446655440000",
        jobType: "transcribe.voicenote",
        groupId: "group-42",
        messageId: "msg-7",
      };

      const child = childLogger(base, ctx);
      child.info("doing work");

      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });

      const parsed = lines()
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));

      expect(parsed.length).toBeGreaterThan(0);
      const entry = parsed[0];
      expect(entry).toMatchObject({
        jobId: ctx.jobId,
        jobType: ctx.jobType,
        groupId: ctx.groupId,
        messageId: ctx.messageId,
        msg: "doing work",
      });
    });

    it("child logger fields do not bleed into base logger", async () => {
      const { stream, lines } = captureStream();
      const base = pino({ level: "debug" }, stream);
      const child = childLogger(base, { jobId: "abc", jobType: "import.file" });

      base.info("base message");
      child.info("child message");

      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });

      const entries = lines()
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));

      const baseEntry = entries.find((e: Record<string, unknown>) => e.msg === "base message");
      const childEntry = entries.find((e: Record<string, unknown>) => e.msg === "child message");

      expect(baseEntry).not.toHaveProperty("jobId");
      expect(childEntry).toMatchObject({ jobId: "abc" });
    });
  });
});
