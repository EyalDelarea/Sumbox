import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RunSummarizeResult } from "../summarization/summarize.js";
import { GroupTurnQueue } from "./group-turn-queue.js";
import {
  buildWhatsAppReply,
  formatSummaryForWhatsApp,
  maybeHandleSummaryCommand,
  SUMMARY_COMMAND,
  type SummaryCommandDeps,
} from "./summary-command.js";

const JID = "123@g.us";

/** messageTimestamp is in SECONDS; default to "now" so the liveness gate passes. */
function textMsg(
  body: string,
  jid = JID,
  fromMe = false,
  tsSec = Date.now() / 1000,
  pushName?: string,
): WAMessage {
  return {
    key: { id: "m1", remoteJid: jid, fromMe },
    message: { conversation: body },
    messageTimestamp: Math.floor(tsSec),
    pushName,
  } as unknown as WAMessage;
}

function fakePool(opts: {
  group?: { id: number; name: string } | null;
  lastSummaryAt?: Date | null;
}): pg.Pool {
  return {
    query: async (sql: string) => {
      if (/FROM groups/.test(sql)) {
        return {
          rows: opts.group ? [{ id: String(opts.group.id), name: opts.group.name }] : [],
        };
      }
      if (/FROM summaries/.test(sql)) {
        return { rows: opts.lastSummaryAt ? [{ created_at: opts.lastSummaryAt }] : [] };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
}

function okResult(overview: string): RunSummarizeResult {
  return {
    kind: "ok",
    output: { overview } as never,
    summaryId: 1,
    // The reply header reports the window it actually covers.
    coveredFrom: new Date("2026-07-12T20:47:00Z"),
    droppedCount: 0,
  };
}

const SENT = { key: { id: "sent-1", remoteJid: JID } } as unknown as WAMessage;

function defaultMarks(
  over: Partial<SummaryCommandDeps["marks"]> = {},
): SummaryCommandDeps["marks"] {
  return {
    resolveParticipantId: vi.fn(async (name: string) => (name === "Noa" ? 22 : 11)),
    getMark: vi.fn(async () => null),
    setMark: vi.fn(async () => true),
    getSummaryOutput: vi.fn(async () => ({ overview: "prev summary" }) as never),
    ...over,
  };
}

function baseDeps(over: Partial<SummaryCommandDeps> = {}): SummaryCommandDeps {
  return {
    pool: fakePool({ group: { id: 7, name: "בוקר טוב" } }),
    resolveEnabledJids: async () => new Set([JID]),
    resolveTrigger: async () => SUMMARY_COMMAND,
    sendText: vi.fn(async () => SENT),
    react: vi.fn(async () => {}),
    turns: new GroupTurnQueue(),
    lastSummaryByGroup: new Map(),
    marks: defaultMarks(),
    runSummarize: vi.fn(async () => okResult("שלום")),
    ...over,
  };
}

describe("maybeHandleSummaryCommand — dispatch", () => {
  it("ignores a non-command message", async () => {
    const deps = baseDeps();
    expect(await maybeHandleSummaryCommand(textMsg("just chatting"), deps)).toBe(false);
    expect(deps.sendText).not.toHaveBeenCalled();
  });

  it("matches the resolved trigger, not the shipped default", async () => {
    const deps = baseDeps({ resolveTrigger: async () => "/סכם" });
    expect(await maybeHandleSummaryCommand(textMsg("/סכם"), deps)).toBe(true);
  });

  it("ignores the old default once the trigger has been changed", async () => {
    const sendText = vi.fn();
    const deps = baseDeps({ resolveTrigger: async () => "/סכם", sendText });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("fires on the trigger WITH trailing text, ignoring the extra words", async () => {
    // Exact equality made "/סיכום <anything>" a silent no-op: members typed it
    // repeatedly and got nothing at all. The trailing text is ignored rather
    // than read as a topic — that would be a feature, this is the bug fix.
    for (const text of ["/סיכום אוהבים אותך", "/סיכום HELP SOS CALL 911"]) {
      const deps = baseDeps({});
      expect(await maybeHandleSummaryCommand(textMsg(text), deps)).toBe(true);
      expect(deps.sendText).toHaveBeenCalled();
    }
  });

  it("does NOT fire on a longer word that merely starts with the trigger", async () => {
    // "/סיכוםX" is a different word, not the command with an argument.
    const deps = baseDeps({});
    expect(await maybeHandleSummaryCommand(textMsg("/סיכוםX"), deps)).toBe(false);
    expect(deps.sendText).not.toHaveBeenCalled();
  });

  it("ignores the command from an unlisted group", async () => {
    const deps = baseDeps({ resolveEnabledJids: async () => new Set(["other@g.us"]) });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(deps.sendText).not.toHaveBeenCalled();
  });

  it("ignores ordinary chatter without ever calling the DB resolvers (cheap pre-gate)", async () => {
    const resolveEnabledJids = vi.fn(async () => new Set([JID]));
    const resolveTrigger = vi.fn(async () => SUMMARY_COMMAND);
    const deps = baseDeps({ resolveEnabledJids, resolveTrigger });
    expect(await maybeHandleSummaryCommand(textMsg("just chatting, no slash"), deps)).toBe(false);
    expect(resolveEnabledJids).not.toHaveBeenCalled();
    expect(resolveTrigger).not.toHaveBeenCalled();
  });

  it("fails CLOSED (no send) when resolving permissions from the DB throws", async () => {
    const sendText = vi.fn();
    const warn = vi.fn();
    const deps = baseDeps({
      sendText,
      resolveEnabledJids: async () => {
        throw new Error("connection reset");
      },
      log: { info: vi.fn(), warn },
    });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      expect.stringMatching(/permission/i),
    );
  });

  it("toggle-off is immediate: resolveEnabledJids dropping the JID on the 2nd call is a no-op, even though the 1st sent", async () => {
    let enabled = new Set([JID]);
    const resolveEnabledJids = vi.fn(async () => enabled);
    const sendText = vi.fn(async () => SENT);
    const deps = baseDeps({ resolveEnabledJids, sendText });

    // 1st /סיכום — group is enabled, sends normally.
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();

    // Toggle the group off in the DB (simulated: the next resolver call returns
    // a set WITHOUT the group's JID — no in-memory cache to reload).
    enabled = new Set();

    // 2nd /סיכום — same deps object, no restart, no reload call in between.
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(sendText).toHaveBeenCalledOnce(); // still just the one send from before
  });

  it("triggers on the command from the device owner (fromMe) — the primary user", async () => {
    const deps = baseDeps();
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND, JID, true), deps)).toBe(true);
    expect(deps.sendText).toHaveBeenCalledOnce();
  });

  it("ignores a stale (replayed/history) command message", async () => {
    const deps = baseDeps();
    // A /סיכום from 10 minutes ago — as replayed on reconnect / first history sync.
    const oldMsg = textMsg(SUMMARY_COMMAND, JID, false, Date.now() / 1000 - 600);
    expect(await maybeHandleSummaryCommand(oldMsg, deps)).toBe(false);
    expect(deps.sendText).not.toHaveBeenCalled();
  });

  it("tolerates surrounding whitespace in the command", async () => {
    const deps = baseDeps();
    expect(await maybeHandleSummaryCommand(textMsg(`  ${SUMMARY_COMMAND}  `), deps)).toBe(true);
    expect(deps.sendText).toHaveBeenCalledOnce();
  });

  it("canonicalizes a 1:1 @lid chat to its phone JID before matching the whitelist", async () => {
    // Live 1:1 messages arrive as @lid; the whitelist/group store @s.whatsapp.net.
    const PN = "972525201058@s.whatsapp.net";
    const resolvePn = vi.fn(async () => PN);
    const send = vi.fn(async () => SENT);
    const deps = baseDeps({
      resolveEnabledJids: async () => new Set([PN]),
      pool: fakePool({ group: { id: 9, name: "גיא" } }),
      resolvePn,
      sendText: send,
    });
    const lidMsg = textMsg(SUMMARY_COMMAND, "44444444444@lid", true);
    expect(await maybeHandleSummaryCommand(lidMsg, deps)).toBe(true);
    expect(resolvePn).toHaveBeenCalledWith("44444444444@lid");
    // Reply goes to the canonical phone JID (the guard-allowlisted one), not @lid.
    expect(send.mock.calls[0]![0]).toBe(PN);
  });

  it("returns false when the group JID is unknown to the DB", async () => {
    const deps = baseDeps({ pool: fakePool({ group: null }) });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(deps.sendText).not.toHaveBeenCalled();
  });
});

describe("maybeHandleSummaryCommand — range anchoring", () => {
  it("anchors on the group's shared marker when one exists", async () => {
    const anchor = new Date("2026-07-06T08:00:00Z");
    const run = vi.fn(async () => okResult("hi"));
    const deps = baseDeps({
      marks: defaultMarks({
        getMark: vi.fn(async () => ({
          lastSummarizedAt: anchor,
          lastSummaryId: 5,
          lastReplyWaMessageId: "wa-5",
        })),
      }),
      runSummarize: run,
    });
    await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    expect(run).toHaveBeenCalledWith({
      groupId: 7,
      selection: { since: anchor },
      requesterId: expect.any(Number),
    });
  });

  it("ignores a prior summary when there is no marker — the digest can't move the window", async () => {
    // The scheduled digest also writes `summaries` rows. Anchoring on them would
    // let a 9am digest silently shrink the next manual window, so the command
    // never reads that table: no marker means a last-N window, full stop.
    const run = vi.fn(async () => okResult("hi"));
    const deps = baseDeps({
      pool: fakePool({
        group: { id: 7, name: "g" },
        lastSummaryAt: new Date("2026-07-06T08:00:00Z"),
      }),
      runSummarize: run,
    });
    await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    expect(run).toHaveBeenCalledWith({
      groupId: 7,
      selection: { last: 50 },
      requesterId: expect.any(Number),
    });
  });

  it("falls back to a last-N window when the group has no marker at all", async () => {
    const run = vi.fn(async () => okResult("hi"));
    const deps = baseDeps({
      pool: fakePool({ group: { id: 7, name: "g" }, lastSummaryAt: null }),
      runSummarize: run,
    });
    await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    expect(run).toHaveBeenCalledWith({
      groupId: 7,
      selection: { last: 50 },
      requesterId: expect.any(Number),
    });
  });
});

describe("maybeHandleSummaryCommand — reply content", () => {
  it("emits fixed emoji headers for each populated section of a structured summary", async () => {
    const send = vi.fn(async () => {});
    const structured = {
      version: 2 as const,
      overview: "raw md",
      tldr: "תקציר קצר",
      topics: [{ text: "נושא א" }],
      decisions: [{ text: "החלטה חשובה" }],
      openQuestions: [{ text: "שאלה פתוחה?" }],
      actionItems: [],
    };
    const deps = baseDeps({
      runSummarize: vi.fn(async () => ({
        kind: "ok" as const,
        output: structured,
        summaryId: 1,
        coveredFrom: new Date("2026-07-12T20:47:00Z"),
        droppedCount: 0,
      })),
      sendText: send,
    });
    await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    const [, text] = send.mock.calls[0]!;
    expect(text).toContain("📝 *תקציר*");
    expect(text).toContain("תקציר קצר");
    expect(text).toContain("📌 *נושאים עיקריים*");
    expect(text).toContain("• נושא א");
    expect(text).toContain("✅ *החלטות ומשימות*");
    expect(text).toContain("• החלטה חשובה");
    expect(text).toContain("❓ *שאלות פתוחות*");
    expect(text).toContain("• שאלה פתוחה?");
  });

  it("always emits the תקציר emoji even for a short headingless summary", async () => {
    const send = vi.fn(async () => {});
    // The local model often returns bare prose with no ## headings (the case
    // that came out emoji-less before the normalized-section reply builder).
    const deps = baseDeps({
      runSummarize: vi.fn(async () => okResult("בוקר טוב, אין הרבה חדש היום.")),
      sendText: send,
    });
    await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    const [, text] = send.mock.calls[0]!;
    expect(text).toContain("📝 *תקציר*");
    expect(text).toContain("בוקר טוב");
  });

  it("sends a Hebrew 'nothing new' reply when there is nothing to summarize", async () => {
    const send = vi.fn(async () => {});
    const deps = baseDeps({
      runSummarize: vi.fn(async () => ({ kind: "empty" }) as RunSummarizeResult),
      sendText: send,
    });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(true);
    expect(send.mock.calls[0]![1]).toMatch(/אין הודעות חדשות/);
  });

  it("sends an error reply (not silent) when generation fails", async () => {
    const send = vi.fn(async () => SENT);
    const deps = baseDeps({
      sendText: send,
      runSummarize: vi.fn(async () => {
        throw new Error("ollama timeout");
      }),
    });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toMatch(/לא הצלחתי|נסו שוב/);
  });
});

describe("maybeHandleSummaryCommand — turn queue", () => {
  const groupId = 7;

  /** Poll until `cond` holds — the handler awaits several times before it
   *  reaches the queue, so a fixed tick count can't observe "now queued". */
  async function waitUntil(cond: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error(`waitUntil timed out: ${label}`);
  }

  it("waits its turn and runs when the in-flight summary finishes", async () => {
    const turns = new GroupTurnQueue();
    await turns.take(groupId);
    const react = vi.fn(async () => {});
    const deps = baseDeps({ turns, react });

    const pending = maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    await waitUntil(() => react.mock.calls.length > 0, "queued ack");
    expect(deps.sendText).not.toHaveBeenCalled(); // waiting, not dropped
    expect(react).toHaveBeenCalledWith(JID, expect.anything(), "⏳");

    turns.release(groupId);
    expect(await pending).toBe(true);
    expect(deps.sendText).toHaveBeenCalled();
  });

  it("acks ⏸ when someone is already waiting — the queue is one deep", async () => {
    const turns = new GroupTurnQueue();
    await turns.take(groupId);
    const waiter = turns.take(groupId);
    await Promise.resolve();

    const react = vi.fn(async () => {});
    const deps = baseDeps({ turns, react });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(react).toHaveBeenCalledWith(JID, expect.anything(), "⏸");
    expect(deps.sendText).not.toHaveBeenCalled();

    turns.release(groupId);
    await waiter;
  });

  it("drops a queued command that outlived the TTL", async () => {
    let clock = 0;
    const turns = new GroupTurnQueue({ ttlMs: 1000, now: () => clock });
    await turns.take(groupId);
    const react = vi.fn(async () => {});
    const deps = baseDeps({ turns, react });

    const pending = maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    await waitUntil(() => react.mock.calls.length > 0, "queued ack");
    clock = 5000;
    turns.release(groupId);

    expect(await pending).toBe(false);
    expect(deps.sendText).not.toHaveBeenCalled();
    expect(react).toHaveBeenCalledWith(JID, expect.anything(), "⏸");
  });

  it("releases the turn after completion so a later command runs", async () => {
    const turns = new GroupTurnQueue();
    const deps = baseDeps({ turns });
    await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(true);
  });

  it("releases the turn even when generation throws", async () => {
    const turns = new GroupTurnQueue();
    const deps = baseDeps({
      turns,
      runSummarize: vi.fn(async () => {
        throw new Error("ollama down");
      }),
    });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(await turns.take(groupId)).toBe("acquired");
  });
});

describe("maybeHandleSummaryCommand — reactions", () => {
  it("reacts ⏳ while working then ✅ when done", async () => {
    const react = vi.fn(async () => {});
    const msg = textMsg(SUMMARY_COMMAND);
    await maybeHandleSummaryCommand(msg, baseDeps({ react }));
    expect(react).toHaveBeenNthCalledWith(1, JID, msg.key, "⏳");
    expect(react).toHaveBeenNthCalledWith(2, JID, msg.key, "✅");
  });

  it("reacts ❌ when generation fails", async () => {
    const react = vi.fn(async () => {});
    await maybeHandleSummaryCommand(
      textMsg(SUMMARY_COMMAND),
      baseDeps({
        react,
        runSummarize: vi.fn(async () => {
          throw new Error("ollama down");
        }),
      }),
    );
    expect(react).toHaveBeenNthCalledWith(1, JID, expect.anything(), "⏳");
    expect(react).toHaveBeenLastCalledWith(JID, expect.anything(), "❌");
  });

  it("still replies when reactions are unavailable (react omitted)", async () => {
    const send = vi.fn(async () => SENT);
    const deps = baseDeps({ react: undefined, sendText: send });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("maybeHandleSummaryCommand — the shared group marker", () => {
  const now = () => Date.parse("2026-07-06T21:00:00Z");
  const danaMsg = () =>
    textMsg(SUMMARY_COMMAND, JID, false, Date.parse("2026-07-06T21:00:00Z") / 1000, "Dana Cohen");
  const noaMsg = () =>
    textMsg(SUMMARY_COMMAND, JID, false, Date.parse("2026-07-06T21:00:00Z") / 1000, "Noa");

  function makeMarks(over: Record<string, unknown> = {}) {
    return {
      resolveParticipantId: vi.fn(async (name: string) => (name === "Dana Cohen" ? 11 : 22)),
      getMark: vi.fn(async () => null),
      setMark: vi.fn(async () => true),
      getSummaryOutput: vi.fn(async () => ({ overview: "prev summary" }) as never),
      ...over,
    } as never;
  }

  it("a first command in the group records the shared marker, keyed by group alone", async () => {
    const run = vi.fn(async () => okResult("hi"));
    const marks = makeMarks();
    const deps = baseDeps({
      pool: fakePool({ group: { id: 7, name: "g" } }),
      runSummarize: run,
      marks,
      lastSummaryByGroup: new Map(),
    });
    await maybeHandleSummaryCommand(danaMsg(), deps, now);
    expect(run).toHaveBeenCalledWith({
      groupId: 7,
      selection: { last: 50 },
      // The asker still identifies the summary row for adoption metrics — it just
      // no longer keys the window.
      requesterId: 11,
    });
    expect(marks.setMark).toHaveBeenCalledWith({
      groupId: 7,
      lastSummarizedAt: new Date("2026-07-06T21:00:00Z"),
      lastSummaryId: 1,
      lastReplyWaMessageId: "sent-1",
    });
    // The marker is per-group; a participant id would reintroduce private windows.
    expect(marks.setMark.mock.calls[0]![0]).not.toHaveProperty("participantId");
  });

  it("every asker anchors on the SHARED marker, not on their own history", async () => {
    const shared = new Date("2026-07-06T20:00:00Z");
    const run = vi.fn(async () => okResult("hi"));
    // Noa has never asked here; under per-user marks she'd have gotten a far
    // wider window. The marker is the group's, so she gets exactly Dana's.
    const marks = makeMarks({
      getMark: vi.fn(async () => ({
        lastSummarizedAt: shared,
        lastSummaryId: 5,
        lastReplyWaMessageId: "wa-5",
      })),
    });
    const deps = baseDeps({
      pool: fakePool({
        group: { id: 7, name: "g" },
        lastSummaryAt: new Date("2026-07-06T08:00:00Z"),
      }),
      runSummarize: run,
      marks,
      lastSummaryByGroup: new Map(),
    });
    await maybeHandleSummaryCommand(noaMsg(), deps, now);
    expect(run).toHaveBeenCalledWith({
      groupId: 7,
      selection: { since: shared },
      requesterId: 22,
    });
    // getMark takes the group alone — there is no per-participant lookup left.
    expect(marks.getMark).toHaveBeenCalledWith(7);
  });

  it("a second asker right after the first gets the empty reply — one shared window", async () => {
    // This is the whole point: the conversation is summarized once, not once per
    // participant. The second command in quick succession has nothing new to say.
    const send = vi.fn(async () => SENT);
    const setMark = vi.fn(async () => true);
    const marks = makeMarks({
      getMark: vi.fn(async () => ({
        lastSummarizedAt: new Date("2026-07-06T20:00:00Z"),
        lastSummaryId: 5,
        lastReplyWaMessageId: "wa-5",
      })),
      setMark,
    });
    const deps = baseDeps({
      pool: fakePool({ group: { id: 7, name: "g" } }),
      sendText: send,
      runSummarize: vi.fn(async () => ({ kind: "empty" }) as RunSummarizeResult),
      marks,
      lastSummaryByGroup: new Map(),
    });
    await maybeHandleSummaryCommand(noaMsg(), deps, now);
    expect(send.mock.calls[0]![1]).toMatch(/אין הודעות חדשות/);
    // An empty reply is not a thread anchor and must not move the shared marker.
    expect(setMark).not.toHaveBeenCalled();
  });

  it("a group with no marker quotes the /סיכום request", async () => {
    const send = vi.fn(async () => SENT);
    const msg = danaMsg();
    const deps = baseDeps({
      sendText: send,
      marks: makeMarks(), // getMark → null
      lastSummaryByGroup: new Map(),
      pool: fakePool({ group: { id: 7, name: "g" } }),
    });
    await maybeHandleSummaryCommand(msg, deps, now);
    expect(send.mock.calls[0]![2]).toEqual({ quoted: msg });
  });

  it("quotes the GROUP's previous summary (reconstructed from the shared marker)", async () => {
    const RECON = { key: { id: "recon" } } as unknown as WAMessage;
    const send = vi.fn(async () => SENT);
    const makeQuoted = vi.fn(() => RECON);
    const marks = makeMarks({
      getMark: vi.fn(async () => ({
        lastSummarizedAt: new Date("2026-07-06T20:00:00Z"),
        lastSummaryId: 5,
        lastReplyWaMessageId: "wa-5",
      })),
    });
    // Noa asks, but the quote chains the summary the GROUP last received.
    const deps = baseDeps({ sendText: send, makeQuoted, marks, lastSummaryByGroup: new Map() });
    await maybeHandleSummaryCommand(noaMsg(), deps, now);
    expect(marks.getSummaryOutput).toHaveBeenCalledWith(5);
    expect(makeQuoted).toHaveBeenCalledWith(JID, "wa-5", expect.stringContaining("prev summary"));
    expect(send.mock.calls[0]![2]).toEqual({ quoted: RECON });
  });

  it("two different askers write to the same marker — no per-participant divergence", async () => {
    const setMark = vi.fn(async () => true);
    const marks = makeMarks({ setMark });
    const deps = baseDeps({
      pool: fakePool({ group: { id: 7, name: "g" } }),
      marks,
      lastSummaryByGroup: new Map(),
    });
    await maybeHandleSummaryCommand(danaMsg(), deps, now);
    await maybeHandleSummaryCommand(noaMsg(), deps, now);
    expect(setMark.mock.calls[0]![0]).toMatchObject({ groupId: 7 });
    expect(setMark.mock.calls[1]![0]).toMatchObject({ groupId: 7 });
    // Same target row both times — under per-user marks these diverged (11 vs 22).
    expect(setMark.mock.calls[0]![0]).toEqual(setMark.mock.calls[1]![0]);
  });

  it("ignores a FUTURE-dated command, so one skewed clock can't soft-lock the group", async () => {
    // sentAt is the sender's device clock, unvalidated, and it becomes the shared
    // cursor. A far-future value would leave every later /סיכום in the group
    // matching nothing. The liveness gate used to be one-sided — `now - sentAt`
    // is NEGATIVE for a future message, so it sailed through.
    const send = vi.fn(async () => SENT);
    const deps = baseDeps({ sendText: send, marks: makeMarks() });
    const future = textMsg(SUMMARY_COMMAND, JID, false, Date.now() / 1000 + 3600);
    expect(await maybeHandleSummaryCommand(future, deps)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the delivered summary when the cursor write fails — no contradictory error reply", async () => {
    // The send already succeeded. Falling through to the generic handler would
    // post "לא הצלחתי להכין סיכום" directly beneath a perfectly good summary.
    const send = vi.fn(async () => SENT);
    const warn = vi.fn();
    const marks = makeMarks({
      setMark: vi.fn(async () => {
        throw new Error("pool exhausted");
      }),
    });
    const cache = new Map<number, WAMessage>();
    const deps = baseDeps({
      sendText: send,
      marks,
      lastSummaryByGroup: cache,
      log: { info: vi.fn(), warn },
    });
    expect(await maybeHandleSummaryCommand(danaMsg(), deps, now)).toBe(true);
    // Exactly one message: the summary. No ERROR_REPLY chaser.
    expect(send).toHaveBeenCalledOnce();
    // The failure is loud in the logs, and names the consequence.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 7 }),
      expect.stringMatching(/cursor did not advance/i),
    );
    // In-memory must not lead the DB: a stale cache would thread the reply off a
    // summary the cursor doesn't know about.
    expect(cache.has(7)).toBe(false);
  });

  it("logs when the send returns no confirmable id instead of skipping the advance silently", async () => {
    const warn = vi.fn();
    const marks = makeMarks();
    const deps = baseDeps({
      sendText: vi.fn(async () => undefined),
      marks,
      log: { info: vi.fn(), warn },
    });
    await maybeHandleSummaryCommand(danaMsg(), deps, now);
    expect(marks.setMark).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 7 }),
      expect.stringMatching(/no confirmable message id/i),
    );
  });

  it("still delivers the summary when the quote rebuild throws — a quote is cosmetic", async () => {
    // getSummaryOutput exists only to rebuild quote TEXT. Letting it throw past
    // the send discards a finished Ollama run over a decoration.
    const send = vi.fn(async () => SENT);
    const msg = danaMsg();
    const marks = makeMarks({
      getMark: vi.fn(async () => ({
        lastSummarizedAt: new Date("2026-07-06T20:00:00Z"),
        lastSummaryId: 5,
        lastReplyWaMessageId: "wa-5",
      })),
      getSummaryOutput: vi.fn(async () => {
        throw new Error("summary row purged");
      }),
    });
    const deps = baseDeps({ sendText: send, makeQuoted: vi.fn(), marks });
    expect(await maybeHandleSummaryCommand(msg, deps, now)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    // Falls back to quoting the request rather than losing the summary.
    expect(send.mock.calls[0]![2]).toEqual({ quoted: msg });
  });

  it("the in-memory quote fast path is keyed by group, so any asker reuses it", async () => {
    const cache = new Map<number, WAMessage>();
    const deps = baseDeps({
      pool: fakePool({ group: { id: 7, name: "g" } }),
      marks: makeMarks(),
      lastSummaryByGroup: cache,
    });
    await maybeHandleSummaryCommand(danaMsg(), deps, now);
    expect(cache.get(7)).toBe(SENT);

    // Noa's command quotes Dana's summary straight from the cache — no rebuild.
    const send = vi.fn(async () => SENT);
    const makeQuoted = vi.fn();
    const deps2 = baseDeps({
      pool: fakePool({ group: { id: 7, name: "g" } }),
      marks: makeMarks(),
      lastSummaryByGroup: cache,
      sendText: send,
      makeQuoted,
    });
    await maybeHandleSummaryCommand(noaMsg(), deps2, now);
    expect(send.mock.calls[0]![2]).toEqual({ quoted: SENT });
    expect(makeQuoted).not.toHaveBeenCalled();
  });
});

describe("formatSummaryForWhatsApp", () => {
  it("converts markdown emphasis, headings, and bullets to WhatsApp style", () => {
    const out = formatSummaryForWhatsApp("## נושאים עיקריים\n**מודגש**\n- אחד\n* שתיים");
    expect(out).toContain("📌 *נושאים עיקריים*");
    expect(out).toContain("*מודגש*");
    expect(out).toContain("• אחד");
    expect(out).toContain("• שתיים");
  });

  it("strips citation markers", () => {
    expect(formatSummaryForWhatsApp("החלטה חשובה [#3, #5]")).toBe("החלטה חשובה");
  });

  it("returns empty string for blank input", () => {
    expect(formatSummaryForWhatsApp("   ")).toBe("");
  });
});

// ── reply header + citation stripping ────────────────────────────────────────

describe("buildWhatsAppReply", () => {
  const output = {
    version: 2 as const,
    overview: "## תקציר\nתמצית.",
    tldr: "תמצית.",
    topics: [{ text: "אלכס הציג רעיון ^" }, { text: "רועי הגיב ^12" }],
    decisions: [],
    openQuestions: [],
    actionItems: [],
  };

  it("strips the model's index-less caret, which the collector's own regex let through", () => {
    // The live /סיכום reply was full of stray "^" — the collector kept a THIRD
    // private copy of the citation regexes, and like the two it duplicated, both
    // required a digit after the caret.
    const reply = buildWhatsAppReply(output);
    expect(reply).not.toContain("^");
    expect(reply).toContain("אלכס הציג רעיון");
    expect(reply).toContain("רועי הגיב");
  });

  it("puts a Hebrew 'summarizing from …' line at the very top", () => {
    const reply = buildWhatsAppReply(output, {
      coveredFrom: new Date("2026-07-12T20:47:00Z"),
      droppedCount: 0,
    });
    expect(reply.split("\n")[0]).toMatch(/^🕐 _מסכם מ־/);
    // The reader must be able to see WHEN the summary starts from.
    expect(reply.split("\n")[0]).toContain("12.7");
  });

  it("says so when the budget forced messages out, rather than overstating coverage", () => {
    // coveredFrom is the oldest message ACTUALLY summarized, so the timestamp is
    // already honest; this makes the omission explicit too.
    const reply = buildWhatsAppReply(output, {
      coveredFrom: new Date("2026-07-12T20:47:00Z"),
      droppedCount: 213,
    });
    expect(reply.split("\n")[0]).toContain("213");
  });

  it("omits the header entirely when there is no window to report", () => {
    expect(buildWhatsAppReply(output).startsWith("🕐")).toBe(false);
  });
});
