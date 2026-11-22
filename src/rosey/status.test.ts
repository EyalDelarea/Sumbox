import { describe, expect, it } from "vitest";
import { type EventSource, shouldApply, type TaskStatus } from "./status.js";

const at = (status: TaskStatus, source: EventSource) => ({ status, source });

describe("shouldApply (D4: manual > reply/react > inferred)", () => {
  it("inferred evidence never changes a status", () => {
    expect(shouldApply(at("open", "tag"), "done", "inferred")).toBe(false);
    expect(shouldApply(at("suggested", "model"), "open", "inferred")).toBe(false);
  });

  it("the model never transitions a task", () => {
    expect(shouldApply(at("suggested", "model"), "open", "model")).toBe(false);
  });

  it("nothing turns a task back into a suggestion", () => {
    expect(shouldApply(at("open", "tag"), "suggested", "manual")).toBe(false);
  });

  it("any chat act or a manual change moves a suggestion or a chat-set status", () => {
    expect(shouldApply(at("suggested", "model"), "open", "manual")).toBe(true);
    expect(shouldApply(at("suggested", "model"), "open", "tag")).toBe(true);
    expect(shouldApply(at("open", "tag"), "done", "tag")).toBe(true);
    expect(shouldApply(at("open", "tag"), "done", "reply")).toBe(true);
    expect(shouldApply(at("open", "tag"), "done", "react")).toBe(true);
    expect(shouldApply(at("open", "tag"), "done", "poll")).toBe(true);
    expect(shouldApply(at("done", "tag"), "open", "manual")).toBe(true);
  });

  it("within the chat layer the latest act wins", () => {
    expect(shouldApply(at("done", "react"), "open", "tag")).toBe(true);
    expect(shouldApply(at("open", "poll"), "dropped", "reply")).toBe(true);
  });

  it("a status set by hand changes only by hand — a later tag never reopens it", () => {
    for (const chat of ["tag", "reply", "react", "poll"] as const) {
      expect(shouldApply(at("done", "manual"), "open", chat)).toBe(false);
      expect(shouldApply(at("dropped", "manual"), "open", chat)).toBe(false);
      expect(shouldApply(at("open", "manual"), "done", chat)).toBe(false);
    }
    expect(shouldApply(at("done", "manual"), "open", "manual")).toBe(true);
  });

  it("a repeat of the current status from the same layer is not a change", () => {
    expect(shouldApply(at("done", "tag"), "done", "tag")).toBe(false);
    expect(shouldApply(at("done", "react"), "done", "tag")).toBe(false);
    expect(shouldApply(at("done", "manual"), "done", "manual")).toBe(false);
  });

  it("a higher layer re-asserting the current status takes ownership of it", () => {
    // Setting by hand what the chat already set is recorded as manual, so it locks.
    expect(shouldApply(at("open", "tag"), "open", "manual")).toBe(true);
    expect(shouldApply(at("done", "react"), "done", "manual")).toBe(true);
  });

  it("a poll untick reopens only what a poll closed", () => {
    // Ticked done by the poll, then un-ticked: back to open.
    expect(shouldApply(at("done", "poll"), "open", "poll")).toBe(true);
    // Closed or dropped by another chat act after the tick: the untick leaves it.
    for (const other of ["tag", "reply", "react"] as const) {
      expect(shouldApply(at("dropped", other), "open", "poll")).toBe(false);
      expect(shouldApply(at("done", other), "open", "poll")).toBe(false);
    }
    // A tick still closes whatever the chat set (the latest act wins).
    expect(shouldApply(at("dropped", "tag"), "done", "poll")).toBe(true);
  });
});
