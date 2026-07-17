import type { WAMessage } from "@whiskeysockets/baileys";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordAidaMessage } from "../db/repositories/aida-messages.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { createTestDatabase } from "../test/db.js";
import { type AskCommandDeps, maybeHandleAskCommand } from "./ask-command.js";

const JID = "120363-ask@g.us";

function askMsg(body: string, jid = JID, tsSec = Date.now() / 1000): WAMessage {
  return {
    key: { id: "m1", remoteJid: jid, fromMe: false },
    message: { conversation: body },
    messageTimestamp: Math.floor(tsSec),
  } as unknown as WAMessage;
}

/** A reply quoting `quotedId`, exactly as Baileys shapes a swipe-reply. */
function replyMsg(body: string, quotedId: string, jid = JID): WAMessage {
  return {
    key: { id: "r1", remoteJid: jid, fromMe: false },
    message: { extendedTextMessage: { text: body, contextInfo: { stanzaId: quotedId } } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as unknown as WAMessage;
}

describe("maybeHandleAskCommand", () => {
  let pool: pg.Pool;
  let groupId: number;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    // The groups row must exist AND carry the JID the handler looks up.
    groupId = await upsertGroup(pool, { name: "ASK-grp", source: "import" });
    await pool.query("UPDATE groups SET whatsapp_id=$1 WHERE id=$2", [JID, groupId]);
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  function deps(over: Partial<AskCommandDeps> = {}): AskCommandDeps {
    return {
      pool,
      resolveEnabledJids: async () => new Set([JID]),
      sendText: vi.fn(async () => ({ key: { id: "s1" } }) as WAMessage),
      inFlight: new Set<number>(),
      answer: vi.fn(async () => ({ text: "לפי השיחה, נפגשים ב-21:00.", citedIds: [] })),
      ...over,
    };
  }

  it("answers a @Aida mention in an enabled group and replies", async () => {
    const d = deps();
    const ok = await maybeHandleAskCommand(askMsg("@אידה מתי נפגשים?"), d);
    expect(ok).toBe(true);
    expect(d.answer).toHaveBeenCalledWith({ groupId, question: "מתי נפגשים?" });
    expect(d.sendText).toHaveBeenCalledWith(JID, "לפי השיחה, נפגשים ב-21:00.", expect.anything());
  });

  it("ignores a message with no @Aida tag", async () => {
    const d = deps();
    expect(await maybeHandleAskCommand(askMsg("סתם הודעה"), d)).toBe(false);
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("DENIES a mention from a group NOT in the allowlist (never answers, never sends)", async () => {
    const d = deps({ resolveEnabledJids: async () => new Set<string>() });
    expect(await maybeHandleAskCommand(askMsg("@אידה מה?"), d)).toBe(false);
    expect(d.answer).not.toHaveBeenCalled();
    expect(d.sendText).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED — a permissions DB error sends nothing", async () => {
    const d = deps({
      resolveEnabledJids: async () => {
        throw new Error("db down");
      },
    });
    expect(await maybeHandleAskCommand(askMsg("@אידה מה?"), d)).toBe(false);
    expect(d.sendText).not.toHaveBeenCalled();
  });

  it("ignores a stale (replayed) message outside the liveness window", async () => {
    const d = deps();
    const old = askMsg("@אידה מה?", JID, Date.now() / 1000 - 600); // 10 min ago
    expect(await maybeHandleAskCommand(old, d)).toBe(false);
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("skips when already answering the same group (in-flight lock)", async () => {
    const inFlight = new Set<number>([groupId]);
    const d = deps({ inFlight });
    expect(await maybeHandleAskCommand(askMsg("@אידה מה?"), d)).toBe(false);
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("a bare @Aida with no question does not fire", async () => {
    const d = deps();
    expect(await maybeHandleAskCommand(askMsg("@אידה"), d)).toBe(false);
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("a DB error in the group lookup surfaces ❌ + error reply, not a silent drop", async () => {
    // Regression: the group lookup used to sit OUTSIDE the try, so a DB hiccup
    // dropped the answer with no feedback — contradicting the design promise.
    const react = vi.fn(async () => {});
    const badPool = {
      query: vi.fn(async () => {
        throw new Error("db hiccup");
      }),
    } as unknown as pg.Pool;
    const d = deps({ pool: badPool, react });
    expect(await maybeHandleAskCommand(askMsg("@אידה מה?"), d)).toBe(false);
    expect(react).toHaveBeenCalledWith(JID, expect.anything(), "❌");
    expect(d.sendText).toHaveBeenCalledWith(JID, expect.stringMatching(/סליחה/), expect.anything());
  });

  it("does not release another call's in-flight lock when it skips as already-running", async () => {
    // The finally must only delete the lock THIS call acquired.
    const inFlight = new Set<number>([groupId]); // another call holds it
    const d = deps({ inFlight });
    await maybeHandleAskCommand(askMsg("@אידה מה?"), d);
    expect(inFlight.has(groupId)).toBe(true); // still held — not stolen
  });

  it("sends an error reply (not silence) when answering throws, and releases the lock", async () => {
    const inFlight = new Set<number>();
    const d = deps({
      inFlight,
      answer: vi.fn(async () => {
        throw new Error("ollama down");
      }),
    });
    expect(await maybeHandleAskCommand(askMsg("@אידה מה?"), d)).toBe(false);
    expect(d.sendText).toHaveBeenCalledWith(JID, expect.stringMatching(/סליחה/), expect.anything());
    expect(inFlight.has(groupId)).toBe(false); // lock released even on failure
  });
});

describe("reply-threading", () => {
  let pool: pg.Pool;
  let groupId: number;
  const RJID = "120363-thread@g.us";
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    groupId = await upsertGroup(pool, { name: "ASK-thread", source: "import" });
    await pool.query("UPDATE groups SET whatsapp_id=$1 WHERE id=$2", [RJID, groupId]);
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const deps = (over: Partial<AskCommandDeps> = {}): AskCommandDeps => ({
    pool,
    resolveEnabledJids: async () => new Set([RJID]),
    sendText: vi.fn(async () => ({ key: { id: "sent-1" } }) as WAMessage),
    inFlight: new Set<number>(),
    answer: vi.fn(async () => ({ text: "תכף תכף... אתמול דיברנו על זה.", citedIds: [] })),
    ...over,
  });

  it("fires on a reply to HER message with NO @Aida tag", async () => {
    await recordAidaMessage(pool, { groupId, externalId: "aida-said-this" });
    const d = deps();
    const ok = await maybeHandleAskCommand(replyMsg("ומה לגבי אתמול?", "aida-said-this", RJID), d);
    expect(ok).toBe(true);
    // The whole body is the question — there is no tag to strip.
    expect(d.answer).toHaveBeenCalledWith({ groupId, question: "ומה לגבי אתמול?" });
  });

  it("does NOT fire on a reply to someone else's message", async () => {
    // The load-bearing case: from_me is true for the OWNER's messages too, so
    // without the marker a reply to Eyal's own message would wake her.
    const d = deps();
    const ok = await maybeHandleAskCommand(replyMsg("ומה לגבי אתמול?", "eyal-said-this", RJID), d);
    expect(ok).toBe(false);
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("is scoped per group — her message in another group does not arm a thread here", async () => {
    const other = await upsertGroup(pool, { name: "ASK-other", source: "import" });
    await recordAidaMessage(pool, { groupId: other, externalId: "cross-group" });
    const d = deps();
    expect(await maybeHandleAskCommand(replyMsg("שאלה", "cross-group", RJID), d)).toBe(false);
  });

  it("still fires on an @Aida tag with no reply at all", async () => {
    const d = deps();
    expect(await maybeHandleAskCommand(askMsg("@אידה מה קורה?", RJID), d)).toBe(true);
  });

  it("threads on a reply of ANY age — liveness gates replay, not thread age", async () => {
    await recordAidaMessage(pool, { groupId, externalId: "old-aida-msg" });
    const d = deps();
    // The quoted message is ancient; the REPLY is live, which is all that matters.
    expect(await maybeHandleAskCommand(replyMsg("עדיין רלוונטי?", "old-aida-msg", RJID), d)).toBe(
      true,
    );
  });

  it("records her reply so the NEXT reply can thread off it", async () => {
    await recordAidaMessage(pool, { groupId, externalId: "chain-start" });
    const d = deps();
    await maybeHandleAskCommand(replyMsg("שאלה ראשונה", "chain-start", RJID), d);
    // sendText returned key.id "sent-1" — that must now be threadable.
    const { rows } = await pool.query(
      "SELECT 1 FROM aida_messages WHERE group_id=$1 AND external_id='sent-1'",
      [groupId],
    );
    expect(rows).toHaveLength(1);
  });
});
