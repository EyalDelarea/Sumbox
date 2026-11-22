import { describe, expect, it } from "vitest";
import { shouldApply } from "./status.js";

describe("shouldApply (D4)", () => {
  it("never applies a model inference, whatever it claims", () => {
    expect(shouldApply("open", "done", "inferred")).toBe(false);
    expect(shouldApply("suggested", "open", "inferred")).toBe(false);
  });

  it("never lets the model transition a task", () => {
    expect(shouldApply("suggested", "open", "model")).toBe(false);
  });

  it("never turns a confirmed task back into a suggestion", () => {
    expect(shouldApply("open", "suggested", "manual")).toBe(false);
  });

  it("applies every explicit source in time order — the latest act wins", () => {
    expect(shouldApply("suggested", "open", "manual")).toBe(true);
    expect(shouldApply("open", "done", "tag")).toBe(true);
    expect(shouldApply("done", "open", "manual")).toBe(true);
    expect(shouldApply("open", "done", "reply")).toBe(true);
    expect(shouldApply("open", "done", "react")).toBe(true);
    expect(shouldApply("open", "done", "poll")).toBe(true);
  });

  it("treats a repeat of the current status as a no-op", () => {
    expect(shouldApply("done", "done", "tag")).toBe(false);
  });
});
