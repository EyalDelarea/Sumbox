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
    expect(d.answer).toHaveBeenCalledWith({
      groupId,
      question: "מתי נפגשים?",
      askerName: expect.any(String),
    });
    expect(d.sendText).toHaveBeenCalledWith(JID, "לפי השיחה, נפגשים ב-21:00.", expect.anything());
  });

  /** A real message she could cite. Returns its internal id. */
  async function seedMessage(over: {
    text: string;
    externalId: string;
    authorJid?: string | null;
    fromMe?: boolean;
  }): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO participants (display_name) VALUES ($1)
         ON CONFLICT (tenant_id, display_name) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [`author-${over.externalId}`],
    );
    const pid = Number(rows[0]!.id);
    // The jid lives on the MESSAGE, not the participant — a display_name is
    // shared by anyone with the same pushName.
    const { rows: m } = await pool.query<{ id: string }>(
      `INSERT INTO messages
         (group_id, participant_id, source, external_id, message_type, text_content,
          sent_at, dedupe_key, from_me, sender_jid)
       VALUES ($1,$2,'live',$3,'text',$4, now(), $5, $6, $7) RETURNING id`,
      [
        groupId,
        pid,
        over.externalId,
        over.text,
        `dk-${over.externalId}`,
        over.fromMe ?? false,
        over.authorJid ?? null,
      ],
    );
    return Number(m[0]!.id);
  }

  it("quote-replies the SOURCE message when she cites exactly one", async () => {
    const srcId = await seedMessage({
      text: "נפגשים ב-21:00 בכיכר",
      externalId: "SRC1",
      authorJid: "972500000001@s.whatsapp.net",
    });
    const makeQuoted = vi.fn(() => ({ key: { id: "SRC1" } }) as WAMessage);
    const d = deps({
      answer: vi.fn(async () => ({ text: "תכף תכף... ב-21:00 בכיכר.", citedIds: [srcId] })),
      makeQuoted,
    });

    expect(await maybeHandleAskCommand(askMsg("@אידה איפה אמרנו שנפגשים?"), d)).toBe(true);
    // Quoted with the AUTHOR's identity — crediting it to us would put their
    // words in the owner's mouth.
    expect(makeQuoted).toHaveBeenCalledWith(JID, "SRC1", "נפגשים ב-21:00 בכיכר", {
      jid: "972500000001@s.whatsapp.net",
      fromMe: false,
    });
    expect(d.sendText).toHaveBeenCalledWith(JID, "תכף תכף... ב-21:00 בכיכר.", {
      quoted: { key: { id: "SRC1" } },
    });
  });

  it("quotes the ASKER when she cites MANY — a summary has no single source", async () => {
    const a = await seedMessage({ text: "א", externalId: "M1", authorJid: "1@s.whatsapp.net" });
    const b = await seedMessage({ text: "ב", externalId: "M2", authorJid: "2@s.whatsapp.net" });
    const makeQuoted = vi.fn();
    const d = deps({
      answer: vi.fn(async () => ({ text: "דיברנו על הכל.", citedIds: [a, b] })),
      makeQuoted,
    });

    await maybeHandleAskCommand(askMsg("@אידה על מה דיברנו?"), d);
    expect(makeQuoted).not.toHaveBeenCalled();
    // quoted is the triggering message, i.e. the asker
    expect(d.sendText).toHaveBeenCalledWith(JID, "דיברנו על הכל.", {
      quoted: expect.objectContaining({ key: expect.objectContaining({ id: "m1" }) }),
    });
  });

  it("quotes the ASKER when she cites nothing (~8% of replies)", async () => {
    const makeQuoted = vi.fn();
    const d = deps({ makeQuoted });
    await maybeHandleAskCommand(askMsg("@אידה מה?"), d);
    expect(makeQuoted).not.toHaveBeenCalled();
  });

  it("does NOT quote a source whose author we never recorded", async () => {
    // Imported history and anything ingested before jids were stored. Quoting it
    // would misattribute, so the pin is dropped — the answer still sends.
    const srcId = await seedMessage({ text: "משהו ישן", externalId: "OLD1", authorJid: null });
    const makeQuoted = vi.fn();
    const d = deps({
      answer: vi.fn(async () => ({ text: "תכף תכף... כן.", citedIds: [srcId] })),
      makeQuoted,
    });

    expect(await maybeHandleAskCommand(askMsg("@אידה מה אמרו?"), d)).toBe(true);
    expect(makeQuoted).not.toHaveBeenCalled();
    expect(d.sendText).toHaveBeenCalledWith(JID, "תכף תכף... כן.", expect.anything());
  });

  it("quotes her OWN past message without needing an author jid", async () => {
    // from_me carries the attribution by itself — it's us either way.
    const srcId = await seedMessage({
      text: "תכף תכף... אמרתי 21:00",
      externalId: "MINE1",
      authorJid: null,
      fromMe: true,
    });
    const makeQuoted = vi.fn(() => ({ key: { id: "MINE1" } }) as WAMessage);
    const d = deps({
      answer: vi.fn(async () => ({ text: "כן, אמרתי.", citedIds: [srcId] })),
      makeQuoted,
    });

    await maybeHandleAskCommand(askMsg("@אידה מה אמרת?"), d);
    expect(makeQuoted).toHaveBeenCalledWith(JID, "MINE1", "תכף תכף... אמרתי 21:00", {
      jid: null,
      fromMe: true,
    });
  });

  it("attributes the quote to THIS message's author, not to a name-sharing stranger", async () => {
    // Regression: the jid used to hang off the participant row, which is keyed on
    // display_name (from pushName — self-chosen, not unique across chats). Two
    // people called "אמא" in two groups share one row, so the stored jid was
    // whoever spoke last, and a quote here could carry another group's jid.
    // sender_jid is per-message, so the collision cannot reach attribution.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO participants (display_name) VALUES ('אמא')
         ON CONFLICT (tenant_id, display_name) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
    );
    const shared = Number(rows[0]!.id);
    const mk = async (ext: string, jid: string) => {
      const { rows: m } = await pool.query<{ id: string }>(
        `INSERT INTO messages
           (group_id, participant_id, source, external_id, message_type, text_content,
            sent_at, dedupe_key, from_me, sender_jid)
         VALUES ($1,$2,'live',$3,'text','שלום', now(), $4, false, $5) RETURNING id`,
        [groupId, shared, ext, `dk-${ext}`, jid],
      );
      return Number(m[0]!.id);
    };
    // Both rows share ONE participant, but each keeps its own author.
    const first = await mk("AMA1", "972500000011@s.whatsapp.net");
    await mk("AMA2", "972500000022@s.whatsapp.net"); // the later speaker

    const makeQuoted = vi.fn(() => ({ key: { id: "AMA1" } }) as WAMessage);
    const d = deps({
      answer: vi.fn(async () => ({ text: "היא אמרה שלום.", citedIds: [first] })),
      makeQuoted,
    });
    await maybeHandleAskCommand(askMsg("@אידה מה אמא אמרה?"), d);
    expect(makeQuoted).toHaveBeenCalledWith(JID, "AMA1", "שלום", {
      jid: "972500000011@s.whatsapp.net", // the FIRST author, not the last writer
      fromMe: false,
    });
  });

  it("still answers when the cited id is unknown or from another group", async () => {
    const makeQuoted = vi.fn();
    const d = deps({
      answer: vi.fn(async () => ({ text: "תכף תכף... כן.", citedIds: [99999999] })),
      makeQuoted,
    });
    expect(await maybeHandleAskCommand(askMsg("@אידה מה?"), d)).toBe(true);
    expect(makeQuoted).not.toHaveBeenCalled();
    expect(d.sendText).toHaveBeenCalledWith(JID, "תכף תכף... כן.", expect.anything());
  });

  it("tells the answer path WHO is asking, so 'מה אמרתי' can resolve", async () => {
    // The transcript names every speaker, but nothing said which of them is the
    // "I" doing the asking — she attributed the asker's own words to a third
    // person and denied first-person questions whose answer she was holding.
    const d = deps();
    const msg = {
      key: { id: "m-asker", remoteJid: JID, fromMe: false },
      message: { conversation: "@אידה מה אמרתי על אלכס?" },
      pushName: "Eyal Delarea",
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as unknown as WAMessage;
    await maybeHandleAskCommand(msg, d);
    expect(d.answer).toHaveBeenCalledWith(expect.objectContaining({ askerName: "Eyal Delarea" }));
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
    expect(d.answer).toHaveBeenCalledWith(
      expect.objectContaining({ groupId, question: "ומה לגבי אתמול?" }),
    );
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
