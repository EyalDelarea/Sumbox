import { describe, it, expect } from "vitest";
import { PHASES, phaseFill, activeZoneIndex, phaseCaption, scanFill } from "./phase-loader.js";

describe("phase-loader", () => {
  it("orders the four phases sync→read→summarize→done", () => {
    expect(PHASES).toEqual(["sync", "read", "summarize", "done"]);
  });

  it("maps each phase to a monotonic fill percentage", () => {
    expect(phaseFill("sync")).toBe(18);
    expect(phaseFill("read")).toBe(48);
    expect(phaseFill("summarize")).toBe(82);
    expect(phaseFill("done")).toBe(100);
    expect(phaseFill("nope")).toBe(0);
  });

  it("maps a phase to its zone index", () => {
    expect(activeZoneIndex("sync")).toBe(0);
    expect(activeZoneIndex("done")).toBe(3);
    expect(activeZoneIndex("nope")).toBe(-1);
  });

  it("captions read phase with the real message count when known", () => {
    expect(phaseCaption("read", { messages: 247 })).toContain("247");
    expect(phaseCaption("read")).not.toContain("undefined");
    expect(phaseCaption("summarize")).toContain("סיכום");
    expect(phaseCaption("done")).toContain("מוכן");
  });

  it("computes total-scan fill capped at 88% and 0 when total is missing", () => {
    expect(scanFill(0, 4)).toBe(0);
    expect(scanFill(2, 4)).toBe(44);
    expect(scanFill(4, 4)).toBe(88);
    expect(scanFill(1, 0)).toBe(0);
  });
});
