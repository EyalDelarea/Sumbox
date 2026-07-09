import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RunSummarizeResult } from "../summarization/summarize.js";
import {
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
  return { kind: "ok", output: { overview } as never, summaryId: 1 };
}

const SENT = { key: { id: "sent-1", remoteJid: JID } } as unknown as WAMessage;

function defaultMarks(): SummaryCommandDeps["marks"] {
  return {
    resolveParticipantId: vi.fn(async (name: string) => (name === "Noa" ? 22 : 11)),
    getMark: vi.fn(async () => null),
    setMark: vi.fn(async () => {}),
    getSummaryOutput: vi.fn(async () => ({ overview: "prev summary" }) as never),
  };
}

function baseDeps(over: Partial<SummaryCommandDeps> = {}): SummaryCommandDeps {
  return {
    pool: fakePool({ group: { id: 7, name: "בוקר טוב" } }),
    resolveEnabledJids: async () => new Set([JID]),
    resolveTrigger: async () => SUMMARY_COMMAND,
    sendText: vi.fn(async () => SENT),
    react: vi.fn(async () => {}),
    inFlight: new Set<number>(),
    lastSummaryByUser: new Map(),
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
  it("anchors on the last summary's created_at when one exists", async () => {
    const anchor = new Date("2026-07-06T08:00:00Z");
    const run = vi.fn(async () => okResult("hi"));
    const deps = baseDeps({
      pool: fakePool({ group: { id: 7, name: "g" }, lastSummaryAt: anchor }),
      runSummarize: run,
    });
    await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    expect(run).toHaveBeenCalledWith({
      groupId: 7,
      selection: { since: anchor },
      requesterId: expect.any(Number),
    });
  });

  it("falls back to a last-N window when the group has no prior summary", async () => {
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
      runSummarize: vi.fn(async () => ({ kind: "ok", output: structured, summaryId: 1 })),
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

describe("maybeHandleSummaryCommand — in-flight lock", () => {
  it("skips a second concurrent command for the same group", async () => {
    const deps = baseDeps({ inFlight: new Set([7]) });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(deps.sendText).not.toHaveBeenCalled();
  });

  it("releases the lock after completion so a later command runs", async () => {
    const inFlight = new Set<number>();
    const deps = baseDeps({ inFlight });
    await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps);
    expect(inFlight.has(7)).toBe(false);
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(true);
  });

  it("releases the lock even when generation throws", async () => {
    const inFlight = new Set<number>();
    const deps = baseDeps({
      inFlight,
      runSummarize: vi.fn(async () => {
        throw new Error("ollama down");
      }),
    });
    expect(await maybeHandleSummaryCommand(textMsg(SUMMARY_COMMAND), deps)).toBe(false);
    expect(inFlight.has(7)).toBe(false);
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

describe("maybeHandleSummaryCommand — per-user marks", () => {
  const now = () => Date.parse("2026-07-06T21:00:00Z");
  const eyalMsg = () =>
    textMsg(SUMMARY_COMMAND, JID, false, Date.parse("2026-07-06T21:00:00Z") / 1000, "Dana Cohen");

  function makeMarks(over: Record<string, unknown> = {}) {
    return {
      resolveParticipantId: vi.fn(async (name: string) => (name === "Dana Cohen" ? 11 : 22)),
      getMark: vi.fn(async () => null),
      setMark: vi.fn(async () => {}),
      getSummaryOutput: vi.fn(async () => ({ overview: "prev summary" }) as never),
      ...over,
    } as never;
  }

  it("first-timer anchors on the group's last summary and records a per-user mark", async () => {
    const run = vi.fn(async () => okResult("hi"));
    const marks = makeMarks();
    const deps = baseDeps({
      pool: fakePool({
        group: { id: 7, name: "g" },
        lastSummaryAt: new Date("2026-07-06T08:00:00Z"),
      }),
      runSummarize: run,
      marks,
      lastSummaryByUser: new Map(),
    });
    await maybeHandleSummaryCommand(eyalMsg(), deps, now);
    expect(run).toHaveBeenCalledWith({
      groupId: 7,
      selection: { since: new Date("2026-07-06T08:00:00Z") },
      requesterId: 11,
    });
    expect(marks.setMark).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 7,
        participantId: 11,
        lastSummaryId: 1,
        lastReplyWaMessageId: "sent-1",
      }),
    );
  });

  it("a returning user anchors on their OWN mark, not the group's summary", async () => {
    const userAnchor = new Date("2026-07-06T20:00:00Z");
    const run = vi.fn(async () => okResult("hi"));
    const marks = makeMarks({
      getMark: vi.fn(async () => ({
        lastSummarizedAt: userAnchor,
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
      lastSummaryByUser: new Map(),
    });
    await maybeHandleSummaryCommand(eyalMsg(), deps, now);
    expect(run).toHaveBeenCalledWith({
      groupId: 7,
      selection: { since: userAnchor },
      requesterId: 11,
    });
  });

  it("a first-timer (no mark) quotes the /סיכום request", async () => {
    const send = vi.fn(async () => SENT);
    const msg = eyalMsg();
    const deps = baseDeps({
      sendText: send,
      marks: makeMarks(), // getMark → null
      lastSummaryByUser: new Map(),
      pool: fakePool({ group: { id: 7, name: "g" } }),
    });
    await maybeHandleSummaryCommand(msg, deps, now);
    expect(send.mock.calls[0]![2]).toEqual({ quoted: msg });
  });

  it("quotes the user's OWN previous summary (reconstructed from their mark)", async () => {
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
    const deps = baseDeps({ sendText: send, makeQuoted, marks, lastSummaryByUser: new Map() });
    await maybeHandleSummaryCommand(eyalMsg(), deps, now);
    expect(marks.getSummaryOutput).toHaveBeenCalledWith(5);
    expect(makeQuoted).toHaveBeenCalledWith(JID, "wa-5", expect.stringContaining("prev summary"));
    expect(send.mock.calls[0]![2]).toEqual({ quoted: RECON });
  });

  it("keys marks per participant — two askers stay independent", async () => {
    const setMark = vi.fn(async () => {});
    const marks = makeMarks({ setMark });
    const deps = baseDeps({
      pool: fakePool({ group: { id: 7, name: "g" } }),
      marks,
      lastSummaryByUser: new Map(),
    });
    await maybeHandleSummaryCommand(eyalMsg(), deps, now);
    await maybeHandleSummaryCommand(
      textMsg(SUMMARY_COMMAND, JID, false, Date.parse("2026-07-06T21:00:00Z") / 1000, "Noa"),
      deps,
      now,
    );
    expect(setMark.mock.calls[0]![0]).toMatchObject({ participantId: 11 });
    expect(setMark.mock.calls[1]![0]).toMatchObject({ participantId: 22 });
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
