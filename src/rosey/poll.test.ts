import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import type { RoseyTask, StatusEventResult } from "../db/repositories/rosey-tasks.js";
import {
  applyPollVote,
  buildListPolls,
  GROCERY_POLL_NAME,
  MAX_OPTION_CHARS,
  MAX_POLL_OPTIONS,
  POLL_POST_LIMITS,
  type PollReplyDeps,
  type PollVoteStore,
  PollVotes,
  replyWithPolls,
  TASKS_POLL_NAME,
} from "./poll.js";

const NOW = new Date("2026-11-22T10:00:00Z").getTime();
const JID = "123@g.us";

function task(id: number, title: string, over: Partial<RoseyTask> = {}): RoseyTask {
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
    raisedAt: new Date(NOW - 86_400_000 + id),
    ...over,
  };
}

// ── The payloads ──────────────────────────────────────────────────────────────

describe("buildListPolls", () => {
  it("one checklist of open tasks and one of open groceries; suggestions and closed items stay out", () => {
    const polls = buildListPolls([
      task(2, "לתקן ברז"),
      task(1, "לקבוע תור"),
      task(3, "חלב", { kind: "grocery" }),
      task(4, "הצעה", { status: "suggested", origin: "suggested" }),
      task(5, "נסגר", { status: "done" }),
    ]);
    expect(polls).toEqual([
      { name: TASKS_POLL_NAME, options: ["לקבוע תור", "לתקן ברז"], taskIds: [1, 2], kind: "task" },
      { name: GROCERY_POLL_NAME, options: ["חלב"], taskIds: [3], kind: "grocery" },
    ]);
  });

  it("splits past WhatsApp's 12 options, numbering the parts", () => {
    const many = Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => task(i + 1, `משימה ${i}`));
    const polls = buildListPolls(many);
    expect(polls.map((p) => [p.name, p.options.length])).toEqual([
      [`${TASKS_POLL_NAME} (1/2)`, MAX_POLL_OPTIONS],
      [`${TASKS_POLL_NAME} (2/2)`, 1],
    ]);
    expect(polls.flatMap((p) => p.taskIds)).toEqual(many.map((t) => t.id));
  });

  it("keeps options distinct, one line, tag-free and short", () => {
    const polls = buildListPolls([
      task(1, "חלב"),
      task(2, "חלב"),
      task(3, "@Rosey לשלם\nחשבון"),
      task(4, "א".repeat(300)),
    ]);
    const [a, b, c, d] = polls[0]!.options;
    expect([a, b, c]).toEqual(["חלב", "חלב (2)", "Rosey לשלם חשבון"]);
    expect(d).toHaveLength(MAX_OPTION_CHARS);
  });

  it("is empty when nothing is open", () => {
    expect(buildListPolls([task(1, "x", { status: "done" })])).toEqual([]);
  });
});

// ── The gate ─────────────────────────────────────────────────────────────────

function harness(over: Partial<PollReplyDeps> = {}, live = [task(1, "לתקן ברז")]) {
  const events: string[] = [];
  const recorded: Array<{
    externalId: string;
    taskIds: number[];
    options: string[];
    secret: Uint8Array;
  }> = [];
  let ids = 0;
  let posts = 0;
  const deps: PollReplyDeps = {
    mode: "live",
    resolveEnabledJids: async () => new Set([JID]),
    countPollsSince: async () => posts,
    loadLive: async () => live,
    record: async (_g, poll) => {
      events.push(`record:${poll.externalId}`);
      recorded.push(poll);
      posts++;
    },
    newMessageId: () => `POLL-${++ids}`,
    newSecret: () => new Uint8Array(32).fill(ids),
    sendTimeoutMs: 1_000,
    sender: {
      sendPoll: async (jid, poll, opts) => {
        events.push(`send:${opts.messageId}:${poll.selectableCount}`);
        expect(jid).toBe(JID);
        expect(opts.messageSecret).toBe(recorded.at(-1)?.secret);
        return undefined;
      },
    },
    now: () => NOW,
    ...over,
  };
  const req = { jid: JID, groupId: 1, quoted: { key: { id: "REQ" } } as WAMessage };
  return { deps, req, events, recorded, setPosts: (n: number) => (posts = n) };
}

describe("replyWithPolls", () => {
  it("records each poll with its options and secret BEFORE it leaves, as a multi-select", async () => {
    const live = [task(1, "א"), task(2, "ב"), task(3, "חלב", { kind: "grocery" })];
    const h = harness({}, live);
    expect(await replyWithPolls(h.deps, h.req)).toEqual({
      kind: "polls_sent",
      externalIds: ["POLL-1", "POLL-2"],
    });
    expect(h.events).toEqual(["record:POLL-1", "send:POLL-1:0", "record:POLL-2", "send:POLL-2:0"]);
    expect(h.recorded.map((r) => r.taskIds)).toEqual([[1, 2], [3]]);
    // The option texts as sent: a vote names its options by their hash.
    expect(h.recorded.map((r) => r.options)).toEqual([["א", "ב"], ["חלב"]]);
  });

  it("off sends nothing; a group off her list gets nothing; a failed allowlist read blocks", async () => {
    for (const [over, reason] of [
      [{ mode: "off" }, "off"],
      [{ resolveEnabledJids: async () => new Set<string>() }, "not_enabled"],
      [
        {
          resolveEnabledJids: async () => {
            throw new Error("db down");
          },
        },
        "allowlist_error",
      ],
    ] as const) {
      const h = harness(over as Partial<PollReplyDeps>);
      expect(await replyWithPolls(h.deps, h.req)).toEqual({ kind: "skipped", reason });
      expect(h.events).toEqual([]);
    }
  });

  it("never half a list: one that would cross the hourly cap is not sent at all", async () => {
    const live = Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => task(i + 1, `m${i}`));
    const h = harness({}, live);
    h.setPosts(POLL_POST_LIMITS[0]!.max - 1); // room for one post, the list needs two
    expect(await replyWithPolls(h.deps, h.req)).toEqual({
      kind: "skipped",
      reason: "rate_limited",
    });
    expect(h.events).toEqual([]);
  });

  it("says nothing is open instead of posting an empty poll", async () => {
    const h = harness({}, []);
    expect(await replyWithPolls(h.deps, h.req)).toEqual({
      kind: "skipped",
      reason: "nothing_open",
    });
  });

  it("a record that fails sends nothing", async () => {
    const h = harness({
      record: async () => {
        throw new Error("db down");
      },
    });
    expect(await replyWithPolls(h.deps, h.req)).toEqual({ kind: "failed" });
    expect(h.events).toEqual([]);
  });

  it("dry-run records and sends nothing", async () => {
    const h = harness({ mode: "dry-run" });
    expect((await replyWithPolls(h.deps, h.req)).kind).toBe("dry_run");
    expect(h.events).toEqual([]);
  });

  it("a send that never settles times out with its record kept", async () => {
    const h = harness({
      sendTimeoutMs: 10,
      sender: { sendPoll: () => new Promise(() => {}) },
    });
    expect(await replyWithPolls(h.deps, h.req)).toEqual({ kind: "timed_out" });
    expect(h.events).toEqual(["record:POLL-1"]);
  });
});

// ── Votes ─────────────────────────────────────────────────────────────────────

function voteStore(taskIds: (number | null)[] | null) {
  const marks: string[] = [];
  const store: PollVoteStore = {
    pollTaskIds: async () => taskIds,
    markStatus: async ({ taskId, status }): Promise<StatusEventResult> => {
      marks.push(`${taskId}:${status}`);
      return { found: true, applied: true, previous: "open", current: status };
    },
  };
  return { store, marks };
}

describe("applyPollVote", () => {
  const vote = (voter: string, selected: number[]) => ({
    groupId: 1,
    pollId: "P",
    voter,
    selected,
  });

  it("a tick marks its task done; un-ticking reopens it", async () => {
    const { store, marks } = voteStore([10, 11]);
    const votes = new PollVotes();
    await applyPollVote(store, votes, vote("dana", [1]));
    expect(marks).toEqual(["11:done"]);
    await applyPollVote(store, votes, vote("dana", []));
    expect(marks).toEqual(["11:done", "11:open"]);
  });

  it("acts only on what changed: a second voter on a ticked option adds nothing", async () => {
    const { store, marks } = voteStore([10, 11]);
    const votes = new PollVotes();
    await applyPollVote(store, votes, vote("dana", [0]));
    await applyPollVote(store, votes, vote("yossi", [0, 1]));
    expect(marks).toEqual(["10:done", "11:done"]);
  });

  it("reopens only when the LAST voter un-ticks", async () => {
    const { store, marks } = voteStore([10]);
    const votes = new PollVotes();
    await applyPollVote(store, votes, vote("dana", [0]));
    await applyPollVote(store, votes, vote("yossi", [0]));
    await applyPollVote(store, votes, vote("dana", []));
    expect(marks).toEqual(["10:done"]);
    await applyPollVote(store, votes, vote("yossi", []));
    expect(marks).toEqual(["10:done", "10:open"]);
  });

  it("ignores options outside the poll and options whose task is gone", async () => {
    const { store, marks } = voteStore([null, 11]);
    const out = await applyPollVote(store, new PollVotes(), vote("dana", [0, 1, 7, -1]));
    expect(marks).toEqual(["11:done"]);
    expect(out.kind).toBe("applied");
  });

  it("a vote whose status write fails is forgotten, so the same vote again retries it", async () => {
    const { store, marks } = voteStore([10]);
    const flaky: PollVoteStore = {
      ...store,
      markStatus: async () => {
        throw new Error("db down");
      },
    };
    const votes = new PollVotes();
    await expect(applyPollVote(flaky, votes, vote("dana", [0]))).rejects.toThrow("db down");
    await applyPollVote(store, votes, vote("dana", [0]));
    expect(marks).toEqual(["10:done"]);
  });

  it("reads one voter's current selection back", async () => {
    const { store } = voteStore([10, 11]);
    const votes = new PollVotes();
    expect([...votes.selection("P", "dana")]).toEqual([]);
    await applyPollVote(store, votes, vote("dana", [1, 0]));
    expect([...votes.selection("P", "dana")].sort()).toEqual([0, 1]);
    expect([...votes.selection("P", "yossi")]).toEqual([]);
  });

  it("a poll that is not hers changes nothing", async () => {
    const { store, marks } = voteStore(null);
    expect(await applyPollVote(store, new PollVotes(), vote("dana", [0]))).toEqual({
      kind: "unknown_poll",
    });
    expect(marks).toEqual([]);
  });
});
