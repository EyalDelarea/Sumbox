import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAidaMessage } from "../db/repositories/aida-messages.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { listGroupParticipants, upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import {
  buildExtractionPrompt,
  buildExtractionWindow,
  buildSubjectIndex,
  type CandidateMessage,
  isIdentifiableAuthor,
  parseCandidates,
  selectCandidates,
  subjectKey,
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

  // The empty string is not null, and on this data it is the COMMON case: 2157
  // messages carry `sender_jid = ''`, every one of them in a 1:1 chat, because
  // the mapper resolves a group's per-message participant key but a DM's is
  // absent. `IS NOT NULL` admits them, so a narrowing written that way narrows
  // nothing on more than half the chats — and every candidate then dies later,
  // in a different counter, with the skip line still reading zero.
  it("treats an empty sender_jid as no identity, exactly as a null one", async () => {
    const g = await upsertGroup(pool, { name: `es-${Math.random()}`, source: "import" });
    const real = await upsertParticipant(pool, `EA-${Math.random()}`);
    const blank = await upsertParticipant(pool, `EB-${Math.random()}`);
    const spaces = await upsertParticipant(pool, `EC-${Math.random()}`);
    await insertMessages(pool, [
      msg(g, real, {
        textContent: "יש לי ג׳יד",
        senderJid: "972500000042@s.whatsapp.net",
        sentAt: new Date("2026-05-01T10:00:00.000Z"),
      }),
      msg(g, blank, {
        textContent: "ג׳יד ריק",
        senderJid: "",
        sentAt: new Date("2026-05-01T11:00:00.000Z"),
      }),
      msg(g, spaces, {
        textContent: "ג׳יד רווחים",
        senderJid: "   ",
        sentAt: new Date("2026-05-01T12:00:00.000Z"),
      }),
    ]);

    const narrow = await selectCandidates(pool, g, SINCE, UNTIL, { requireAuthorIdentity: true });
    expect(narrow.candidates.map((m) => m.content)).toEqual(["יש לי ג׳יד"]);
    // And the count must agree with the narrowing, or the printed skip line
    // contradicts the run it describes.
    expect(narrow.withoutAuthorIdentity).toBe(2);
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

  // The mis-attribution the design calls unrecoverable. In a 1:1 chat the mapper
  // has no per-message participant key and falls back to the chat's remote jid —
  // so the OWNER'S OWN messages carry the other person's identity. Measured live:
  // 36 distinct jids across 923 from_me rows in 1:1 chats, against exactly 1
  // across 783 in group chats. Attributing on those rows would file what Eyal
  // said about himself against whoever he was talking to.
  it("refuses the owner's own messages in a 1:1 chat, where the jid is the other person's", async () => {
    const dm = await upsertGroup(pool, { name: `dm-${Math.random()}`, source: "live" });
    await pool.query(`UPDATE groups SET whatsapp_id = $2 WHERE id = $1`, [
      dm,
      `972500000077@s.whatsapp.net`,
    ]);
    const them = await upsertParticipant(pool, `DM-${Math.random()}`);
    await insertMessages(pool, [
      msg(dm, them, {
        textContent: "אני גר בחיפה",
        senderJid: "972500000077@s.whatsapp.net",
        fromMe: false,
        sentAt: new Date("2026-05-01T10:00:00.000Z"),
      }),
      // Eyal's own message — carrying THEIR jid, which is the bug.
      msg(dm, them, {
        textContent: "אני עובד באינטל",
        senderJid: "972500000077@s.whatsapp.net",
        fromMe: true,
        sentAt: new Date("2026-05-01T11:00:00.000Z"),
      }),
    ]);

    const narrow = await selectCandidates(pool, dm, SINCE, UNTIL, { requireAuthorIdentity: true });
    expect(narrow.candidates.map((m) => m.content)).toEqual(["אני גר בחיפה"]);
    // Counted, and counted SEPARATELY. The narrowing drops rows for two unrelated
    // reasons; a caller reporting only the identity one understates what it left
    // out, which is the skip-line-disagrees-with-the-run bug in a new place.
    expect(narrow.misattributedSelfMessages).toBe(1);
    expect(narrow.withoutAuthorIdentity, "a different reason, a different count").toBe(0);
    // The dry run still sees both — slice 4 can hold them without attributing.
    const wide = await selectCandidates(pool, dm, SINCE, UNTIL);
    expect(wide.candidates).toHaveLength(2);
    // And it is TOLD which of the two carries a jid that is not its author's, so
    // the four-type extractor can keep the message readable while refusing to
    // take an identity from it. Filtering instead would take the row away from
    // episodic memories, which can hold it honestly.
    expect(wide.candidates.map((m) => [m.content, m.jidIsAuthors])).toEqual([
      ["אני גר בחיפה", true],
      ["אני עובד באינטל", false],
    ]);
  });

  // The cap keeps the NEWEST, so widening --hours to reach a backlog drops the
  // oldest — the opposite of what widening it was for. Untested, the flag that
  // says so was wired to the output and never proven to fire.
  it("says when the window held more than the cap allowed, and which end was lost", async () => {
    const g = await upsertGroup(pool, { name: `tr-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `TR-${Math.random()}`);
    await insertMessages(pool, [
      msg(g, p, { textContent: "ישן", sentAt: new Date("2026-05-01T09:00:00.000Z") }),
      msg(g, p, { textContent: "אמצע", sentAt: new Date("2026-05-01T10:00:00.000Z") }),
      msg(g, p, { textContent: "חדש", sentAt: new Date("2026-05-01T11:00:00.000Z") }),
    ]);

    const capped = await selectCandidates(pool, g, SINCE, UNTIL, { limit: 2 });
    expect(capped.truncated).toBe(true);
    expect(
      capped.candidates.map((m) => m.content),
      "the oldest is what falls off",
    ).toEqual(["אמצע", "חדש"]);

    expect((await selectCandidates(pool, g, SINCE, UNTIL, { limit: 3 })).truncated).toBe(false);
  });

  it("keeps the owner's own messages in a GROUP chat, where the jid really is theirs", async () => {
    const grp = await upsertGroup(pool, { name: `gc-${Math.random()}`, source: "live" });
    await pool.query(`UPDATE groups SET whatsapp_id = $2 WHERE id = $1`, [
      grp,
      `120363000000000001@g.us`,
    ]);
    const me = await upsertParticipant(pool, `GC-${Math.random()}`);
    await insertMessages(pool, [
      msg(grp, me, {
        textContent: "אני עובד באינטל",
        senderJid: "972500000099@s.whatsapp.net",
        fromMe: true,
      }),
    ]);
    const narrow = await selectCandidates(pool, grp, SINCE, UNTIL, { requireAuthorIdentity: true });
    expect(narrow.candidates.map((m) => m.content)).toEqual(["אני עובד באינטל"]);
    expect(narrow.candidates[0]?.jidIsAuthors, "in a group the fallback never fires").toBe(true);
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

// The first of #99's two containment rules rests entirely on this map: a subject
// the model names must have spoken in the window, or the belief is refused. What
// is tested here is therefore not a lookup helper — it is who @Aida is allowed to
// form a belief about at all.
describe("buildSubjectIndex", () => {
  function spoke(overrides: Partial<CandidateMessage> = {}): CandidateMessage {
    return {
      messageId: 1,
      sender: "Royi",
      senderJid: "972500000042@s.whatsapp.net",
      jidIsAuthors: true,
      content: "hi",
      sentAt: new Date("2026-05-01T10:00:00.000Z"),
      ...overrides,
    };
  }

  it("indexes a speaker under the label the prompt shows, with the identity behind it", () => {
    const index = buildSubjectIndex([spoke()]);
    expect(index.get(subjectKey("Royi"))).toEqual({
      name: "Royi",
      jids: ["972500000042@s.whatsapp.net"],
    });
  });

  it("has no entry for somebody who never spoke in the window", () => {
    const index = buildSubjectIndex([spoke()]);
    expect(index.get(subjectKey("אחותו של רועי")), "the out-of-room subject").toBeUndefined();
  });

  it("keeps a speaker who left no identity, with an empty one rather than none", () => {
    // Absent and identity-less are two different refusals: the first is a person
    // who was never here, the second is a person who was, and can still be the
    // subject of an episodic memory whose subject column is nullable.
    const index = buildSubjectIndex([spoke({ senderJid: null })]);
    expect(index.get(subjectKey("Royi"))).toEqual({ name: "Royi", jids: [] });
  });

  it("refuses to take an identity from a row whose jid is not its author's", () => {
    // The owner's own message in a 1:1 chat. He spoke, so he is indexed; the jid
    // on the row is the OTHER party's, so it contributes nothing.
    const index = buildSubjectIndex([
      spoke({ sender: "Eyal", senderJid: "972500000077@s.whatsapp.net", jidIsAuthors: false }),
    ]);
    expect(index.get(subjectKey("Eyal"))).toEqual({ name: "Eyal", jids: [] });
  });

  it("collects every distinct identity one label spoke under, once each", () => {
    const index = buildSubjectIndex([
      spoke({ messageId: 1 }),
      spoke({ messageId: 2 }),
      spoke({ messageId: 3, senderJid: "4578552635558@lid" }),
    ]);
    expect(index.get(subjectKey("Royi"))?.jids).toEqual([
      "972500000042@s.whatsapp.net",
      "4578552635558@lid",
    ]);
  });

  // The reachable route to an ambiguous subject. Measured on group 70 every
  // display name maps to exactly one jid, so natural duplication does not occur —
  // but two members aliased to the same preferred name collapse into one entry,
  // and then a belief naming it is about two people.
  it("collapses two members the operator aliased to one name into one ambiguous entry", () => {
    const aliases = new Map([
      ["Royi", "רועי"],
      ["Roy Levi", "רועי"],
    ]);
    const index = buildSubjectIndex(
      [
        spoke({ sender: "Royi" }),
        spoke({ messageId: 2, sender: "Roy Levi", senderJid: "972500000043@s.whatsapp.net" }),
      ],
      aliases,
    );
    expect(index.get(subjectKey("רועי"))?.jids).toEqual([
      "972500000042@s.whatsapp.net",
      "972500000043@s.whatsapp.net",
    ]);
  });

  it("trims a padded jid, so one identity is not indexed as two", () => {
    const index = buildSubjectIndex([
      spoke(),
      spoke({ messageId: 2, senderJid: " 972500000042@s.whatsapp.net " }),
    ]);
    expect(index.get(subjectKey("Royi"))?.jids).toEqual(["972500000042@s.whatsapp.net"]);
  });

  it("finds a name the model retyped with different case or spacing", () => {
    const index = buildSubjectIndex([spoke({ sender: "Alex Goldin" })]);
    expect(index.get(subjectKey("  alex   goldin "))?.name).toBe("Alex Goldin");
  });
});

// #99's two containment rules, which is to say: what @Aida may believe about
// somebody who is not the person speaking. Both are tested against candidates the
// prompt could really return, including the two shapes measured on the real group
// — a subject who was never in the room, and a private claim about a third party
// that one person made once.
//
// Nothing here asserts prompt wording. The prompt is the thing this slice exists
// to stop relying on.
describe("validateCandidate", () => {
  const ROYI = "4578552635558@lid";
  const ALEX = "160782268526832@lid";
  const EYAL = "17699644170401@lid";

  function said(
    messageId: number,
    sender: string,
    senderJid: string | null,
    content = "…",
  ): CandidateMessage {
    return {
      messageId,
      sender,
      senderJid,
      jidIsAuthors: true,
      content,
      sentAt: new Date("2026-05-01T10:00:00.000Z"),
    };
  }

  // Three people, each having spoken once.
  const window = buildExtractionWindow([
    said(1, "Royi", ROYI, "אני מתחיל תואר שני בסתיו"),
    said(2, "Alex Goldin", ALEX, "רועי כל הזמן מתלונן על הלימודים"),
    said(3, "Eyal", EYAL, "כן, רועי מדבר על זה כל הזמן"),
  ]);

  const claim = { type: "semantic", content: "לומד לתואר שני", subjects: ["Royi"] };

  it("accepts a self-statement on one citation", () => {
    // The subject IS the author of the message cited: a report, not an assertion.
    const { ok } = validateCandidate({ ...claim, sourceMessageIds: [1] }, window);
    expect(ok?.memoryType).toBe("semantic");
    expect(ok?.subjects.map((s) => s.name)).toEqual(["Royi"]);
    expect(ok?.citations).toEqual([1]);
  });

  it("refuses the same claim, once the subject is somebody other than the speaker", () => {
    // Identical words, identical citation. What changed is how far it reaches.
    const { ok, reason } = validateCandidate(
      { ...claim, subjects: ["Alex Goldin"], sourceMessageIds: [1] },
      window,
    );
    expect(ok).toBeNull();
    expect(reason).toBe("uncorroborated");
  });

  it("refuses two citations from the same person — that is one voice, twice", () => {
    const window2 = buildExtractionWindow([
      said(1, "Royi", ROYI),
      said(2, "Alex Goldin", ALEX),
      said(4, "Alex Goldin", ALEX),
    ]);
    const { ok, reason } = validateCandidate({ ...claim, sourceMessageIds: [2, 4] }, window2);
    expect(ok).toBeNull();
    expect(reason).toBe("uncorroborated");
  });

  it("accepts a claim about somebody else once two different people have said it", () => {
    const { ok } = validateCandidate({ ...claim, sourceMessageIds: [2, 3] }, window);
    expect(ok?.citations).toEqual([2, 3]);
  });

  it("counts the subject's own words as one of the two voices", () => {
    // Someone confirming what is said about them is the strongest corroboration
    // there is; a rule that excluded the subject would refuse exactly that.
    const { ok } = validateCandidate({ ...claim, sourceMessageIds: [1, 2] }, window);
    expect(ok?.citations).toEqual([1, 2]);
  });

  it("cannot be cleared by citing one message twice", () => {
    const { ok, reason } = validateCandidate(
      { ...claim, subjects: ["Alex Goldin"], sourceMessageIds: [1, 1] },
      window,
    );
    expect(ok).toBeNull();
    expect(reason, "the cheapest possible way around the bar").toBe("uncorroborated");
  });

  // Measured on group 70: one of the five accepted memories was about a person
  // who is not in the chat at all, reconstructed from other people discussing
  // them. There is no identity to file it against and no way for them to argue
  // with it.
  it("refuses a subject who never spoke in this window", () => {
    const { ok, reason } = validateCandidate(
      { ...claim, subjects: ["אחותו של רועי"], sourceMessageIds: [2, 3] },
      window,
    );
    expect(ok).toBeNull();
    expect(reason).toBe("unknown-subject");
  });

  it("resolves a subject the model retyped in a different rendering", () => {
    const { ok } = validateCandidate(
      { ...claim, subjects: ["  alex   GOLDIN "], sourceMessageIds: [1, 3] },
      window,
    );
    expect(
      ok?.subjects.map((s) => s.name),
      "canonical label, not the retyping",
    ).toEqual(["Alex Goldin"]);
  });

  it("holds a relational memory to two voices, like any claim about somebody else", () => {
    const relational = {
      type: "relational",
      content: "רועי ואלכס מתכננים דברים ביחד",
      subjects: ["Royi", "Alex Goldin"],
    };
    expect(validateCandidate({ ...relational, sourceMessageIds: [1] }, window).reason).toBe(
      "uncorroborated",
    );
    expect(
      validateCandidate({ ...relational, sourceMessageIds: [1, 2] }, window).ok,
    ).not.toBeNull();
  });

  it("refuses a relationship whose two subjects are the same person", () => {
    const { ok, reason } = validateCandidate(
      {
        type: "relational",
        content: "רועי ורועי",
        subjects: ["Royi", "royi"],
        sourceMessageIds: [1, 2],
      },
      window,
    );
    expect(ok).toBeNull();
    expect(reason, "a relationship between one person is not a relationship").toBe(
      "wrong-subject-count",
    );
  });

  it("holds what she believes about herself to two voices too", () => {
    const self = { type: "self_state", facet: "behaviour", content: "לענות בקצרה" };
    expect(validateCandidate({ ...self, sourceMessageIds: [1] }, window).reason).toBe(
      "uncorroborated",
    );
    const { ok } = validateCandidate({ ...self, sourceMessageIds: [1, 2] }, window);
    expect(ok?.facet).toBe("behaviour");
    expect(ok?.subjects, "a belief about her is about nobody in the room").toEqual([]);
  });

  // The hole the first real run walked through. #99 gave a subject-less episodic
  // memory the one-citation path, on the reasoning that an event about the group
  // is nobody's private life. Measured on group 70, the extractor's fourth
  // candidate was `episodic`, `subjects: []`, one citation, and its content was a
  // private conflict between two named people — one of whom never spoke in the
  // window. Declaring no subject and naming them in the PROSE walks past both
  // rules at once.
  it("refuses an event that declared no subject on one voice, and takes it on two", () => {
    const event = { type: "episodic", content: "הקבוצה תכננה מפגש", subjects: [] };
    expect(validateCandidate({ ...event, sourceMessageIds: [1] }, window).reason).toBe(
      "uncorroborated",
    );
    const { ok } = validateCandidate({ ...event, sourceMessageIds: [1, 2] }, window);
    expect(ok?.memoryType, "a real group event is discussed by more than one person").toBe(
      "episodic",
    );
    expect(ok?.subjects).toEqual([]);
  });

  it("refuses the private matter the real run smuggled past as a subject-less event", () => {
    const smuggled = {
      type: "episodic",
      subjects: [],
      content: "היה עימות בפרטי בין שני אנשים",
      sourceMessageIds: [2],
    };
    expect(validateCandidate(smuggled, window).reason).toBe("uncorroborated");
  });

  it("refuses an invented citation, and counts it as its own thing", () => {
    // Measured on the four-type probe: 2 of 5 accepted memories cited ids that do
    // not exist. Kept separate from `uncorroborated` because they are different
    // failures — one is the model hallucinating, the other is it repeating gossip.
    expect(validateCandidate({ ...claim, sourceMessageIds: [999] }, window).reason).toBe(
      "invented-id",
    );
    expect(validateCandidate({ ...claim, sourceMessageIds: [1, 999] }, window).reason).toBe(
      "invented-id",
    );
  });

  // A candidate can fail several rules at once, and the real corpus produces
  // exactly that. The order is fixed — citations, then subjects, then
  // corroboration — so the citation rate stays comparable to the number measured
  // on #83 and everything after it reads as a floor.
  it("counts the first failure only, in a fixed order", () => {
    const both = { ...claim, subjects: ["מישהי שלא כאן"], sourceMessageIds: [999] };
    expect(validateCandidate(both, window).reason).toBe("invented-id");
    const subjectAndBar = { ...claim, subjects: ["מישהי שלא כאן"], sourceMessageIds: [1] };
    expect(validateCandidate(subjectAndBar, window).reason).toBe("unknown-subject");
  });

  it("distinguishes its rejection reasons", () => {
    expect(validateCandidate("nope", window).reason).toBe("not-an-object");
    expect(
      validateCandidate({ ...claim, type: "gossip", sourceMessageIds: [1] }, window).reason,
    ).toBe("bad-type");
    expect(
      validateCandidate({ type: "self_state", content: "x", sourceMessageIds: [1, 2] }, window)
        .reason,
    ).toBe("bad-facet");
    expect(validateCandidate({ ...claim, sourceMessageIds: ["x"] }, window).reason).toBe("bad-id");
    expect(validateCandidate({ ...claim, sourceMessageIds: [] }, window).reason).toBe(
      "no-citations",
    );
    // Absent, not empty. A model that stopped citing at all must not read in the
    // counters as one citing something unparseable.
    expect(validateCandidate({ ...claim }, window).reason).toBe("no-citations");
    expect(
      validateCandidate({ ...claim, content: "  ", sourceMessageIds: [1] }, window).reason,
    ).toBe("empty-content");
    expect(
      validateCandidate({ ...claim, content: "x".repeat(501), sourceMessageIds: [1] }, window)
        .reason,
    ).toBe("too-long");
    expect(
      validateCandidate({ ...claim, subjects: [], sourceMessageIds: [1] }, window).reason,
    ).toBe("wrong-subject-count");
  });

  it("takes both spellings of behaviour, and one id outside an array", () => {
    // Small models produce both constantly, and refusing over an American 'o'
    // would show up in the counters as a containment refusal.
    const { ok } = validateCandidate(
      { type: "self_state", facet: "behavior", content: "x", sourceMessageIds: [1, 2] },
      window,
    );
    expect(ok?.facet).toBe("behaviour");
    expect(validateCandidate({ ...claim, sourceMessageIds: 1 }, window).ok?.citations).toEqual([1]);
  });

  // The two rows measured on group 70 that #99 exists to refuse. Neither rule
  // claims to detect harm — both were single-sourced claims about someone other
  // than the speaker, and that is what they are refused for.
  it("refuses the two shapes measured on the real group", () => {
    const outOfRoom = {
      type: "semantic",
      content: "יש לה סכסוך עם המשפחה",
      subjects: ["אמא של אלכס"],
      sourceMessageIds: [2],
    };
    expect(validateCandidate(outOfRoom, window).reason).toBe("unknown-subject");

    const singleSourced = {
      type: "relational",
      content: "רועי ואלכס הסכימו לא לספר לאייל",
      subjects: ["Royi", "Alex Goldin"],
      sourceMessageIds: [2],
    };
    expect(validateCandidate(singleSourced, window).reason).toBe("uncorroborated");
  });
});

// One name-space, pinned. The prompt shows a label and the index resolves one; if
// they ever disagree every subject fails rule one at once and the run reports a
// room nobody spoke in — a containment refusal that is really a rendering bug.
// Three name-spaces that disagreed is how #67's guardrail bugs shipped.
describe("the prompt's labels and the subject index", () => {
  it("names people in the one name-space subjects resolve through", () => {
    const aliases = new Map([["Dana Cohen", "דנה"]]);
    const messages: CandidateMessage[] = [
      {
        messageId: 12,
        sender: "Dana Cohen",
        senderJid: "972500000042@s.whatsapp.net",
        jidIsAuthors: true,
        content: "אני עוברת לחיפה",
        sentAt: new Date("2026-05-01T10:00:00.000Z"),
      },
    ];
    const prompt = buildExtractionPrompt(messages, aliases);
    const label = prompt.match(/^\[12\] (.+?): /m)?.[1];

    expect(label, "the operator's rendering, not the raw push name").toBe("דנה");
    const window = buildExtractionWindow(messages, aliases);
    expect(
      validateCandidate(
        { type: "semantic", subjects: [label], content: "עוברת לחיפה", sourceMessageIds: [12] },
        window,
      ).ok,
      "a subject copied straight off the prompt must resolve",
    ).not.toBeNull();
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
