import { describe, expect, it } from "vitest";
import type { RoseyTask } from "../db/repositories/rosey-tasks.js";
import { applyCommand, type CommandContext, type CommandStore } from "./commands.js";
import { titleKey } from "./text.js";

const NOW = new Date("2026-11-22T10:00:00Z");
const DAY = 86_400_000;

function task(id: number, title: string, over: Partial<RoseyTask> = {}): RoseyTask {
  return {
    id,
    groupId: 1,
    title,
    titleKey: titleKey(title),
    origin: "tag",
    kind: "task",
    status: "open",
    statusSource: "tag",
    raisedByParticipantId: null,
    sourceMessageId: 100 + id,
    sourceItemIndex: 0,
    raisedAt: new Date(NOW.getTime() - DAY),
    ...over,
  };
}

/** An in-memory store with the same live-window semantics as the repository. */
function store(initial: RoseyTask[]) {
  const tasks = [...initial];
  const marks: Array<{ taskId: number; status: string; sourceMessageId: number }> = [];
  const s: CommandStore = {
    liveTasksRaisedBetween: async (since, until) =>
      tasks.filter(
        (t) =>
          (t.status === "open" || t.status === "suggested") &&
          t.raisedAt >= since &&
          t.raisedAt <= until,
      ),
    insertTagged: async (input) => {
      if (
        tasks.some(
          (t) =>
            t.sourceMessageId === input.sourceMessageId &&
            t.sourceItemIndex === input.sourceItemIndex,
        )
      ) {
        return null;
      }
      const id = tasks.length + 1000;
      tasks.push(task(id, input.title, { ...input, raisedAt: input.raisedAt }));
      return id;
    },
    markStatus: async (input) => {
      marks.push(input);
      const t = tasks.find((x) => x.id === input.taskId)!;
      const previous = t.status;
      t.status = input.status;
      return { found: true, applied: previous !== input.status, previous, current: input.status };
    },
  };
  return { s, tasks, marks };
}

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  groupId: 1,
  messageId: 500,
  sentAt: NOW,
  quotedMessageId: null,
  ...over,
});

describe("applyCommand — add", () => {
  it("creates one open task per new item", async () => {
    const { s, tasks } = store([]);
    const out = await applyCommand({ kind: "add", items: ["לקנות חלב", "לתקן ברז"] }, ctx(), s);
    expect(out).toEqual({ kind: "added", created: 2, confirmed: 0, alreadyOpen: 0 });
    expect(tasks.map((t) => [t.title, t.sourceItemIndex])).toEqual([
      ["לקנות חלב", 0],
      ["לתקן ברז", 1],
    ]);
  });

  it("confirms a matching suggestion instead of creating a twin (D3: the tag wins)", async () => {
    const { s, tasks, marks } = store([
      task(1, "לקנות חלב", { status: "suggested", origin: "suggested" }),
    ]);
    const out = await applyCommand({ kind: "add", items: ["לקנות חלב!"] }, ctx(), s);
    expect(out).toEqual({ kind: "added", created: 0, confirmed: 1, alreadyOpen: 0 });
    expect(marks).toEqual([{ taskId: 1, status: "open", sourceMessageId: 500 }]);
    expect(tasks).toHaveLength(1);
  });

  it("is a no-op for an item that is already open, and for a replay of the same message", async () => {
    const { s, tasks } = store([task(1, "לקנות חלב")]);
    expect(await applyCommand({ kind: "add", items: ["לקנות חלב"] }, ctx(), s)).toMatchObject({
      alreadyOpen: 1,
      created: 0,
    });
    await applyCommand({ kind: "add", items: ["לתקן ברז"] }, ctx(), s);
    // The same message seen again (live, then catch-up) — nothing new.
    const again = await applyCommand({ kind: "add", items: ["לתקן ברז"] }, ctx(), s);
    expect(again).toMatchObject({ created: 0 });
    expect(tasks).toHaveLength(2);
  });

  it("an old task outside the dedup window does not swallow a recurring errand", async () => {
    const old = task(1, "לקנות חלב", { raisedAt: new Date(NOW.getTime() - 30 * DAY) });
    const { s, tasks } = store([old]);
    const out = await applyCommand({ kind: "add", items: ["לקנות חלב"] }, ctx(), s);
    expect(out).toMatchObject({ created: 1 });
    expect(tasks).toHaveLength(2);
  });
});

describe("applyCommand — done", () => {
  it("closes the single live task the query names, at any age", async () => {
    const old = task(1, "לתקן ברז", { raisedAt: new Date(NOW.getTime() - 60 * DAY) });
    const { s, marks } = store([old, task(2, "לקנות חלב")]);
    expect(await applyCommand({ kind: "done", query: "ברז" }, ctx(), s)).toEqual({
      kind: "done",
      taskId: 1,
    });
    expect(marks).toEqual([{ taskId: 1, status: "done", sourceMessageId: 500 }]);
  });

  it("never guesses: an ambiguous query changes nothing", async () => {
    const { s, marks } = store([task(1, "לקנות חלב"), task(2, "לקנות לחם")]);
    expect(await applyCommand({ kind: "done", query: "לקנות" }, ctx(), s)).toEqual({
      kind: "done_ambiguous",
      candidates: 2,
    });
    expect(marks).toEqual([]);
  });

  it("an exact title beats a containing one", async () => {
    const { s } = store([task(1, "חלב"), task(2, "חלב סויה")]);
    expect(await applyCommand({ kind: "done", query: "חלב" }, ctx(), s)).toEqual({
      kind: "done",
      taskId: 1,
    });
  });

  it("quoting a task's source message narrows the match to that message", async () => {
    const a = task(1, "לקנות חלב", { sourceMessageId: 77 });
    const b = task(2, "לקנות חלב", { sourceMessageId: 88, sourceItemIndex: 0 });
    const { s } = store([a, b]);
    expect(
      await applyCommand({ kind: "done", query: "" }, ctx({ quotedMessageId: 88 }), s),
    ).toEqual({
      kind: "done",
      taskId: 2,
    });
  });

  it("reports a done the store refused (a task closed or opened by hand) as refused", async () => {
    const { s, marks } = store([task(1, "לתקן ברז", { statusSource: "manual" })]);
    s.markStatus = async (input) => {
      marks.push(input);
      return { found: true, applied: false, previous: "open", current: "open" };
    };
    expect(await applyCommand({ kind: "done", query: "ברז" }, ctx(), s)).toEqual({
      kind: "done_refused",
      taskId: 1,
    });
    expect(marks).toHaveLength(1); // still recorded, so the act is on the record
  });

  it("an empty query without a quote matches nothing; a done task is not live", async () => {
    const { s } = store([task(1, "לקנות חלב", { status: "done" })]);
    expect(await applyCommand({ kind: "done", query: "" }, ctx(), s)).toEqual({
      kind: "done_no_match",
    });
    expect(await applyCommand({ kind: "done", query: "חלב" }, ctx(), s)).toEqual({
      kind: "done_no_match",
    });
  });
});
