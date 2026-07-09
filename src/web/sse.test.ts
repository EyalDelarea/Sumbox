import { describe, expect, it } from "vitest";
import { sseFrame } from "./sse.js";

describe("sseFrame", () => {
  it("formats an event with a JSON data line and a blank-line terminator", () => {
    expect(sseFrame("token", { delta: "x" })).toBe('event: token\ndata: {"delta":"x"}\n\n');
  });
  it("serializes objects safely (no raw newlines in data)", () => {
    const frame = sseFrame("done", { summaryId: 1, elapsedMs: 1200 });
    expect(frame.startsWith("event: done\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(frame.split("\n").filter((l) => l.startsWith("data: ")).length).toBe(1);
  });
});
