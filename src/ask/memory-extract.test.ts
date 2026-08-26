import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAidaMessage } from "../db/repositories/aida-messages.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { listGroupParticipants, upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import {
  type CandidateMessage,
  isIdentifiableAuthor,
  parseCandidates,
  selectCandidates,
  toSemanticDraft,
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
    expect(got.candidates.map((m) => m.content)).toEqual(["אני עובד בחברת סייבר"]);
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
    expect((await selectCandidates(pool, g, SINCE, UNTIL)).candidates).toEqual([]);
  });

  it("keeps the owner's own messages — from_me is not an exclusion", async () => {
    // Measured on group 70: from_me covers 3405 owner messages vs 185 bot replies.
    // Excluding it would blind her to the most active person in the room.
    const g = await upsertGroup(pool, { name: `z-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `O-${Math.random()}`);
    await insertMessages(pool, [msg(g, p, { fromMe: true, textContent: "אני גר בתל אביב" })]);
    expect(
      (await selectCandidates(pool, g, SINCE, UNTIL)).candidates.map((m) => m.content),
    ).toEqual(["אני גר בתל אביב"]);
  });

  // ── #88 · the author must be an identifiable person ──────────────────────
  //
  // A group message arriving without a pushName and without a per-message
  // participant key resolves its sender name to the CHAT'S OWN JID, and
  // participants are keyed on display_name alone — so every such message from
  // every such sender lands on one row. Measured on group 70 over 30 days: 259
  // messages, 159 from_me and 100 from real different people, one "person".
  //
  // The roster already hides that row. Extraction did not, so the first thing
  // memory would do on real data is form beliefs about someone who is not there.

  it("excludes a message whose author is a JID-shaped participant", async () => {
    const g = await upsertGroup(pool, { name: `j-${Math.random()}`, source: "import" });
    const bucket = await upsertParticipant(pool, `120363406567322025@g.us`);
    const real = await upsertParticipant(pool, `R-${Math.random()}`);
    await insertMessages(pool, [
      msg(g, bucket, { textContent: "מאת אף אחד" }),
      msg(g, real, { textContent: "אני גר בחיפה" }),
    ]);
    const got = await selectCandidates(pool, g, SINCE, UNTIL);
    expect(got.candidates.map((m) => m.content)).toEqual(["אני גר בחיפה"]);
  });

  it("excludes a message on the Unknown placeholder participant", async () => {
    const g = await upsertGroup(pool, { name: `u-${Math.random()}`, source: "import" });
    const unknown = await upsertParticipant(pool, "Unknown");
    await insertMessages(pool, [msg(g, unknown, { textContent: "אני עובד בבנק" })]);
    expect((await selectCandidates(pool, g, SINCE, UNTIL)).candidates).toEqual([]);
  });

  // The historical case, and the reason this rule beats a content heuristic.
  // `aida_messages` covers her replies but only 5 of 9 digest posts in group 70;
  // digests posted before 2026-08-19 were never marked, so today she reads her
  // own summaries as ordinary conversation. Every digest lands on a JID-shaped
  // participant, so the author rule closes the gap with no backfill.
  it("excludes an unmarked digest post through the author rule, not its shape", async () => {
    const g = await upsertGroup(pool, { name: `d-${Math.random()}`, source: "import" });
    const bucket = await upsertParticipant(pool, `120363406567322099@g.us`);
    await insertMessages(pool, [
      msg(g, bucket, {
        fromMe: true,
        textContent: "🕐 _מסכם מ־10.8_ 📝 *תקציר* הקבוצה תכננה טיול למונטנגרו",
      }),
    ]);
    // Deliberately NOT recorded in aida_messages — that is the whole point.
    expect((await selectCandidates(pool, g, SINCE, UNTIL)).candidates).toEqual([]);
  });

  it("keeps ordinary members and the owner, with the existing exclusions intact", async () => {
    const g = await upsertGroup(pool, { name: `k-${Math.random()}`, source: "import" });
    const member = await upsertParticipant(pool, `M-${Math.random()}`);
    const owner = await upsertParticipant(pool, `W-${Math.random()}`);
    const hers = msg(g, member, { textContent: "תכף תכף... my own reply" });
    await insertMessages(pool, [
      msg(g, member, { textContent: "אני לומדת רפואה" }),
      msg(g, owner, { fromMe: true, textContent: "אני גר בתל אביב" }),
      msg(g, member, { textContent: "@אידה מה קורה?" }),
      hers,
    ]);
    await recordAidaMessage(pool, { groupId: g, externalId: hers.externalId as string });
    const got = await selectCandidates(pool, g, SINCE, UNTIL);
    expect(got.candidates.map((m) => m.content).sort()).toEqual(
      ["אני גר בתל אביב", "אני לומדת רפואה"].sort(),
    );
  });

  // sender_jid is the identity a later slice attributes a memory to. It is
  // NULLABLE on the column, and a null must never become an exclusion: a message
  // with a resolved display name is from a real person whether or not the jid
  // was captured. Getting this backwards silently guts the corpus.
  it("carries the author's sender_jid, and keeps a candidate whose jid is null", async () => {
    const g = await upsertGroup(pool, { name: `i-${Math.random()}`, source: "import" });
    const withJid = await upsertParticipant(pool, `A-${Math.random()}`);
    const noJid = await upsertParticipant(pool, `B-${Math.random()}`);
    await insertMessages(pool, [
      msg(g, withJid, {
        textContent: "יש לי כלב",
        senderJid: "972501234567@s.whatsapp.net",
        sentAt: new Date("2026-05-01T10:00:00.000Z"),
      }),
      msg(g, noJid, { textContent: "אין לי ג׳יד", sentAt: new Date("2026-05-01T11:00:00.000Z") }),
    ]);
    const got = await selectCandidates(pool, g, SINCE, UNTIL);
    expect(got.candidates.map((m) => [m.content, m.senderJid])).toEqual([
      ["יש לי כלב", "972501234567@s.whatsapp.net"],
      ["אין לי ג׳יד", null],
    ]);
  });

  // #95: the narrowing --write needs, and the reason it is a PARAMETER and not a
  // change of default. A semantic memory's subject is NOT NULL, so a belief cited
  // from a jid-less message cannot be stored — but slice 4's episodic memories
  // have a nullable subject, so the same message is usable there. Narrowing the
  // default would take that away silently.
  it("can require an author identity, without changing what the default returns", async () => {
    const g = await upsertGroup(pool, { name: `ri-${Math.random()}`, source: "import" });
    const withJid = await upsertParticipant(pool, `RA-${Math.random()}`);
    const noJid = await upsertParticipant(pool, `RB-${Math.random()}`);
    await insertMessages(pool, [
      msg(g, withJid, {
        textContent: "יש לי ג׳יד",
        senderJid: "972500000042@s.whatsapp.net",
        sentAt: new Date("2026-05-01T10:00:00.000Z"),
      }),
      msg(g, noJid, { textContent: "אין לי ג׳יד", sentAt: new Date("2026-05-01T11:00:00.000Z") }),
    ]);

    const wide = await selectCandidates(pool, g, SINCE, UNTIL);
    expect(wide.candidates.map((m) => m.content)).toEqual(["יש לי ג׳יד", "אין לי ג׳יד"]);

    const narrow = await selectCandidates(pool, g, SINCE, UNTIL, { requireAuthorIdentity: true });
    expect(narrow.candidates.map((m) => m.content)).toEqual(["יש לי ג׳יד"]);
  });

  // The narrowing is a LOSS, and a loss nobody counts is a corpus that shrinks
  // silently. Reported either way so the closing gap stays watchable from the
  // dry run too — measured on group 70 it fell from 100% to 17% in two months.
  it("counts the messages that carry no author identity, narrowed or not", async () => {
    const g = await upsertGroup(pool, { name: `ci-${Math.random()}`, source: "import" });
    const withJid = await upsertParticipant(pool, `CA-${Math.random()}`);
    const noJid = await upsertParticipant(pool, `CB-${Math.random()}`);
    await insertMessages(pool, [
      msg(g, withJid, { textContent: "a", senderJid: "972500000042@s.whatsapp.net" }),
      msg(g, noJid, { textContent: "b" }),
      msg(g, noJid, { textContent: "c" }),
    ]);
    expect((await selectCandidates(pool, g, SINCE, UNTIL)).withoutAuthorIdentity).toBe(2);
    expect(
      (await selectCandidates(pool, g, SINCE, UNTIL, { requireAuthorIdentity: true }))
        .withoutAuthorIdentity,
    ).toBe(2);
  });

  // A corpus that shrinks silently reads as a quiet group. The counts are how
  // that stays visible; they describe the window BEFORE the cap and before the
  // TS re-check, which is what makes them comparable run to run.
  it("reports what the window held and what it lost to unattributable authorship", async () => {
    const g = await upsertGroup(pool, { name: `c-${Math.random()}`, source: "import" });
    const bucket = await upsertParticipant(pool, `120363406567322077@g.us`);
    const real = await upsertParticipant(pool, `C-${Math.random()}`);
    await insertMessages(pool, [
      msg(g, bucket, { textContent: "one" }),
      msg(g, bucket, { textContent: "two" }),
      msg(g, real, { textContent: "three" }),
    ]);
    const got = await selectCandidates(pool, g, SINCE, UNTIL);
    expect({
      windowTotal: got.windowTotal,
      unattributable: got.unattributable,
      kept: got.candidates.length,
    }).toEqual({ windowTotal: 3, unattributable: 2, kept: 1 });
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
    expect(
      (await selectCandidates(pool, a, SINCE, UNTIL)).candidates.map((m) => m.content),
    ).toEqual(["in window"]);
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

describe("the author rule and the roster", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  // The extractor's predicate is a COPY of the roster's, and a copy with a
  // comment promising it matches drifts the moment either side is edited. This
  // is the promise, executable: one fixture, both readers, and they must name
  // the same people. #88 puts the roster explicitly out of scope, so importing
  // one shared fragment is not an option here — this is what replaces it.
  //
  // Mutation-checked in both directions it is meant to catch:
  //   - drop `<> 'Unknown'` from listGroupParticipants  -> RED
  //   - drop it from BOTH the SQL and isIdentifiableAuthor -> RED
  // It deliberately does NOT catch dropping it from this module's SQL alone:
  // isIdentifiableAuthor still filters the row, so behaviour is unchanged. That
  // is the belt-and-braces working, not a hole — but it means this test pins the
  // OBSERVABLE rule, not the SQL text.
  it("agrees with the roster on who is a person", async () => {
    const g = await upsertGroup(pool, { name: `r-${Math.random()}`, source: "import" });
    const real = await upsertParticipant(pool, `Dana-${Math.random()}`);
    const bucket = await upsertParticipant(pool, `120363406567322055@g.us`);
    const unknown = await upsertParticipant(pool, "Unknown");
    await insertMessages(pool, [
      msg(g, real, { textContent: "אני גרה בירושלים" }),
      msg(g, bucket, { textContent: "מאת אף אחד" }),
      msg(g, unknown, { textContent: "מאת לא ידוע" }),
    ]);

    // includeOwner: true — the roster @Aida actually builds, and the one that
    // matches selectCandidates, which does not exclude from_me either.
    const roster = (await listGroupParticipants(pool, g, 25, { includeOwner: true })).map(
      (r) => r.name,
    );
    const senders = (await selectCandidates(pool, g, SINCE, UNTIL)).candidates.map((m) => m.sender);
    expect(new Set(senders)).toEqual(new Set(roster));
  });
});

describe("isIdentifiableAuthor", () => {
  // Mirrors listGroupParticipants' predicate exactly. Kept as a pure function so
  // the TS re-check beside the SQL is directly testable rather than only
  // reachable through a database.
  it("rejects the shapes that are not a person", () => {
    expect(isIdentifiableAuthor("120363406567322025@g.us")).toBe(false);
    expect(isIdentifiableAuthor("972501234567@s.whatsapp.net")).toBe(false);
    expect(isIdentifiableAuthor("Unknown")).toBe(false);
    expect(isIdentifiableAuthor("")).toBe(false);
    expect(isIdentifiableAuthor("   ")).toBe(false);
    expect(isIdentifiableAuthor(null)).toBe(false);
  });

  it("accepts an ordinary display name", () => {
    expect(isIdentifiableAuthor("רועי")).toBe(true);
    expect(isIdentifiableAuthor("Eyal")).toBe(true);
    // Not a JID, and not the placeholder — a self-chosen name stays a name.
    expect(isIdentifiableAuthor("unknown")).toBe(true);
  });
});

/**
 * The bridge #95 crosses: a candidate the extractor produced and the validator
 * accepted, turned into something the memory repository will store.
 *
 * Pure, and tested without a model or a database, because what can go wrong here
 * is attribution — a belief filed against the wrong person, or against nobody —
 * and that does not need either to go wrong.
 */
describe("toSemanticDraft", () => {
  const shown = (over: Partial<CandidateMessage> = {}): Map<number, CandidateMessage> =>
    new Map([
      [
        7,
        {
          messageId: 7,
          sender: "רוני",
          senderJid: "972500000042@s.whatsapp.net",
          content: "אני לא אוכלת בשר",
          sentAt: new Date("2026-05-01T10:00:00.000Z"),
          ...over,
        },
      ],
    ]);

  it("files the belief against the author of the message it cites", () => {
    const draft = toSemanticDraft({ sourceMessageId: 7, content: "רוני לא אוכלת בשר" }, shown(), 3);
    expect(draft).toEqual({
      memoryType: "semantic",
      groupId: 3,
      subjectJid: "972500000042@s.whatsapp.net",
      content: "רוני לא אוכלת בשר",
      evidence: [{ messageId: 7, stance: "supports" }],
    });
  });

  it("refuses a candidate whose author has no identity, rather than guessing one", () => {
    // The alternative considered and rejected on #95: file it as `episodic`,
    // whose subject is nullable. That keeps the row by calling a fact about a
    // person an event, which corrupts the one thing four tables exist to say.
    expect(
      toSemanticDraft({ sourceMessageId: 7, content: "x" }, shown({ senderJid: null }), 3),
    ).toBe(null);
  });

  it("refuses a candidate citing a message it was never shown", () => {
    // The validator already rejects an invented id; this is the second line, and
    // it is the one that holds if a future caller forgets to validate first.
    expect(toSemanticDraft({ sourceMessageId: 999, content: "x" }, shown(), 3)).toBe(null);
  });

  it("cites the message as supporting — the prompt cannot express contradiction", () => {
    const draft = toSemanticDraft({ sourceMessageId: 7, content: "y" }, shown(), 3);
    expect(draft?.evidence).toEqual([{ messageId: 7, stance: "supports" }]);
  });
});
