import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { matchAskTrigger } from "../collector/ask-trigger.js";
import type { RoseyTask } from "../db/repositories/rosey-tasks.js";
import {
  guardAllowlist,
  LIST_REPLY_LIMITS,
  type ListReplyDeps,
  type ListSnapshot,
  MAX_ITEMS_PER_GROUP,
  MAX_REPLY_CHARS,
  parseSendMode,
  renderListReply,
  replyWithList,
} from "./reply.js";

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

const SNAPSHOT: ListSnapshot = {
  live: [
    task(1, "לתקן ברז"),
    task(2, "להזמין אינסטלטור", { status: "suggested", origin: "suggested" }),
    task(3, "חלב", { kind: "grocery" }),
  ],
  doneRecently: [task(4, "לקבוע אורתופד", { status: "done" })],
};

// ── The gate ─────────────────────────────────────────────────────────────────

/** Probes for every side effect: what was sent, recorded and logged. */
function harness(over: Partial<ListReplyDeps> = {}) {
  const sent: Array<{ jid: string; text: string }> = [];
  const recorded: Array<{ groupId: number; externalId: string }> = [];
  const infos: Array<{ obj: unknown; msg?: string }> = [];
  let replies = 0;
  const deps: ListReplyDeps = {
    mode: "live",
    resolveEnabledJids: async () => new Set([JID]),
    countRepliesSince: async () => replies,
    loadList: async () => SNAPSHOT,
    record: async (groupId, externalId) => {
      recorded.push({ groupId, externalId });
      replies++;
    },
    sender: {
      sendText: async (jid, text) => {
        sent.push({ jid, text });
        return { key: { id: `OUT-${sent.length}` } } as WAMessage;
      },
    },
    now: () => NOW,
    log: { info: (obj, msg) => infos.push({ obj, msg }), warn: () => {}, error: () => {} },
    ...over,
  };
  const req = { jid: JID, groupId: 1, quoted: {} as WAMessage };
  return { deps, req, sent, recorded, infos };
}

describe("replyWithList — the send gate", () => {
  it("live, allowlisted, under the limit: sends one reply and records it", async () => {
    const h = harness();
    expect(await replyWithList(h.deps, h.req)).toEqual({ kind: "sent", externalId: "OUT-1" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.jid).toBe(JID);
    expect(h.recorded).toEqual([{ groupId: 1, externalId: "OUT-1" }]);
  });

  it("off (the default) sends nothing and reads nothing", async () => {
    let read = false;
    const h = harness({
      mode: "off",
      loadList: async () => {
        read = true;
        return SNAPSHOT;
      },
    });
    expect(await replyWithList(h.deps, h.req)).toEqual({ kind: "skipped", reason: "off" });
    expect(h.sent).toEqual([]);
    expect(read).toBe(false);
  });

  it("dry-run logs the exact text and sends and records nothing", async () => {
    const h = harness({ mode: "dry-run" });
    const out = await replyWithList(h.deps, h.req);
    expect(out).toMatchObject({ kind: "dry_run" });
    expect(h.sent).toEqual([]);
    expect(h.recorded).toEqual([]);
    const logged = h.infos.find((l) => l.msg?.includes("dry-run"));
    expect(logged?.obj).toMatchObject({ groupId: 1, text: renderListReply(SNAPSHOT) });
  });

  it("a group not on Rosey's allowlist gets nothing, even in live mode", async () => {
    const h = harness({ resolveEnabledJids: async () => new Set(["other@g.us"]) });
    expect(await replyWithList(h.deps, h.req)).toEqual({ kind: "skipped", reason: "not_enabled" });
    expect(h.sent).toEqual([]);
  });

  it("an allowlist read that fails blocks the send (fail closed)", async () => {
    const h = harness({
      resolveEnabledJids: async () => {
        throw new Error("db down");
      },
    });
    expect(await replyWithList(h.deps, h.req)).toEqual({
      kind: "skipped",
      reason: "allowlist_error",
    });
    expect(h.sent).toEqual([]);
  });

  it("never replies into a 1:1 chat, even one on the list", async () => {
    const h = harness({ resolveEnabledJids: async () => new Set(["972500000000@s.whatsapp.net"]) });
    const out = await replyWithList(h.deps, { ...h.req, jid: "972500000000@s.whatsapp.net" });
    expect(out).toEqual({ kind: "skipped", reason: "not_a_group" });
    expect(h.sent).toEqual([]);
  });

  it("holds the rate limit: the reply past the hourly cap is dropped, not queued", async () => {
    const h = harness();
    const hourly = LIST_REPLY_LIMITS[0]!;
    for (let i = 0; i < hourly.max; i++) {
      expect(await replyWithList(h.deps, h.req)).toMatchObject({ kind: "sent" });
    }
    expect(await replyWithList(h.deps, h.req)).toEqual({
      kind: "skipped",
      reason: "rate_limited",
    });
    expect(h.sent).toHaveLength(hourly.max);
  });

  it("each window counts from its own start", async () => {
    const asked: number[] = [];
    const h = harness({
      countRepliesSince: async (_g, since) => {
        asked.push(NOW - since.getTime());
        return 0;
      },
    });
    await replyWithList(h.deps, h.req);
    expect(asked).toEqual(LIST_REPLY_LIMITS.map((l) => l.windowMs));
  });

  it("the daily cap holds even when the last hour is quiet", async () => {
    const daily = LIST_REPLY_LIMITS[1]!;
    const h = harness({
      countRepliesSince: async (_g, since) =>
        NOW - since.getTime() > LIST_REPLY_LIMITS[0]!.windowMs ? daily.max : 0,
    });
    expect(await replyWithList(h.deps, h.req)).toEqual({
      kind: "skipped",
      reason: "rate_limited",
    });
    expect(h.sent).toEqual([]);
  });

  it("refuses to send text that could wake a bot", async () => {
    const h = harness({
      loadList: async () => ({ live: [task(1, "x")], doneRecently: [] }),
    });
    // A renderer bug that let a tag through must still never reach the chat.
    const unsafe = await replyWithList({ ...h.deps, render: () => "🤖 רוזי\n@Aida hi" }, h.req);
    expect(unsafe).toEqual({ kind: "skipped", reason: "unsafe_text" });
    expect(h.sent).toEqual([]);
  });

  it("a failed send is reported, and nothing is recorded", async () => {
    const h = harness({
      sender: {
        sendText: async () => {
          throw new Error("Outbound WhatsApp send blocked");
        },
      },
    });
    expect(await replyWithList(h.deps, h.req)).toEqual({ kind: "failed" });
    expect(h.recorded).toEqual([]);
  });
});

describe("parseSendMode", () => {
  it("is off unless set to exactly dry-run or live", () => {
    expect(parseSendMode(undefined)).toBe("off");
    expect(parseSendMode("")).toBe("off");
    expect(parseSendMode("on")).toBe("off");
    expect(parseSendMode("LIVE")).toBe("off");
    expect(parseSendMode("dry-run")).toBe("dry-run");
    expect(parseSendMode("live")).toBe("live");
  });
});

// ── The reply text ───────────────────────────────────────────────────────────

describe("renderListReply", () => {
  it("is signed, marks done ✅ and not done ⬜, and keeps grocery in its own 🛒 section", () => {
    const text = renderListReply(SNAPSHOT);
    const lines = text.split("\n");
    expect(lines[0]).toBe("🤖 רוזי");
    const grocery = text.indexOf("🛒");
    expect(grocery).toBeGreaterThan(0);
    const tasks = text.slice(0, grocery);
    expect(tasks).toContain("✅ לקבוע אורתופד");
    expect(tasks).toContain("⬜ לתקן ברז");
    expect(text.slice(grocery)).toContain("⬜ חלב");
    expect(tasks).not.toContain("חלב");
  });

  it("marks unconfirmed suggestions apart from confirmed items", () => {
    const text = renderListReply(SNAPSHOT);
    const head = text.indexOf("💭");
    expect(head).toBeGreaterThan(text.indexOf("⬜ לתקן ברז"));
    expect(text.indexOf("⬜ להזמין אינסטלטור")).toBeGreaterThan(head);
  });

  it("says so when the list is empty", () => {
    expect(renderListReply({ live: [], doneRecently: [] })).toBe("🤖 רוזי\n📋 הרשימה ריקה.");
  });

  it("never carries a tag: an @ in a title is dropped, so neither bot can be woken", () => {
    const text = renderListReply({
      live: [task(1, "לשאול את @Aida"), task(2, "@רוזי משהו"), task(3, "a＠b")],
      doneRecently: [],
    });
    expect(text).not.toMatch(/[@＠]/);
    expect(matchAskTrigger(text)).toBeNull();
  });

  it("stays inside the length limit, and says how many items it left out", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      task(i + 1, `משימה ארוכה ${"א".repeat(150)} ${i}`),
    );
    const text = renderListReply({ live: many, doneRecently: [] });
    expect(text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(text).toMatch(/ועוד \d+/);
  });

  it("caps each group's items and counts the rest", () => {
    const many = Array.from({ length: MAX_ITEMS_PER_GROUP + 5 }, (_, i) => task(i + 1, `t${i}`));
    const text = renderListReply({ live: many, doneRecently: [] });
    expect(text.split("\n").filter((l) => l.startsWith("⬜"))).toHaveLength(MAX_ITEMS_PER_GROUP);
    expect(text).toContain("…ועוד 5");
  });
});

describe("guardAllowlist — the shared outbound guard's union", () => {
  const base = async () => new Set(["summary@g.us"]);
  it("adds Rosey's groups only in live mode", async () => {
    let read = 0;
    const rosey = async () => {
      read++;
      return new Set(["rosey@g.us"]);
    };
    for (const mode of ["off", "dry-run"] as const) {
      expect([...(await guardAllowlist(base, rosey, mode)())]).toEqual(["summary@g.us"]);
    }
    expect(read).toBe(0);
    expect([...(await guardAllowlist(base, rosey, "live")())].sort()).toEqual([
      "rosey@g.us",
      "summary@g.us",
    ]);
  });

  it("a failed read of Rosey's list throws, which blocks the send (the guard fails closed)", async () => {
    const broken = async (): Promise<ReadonlySet<string>> => {
      throw new Error("db down");
    };
    await expect(guardAllowlist(base, broken, "live")()).rejects.toThrow("db down");
  });
});
