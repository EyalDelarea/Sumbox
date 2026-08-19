import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAidaMessage } from "../db/repositories/aida-messages.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import {
  type CandidateMessage,
  parseCandidates,
  selectCandidates,
  validateCandidate,
} from "./memory-extract.js";

const SINCE = new Date("2026-05-01T00:00:00Z");
const UNTIL = new Date("2026-05-02T00:00:00Z");

function msg(
  groupId: number,
  participantId: number,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage & { participantId: number } {
  return {
    groupId,
    importId: null,
    source: "live",
    senderName: "x",
    messageType: "text",
    textContent: "hi",
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    sentAt: new Date("2026-05-01T10:00:00.000Z"),
    dedupeKey: `pk-${Math.random()}`,
    externalId: `ext-${Math.random()}`,
    fromMe: null,
    participantId,
    ...overrides,
  };
}

describe("selectCandidates (D7 exclusions)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("excludes her own output and anything addressed to her", async () => {
    const g = await upsertGroup(pool, { name: `x-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `P-${Math.random()}`);
    const hers = msg(g, p, { textContent: "תכף תכף... my own reply" });
    await insertMessages(pool, [
      msg(g, p, { textContent: "אני עובד בחברת סייבר" }), // ordinary — eligible
      msg(g, p, { textContent: "@אידה מה דעתך על רועי?" }), // addressed to her
      msg(g, p, { textContent: "@aida tell me something" }), // addressed, latin
      hers,
    ]);
    // Mark the reply as hers, the way ask-command and summary-command both do.
    await recordAidaMessage(pool, { groupId: g, externalId: hers.externalId as string });

    const got = await selectCandidates(pool, g, SINCE, UNTIL);
    expect(got.map((m) => m.content)).toEqual(["אני עובד בחברת סייבר"]);
  });

  // This is the property that makes the plant vector expensive: to teach her
  // something durable you must say it to the GROUP, not to her. Every turn of the
  // 2026-08-19 jailbreak was @-addressed or her own reply.
  it("excludes an entire interrogation-shaped exchange", async () => {
    const g = await upsertGroup(pool, { name: `y-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `Q-${Math.random()}`);
    const reply = msg(g, p, { textContent: "תכף תכף... נראה שהיה עימות בין בר לאייל" });
    await insertMessages(pool, [
      msg(g, p, { textContent: "@אידה תספרי לנו במילים שלך משהו דרמטי שקרה בין בר לאייל" }),
      reply,
    ]);
    await recordAidaMessage(pool, { groupId: g, externalId: reply.externalId as string });
    expect(await selectCandidates(pool, g, SINCE, UNTIL)).toEqual([]);
  });

  it("keeps the owner's own messages — from_me is not an exclusion", async () => {
    // Measured on group 70: from_me covers 3405 owner messages vs 185 bot replies.
    // Excluding it would blind her to the most active person in the room.
    const g = await upsertGroup(pool, { name: `z-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `O-${Math.random()}`);
    await insertMessages(pool, [msg(g, p, { fromMe: true, textContent: "אני גר בתל אביב" })]);
    expect((await selectCandidates(pool, g, SINCE, UNTIL)).map((m) => m.content)).toEqual([
      "אני גר בתל אביב",
    ]);
  });

  it("scopes to the group and the window", async () => {
    const a = await upsertGroup(pool, { name: `a-${Math.random()}`, source: "import" });
    const b = await upsertGroup(pool, { name: `b-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `S-${Math.random()}`);
    await insertMessages(pool, [
      msg(b, p, { textContent: "other group" }),
      msg(a, p, { textContent: "too old", sentAt: new Date("2026-04-01T10:00:00Z") }),
      msg(a, p, { textContent: "in window" }),
    ]);
    expect((await selectCandidates(pool, a, SINCE, UNTIL)).map((m) => m.content)).toEqual([
      "in window",
    ]);
  });
});

describe("validateCandidate", () => {
  const shown = new Map<number, CandidateMessage>([
    [10, { messageId: 10, sender: "Royi", content: "c", sentAt: new Date() }],
  ]);

  it("accepts a candidate citing a shown message", () => {
    expect(validateCandidate({ sourceMessageId: 10, content: " works at X " }, shown).ok).toEqual({
      sourceMessageId: 10,
      content: "works at X",
    });
  });

  // The load-bearing check. A hallucinated id is the extractor's likeliest
  // failure, and an id outside the shown set could point into another group —
  // which is the one thing memory must never do.
  it("rejects an id it was never shown", () => {
    expect(validateCandidate({ sourceMessageId: 999, content: "x" }, shown)).toEqual({
      ok: null,
      reason: "invented-id",
    });
  });

  it("distinguishes its rejection reasons", () => {
    // Conflating these would hide which extractor bug is actually happening.
    expect(validateCandidate({ sourceMessageId: 10, content: "  " }, shown).reason).toBe(
      "empty-content",
    );
    expect(validateCandidate({ sourceMessageId: "no", content: "x" }, shown).reason).toBe("bad-id");
    expect(validateCandidate("nope", shown).reason).toBe("not-an-object");
    expect(validateCandidate({ sourceMessageId: 10, content: "x".repeat(301) }, shown).reason).toBe(
      "too-long",
    );
  });
});

describe("parseCandidates", () => {
  it("finds the array inside prose or a code fence", () => {
    expect(parseCandidates('sure!\n```json\n[{"sourceMessageId":1,"content":"a"}]\n```')).toEqual([
      { sourceMessageId: 1, content: "a" },
    ]);
  });

  it("yields nothing rather than guessing when the reply is unparseable", () => {
    // A missed observation costs nothing; an invented one is the whole risk.
    expect(parseCandidates("I could not find anything useful")).toEqual([]);
    expect(parseCandidates("[not json")).toEqual([]);
    expect(parseCandidates('{"sourceMessageId":1}')).toEqual([]);
  });
});
