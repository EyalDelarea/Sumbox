import { describe, expect, it } from "vitest";
import type { RoseyTaskView } from "../db/repositories/rosey-tasks.js";
import { parseSetOptions, renderTaskList } from "./cli.js";

function item(id: number, title: string, over: Partial<RoseyTaskView> = {}): RoseyTaskView {
  return {
    id,
    groupId: 1,
    title,
    titleKey: title,
    origin: "tag",
    kind: "task",
    status: "open",
    statusSource: "tag",
    raisedByParticipantId: null,
    sourceMessageId: 100 + id,
    sourceItemIndex: 0,
    raisedAt: new Date("2026-11-20T08:00:00Z"),
    raisedBy: "דנה",
    ...over,
  };
}

describe("renderTaskList", () => {
  it("shows tasks and grocery items in separate sections, each grouped by status", () => {
    const out = renderTaskList([
      item(1, "לתקן ברז"),
      item(2, "חלב", { kind: "grocery" }),
      item(3, "להזמין אינסטלטור", { status: "suggested", origin: "suggested" }),
      item(4, "לחם", { kind: "grocery", status: "suggested", origin: "suggested" }),
    ]);
    const tasks = out.indexOf("Tasks (2)");
    const grocery = out.indexOf("Grocery (2)");
    expect(tasks).toBeGreaterThanOrEqual(0);
    expect(grocery).toBeGreaterThan(tasks);
    const taskPart = out.slice(tasks, grocery);
    const groceryPart = out.slice(grocery);
    expect(taskPart).toContain("#1 ");
    expect(taskPart).toContain("#3 ");
    expect(taskPart).not.toContain("#2 ");
    expect(taskPart).not.toContain("#4 ");
    expect(groceryPart).toContain("#2 ");
    expect(groceryPart).toContain("#4 ");
    expect(groceryPart).not.toContain("#1 ");
    // Status groups stay inside each section.
    expect(taskPart.indexOf("open (1)")).toBeLessThan(taskPart.indexOf("suggested (1)"));
    expect(groceryPart).toContain("open (1)");
  });

  it("leaves out a section with no items", () => {
    const out = renderTaskList([item(1, "לתקן ברז")]);
    expect(out).toContain("Tasks (1)");
    expect(out).not.toContain("Grocery");
  });
});

describe("parseSetOptions", () => {
  it("takes a status, a kind, or both", () => {
    expect(parseSetOptions({ status: "done" })).toEqual({ status: "done" });
    expect(parseSetOptions({ kind: "grocery" })).toEqual({ kind: "grocery" });
    expect(parseSetOptions({ status: "open", kind: "task" })).toEqual({
      status: "open",
      kind: "task",
    });
  });

  it("refuses nothing to set, a bad kind, and the 'suggested' status", () => {
    expect(() => parseSetOptions({})).toThrow(/--status or --kind/);
    expect(() => parseSetOptions({ kind: "food" })).toThrow(/--kind must be one of: task, grocery/);
    expect(() => parseSetOptions({ status: "suggested" })).toThrow(/--status/);
  });
});
