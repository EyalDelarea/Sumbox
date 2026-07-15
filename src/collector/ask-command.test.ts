import type { WAMessage } from "@whiskeysockets/baileys";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
      answer: vi.fn(async () => "לפי השיחה, נפגשים ב-21:00."),
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
