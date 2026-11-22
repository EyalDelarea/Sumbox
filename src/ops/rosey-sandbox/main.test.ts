import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { watchExit } from "./main.js";

describe("watchExit", () => {
  it("stops on SIGINT, SIGTERM and SIGHUP, and tears down on an uncaught error", () => {
    const proc = new EventEmitter();
    const seen: string[] = [];
    const unwatch = watchExit(proc, {
      stop: (signal) => seen.push(`stop:${signal}`),
      crash: (err) => seen.push(`crash:${(err as Error).message}`),
    });
    proc.emit("SIGINT");
    proc.emit("SIGTERM");
    proc.emit("SIGHUP");
    proc.emit("uncaughtException", new Error("boom"));
    proc.emit("unhandledRejection", new Error("lost"));
    expect(seen).toEqual([
      "stop:SIGINT",
      "stop:SIGTERM",
      "stop:SIGHUP",
      "crash:boom",
      "crash:lost",
    ]);

    unwatch();
    for (const e of ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"]) {
      expect(proc.listenerCount(e), e).toBe(0);
    }
  });
});
