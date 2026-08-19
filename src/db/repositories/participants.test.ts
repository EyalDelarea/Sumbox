/**
 * participants.test.ts — Testcontainers coverage for the two roster queries:
 * listGroupParticipants (the "who's in this chat" roster the agent gets, derived
 * from message volume, device-owner excluded) and participantNamesForBiasing
 * (the STT hotword roster — symmetric, device-owner INCLUDED, JIDs/Unknown out).
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import { insertMessages } from "./messages.js";
import {
  listGroupParticipants,
  participantNamesForBiasing,
  upsertParticipant,
} from "./participants.js";

function msg(
  groupId: number,
  participantId: number,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage & { participantId: number } {
  return {
    groupId,
    importId: null,
    source: "import",
    senderName: "x",
    messageType: "text",
    textContent: "hi",
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    sentAt: new Date("2026-05-01T10:00:00.000Z"),
    dedupeKey: `pk-${Math.random()}`,
    externalId: null,
    fromMe: null,
    participantId,
    ...overrides,
  };
}

describe("listGroupParticipants", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns active people ordered by message volume, excluding from_me", async () => {
    const groupId = await upsertGroup(pool, { name: `roster-${Math.random()}`, source: "import" });
    const alon = await upsertParticipant(pool, `אלון-${Math.random()}`);
    const bar = await upsertParticipant(pool, `בר-${Math.random()}`);
    const me = await upsertParticipant(pool, `אני-${Math.random()}`);

    await insertMessages(pool, [
      msg(groupId, alon),
      msg(groupId, alon),
      msg(groupId, alon),
      msg(groupId, bar),
      msg(groupId, me, { fromMe: true }), // the device owner — excluded from the roster
    ]);

    const roster = await listGroupParticipants(pool, groupId);
    expect(roster.map((p) => p.messageCount)).toEqual([3, 1]); // most-active first
    expect(roster[0]?.messageCount).toBe(3);
    expect(roster.some((p) => p.name.startsWith("אני-"))).toBe(false); // from_me excluded
  });

  it("respects the limit", async () => {
    const groupId = await upsertGroup(pool, { name: `roster2-${Math.random()}`, source: "import" });
    for (let i = 0; i < 4; i++) {
      const pid = await upsertParticipant(pool, `p${i}-${Math.random()}`);
      await insertMessages(pool, [msg(groupId, pid)]);
    }
    expect(await listGroupParticipants(pool, groupId, 2)).toHaveLength(2);
  });

  // The @Aida roster needs the OWNER: PEOPLE-SAFETY's member branch is what lets
  // her answer about people in the group, and the owner is both a member and the
  // single most-asked-about person in the corpus ("does Eyal abuse anyone?" is a
  // committed red-team probe). Measured on the real DB, the owner stores as a
  // plain display_name ("Eyal Delarea"), so including him needs no special label.
  it("includes the device owner when includeOwner is set", async () => {
    const groupId = await upsertGroup(pool, { name: `roster3-${Math.random()}`, source: "import" });
    const alon = await upsertParticipant(pool, `אלון-${Math.random()}`);
    const owner = await upsertParticipant(pool, `בעלים-${Math.random()}`);

    await insertMessages(pool, [
      msg(groupId, alon),
      msg(groupId, owner, { fromMe: true }),
      msg(groupId, owner, { fromMe: true }),
    ]);

    const without = await listGroupParticipants(pool, groupId);
    expect(without.some((p) => p.name.startsWith("בעלים-"))).toBe(false);

    const withOwner = await listGroupParticipants(pool, groupId, 15, { includeOwner: true });
    expect(withOwner.some((p) => p.name.startsWith("בעלים-"))).toBe(true);
    // Owner sent 2, alon 1 — still ordered by volume, owner not special-cased.
    expect(withOwner[0]?.name.startsWith("בעלים-")).toBe(true);
    expect(withOwner.map((p) => p.messageCount)).toEqual([2, 1]);
  });

  // Measured on the real DB: EVERY group @Aida serves carries exactly one
  // JID-shaped display_name, and in group 70 that row is the single highest-volume
  // "sender" (the group's own @g.us jid, 5855 messages) — it would top the roster
  // and read to the model as the most active member of the chat.
  it("excludes JID-shaped and Unknown names", async () => {
    const groupId = await upsertGroup(pool, { name: `roster4-${Math.random()}`, source: "import" });
    const real = await upsertParticipant(pool, `דנה-${Math.random()}`);
    const groupJid = await upsertParticipant(pool, `12036340656732${Math.random()}@g.us`);
    const phoneJid = await upsertParticipant(pool, `9725012345${Math.random()}@s.whatsapp.net`);
    const unknown = await upsertParticipant(pool, "Unknown");

    await insertMessages(pool, [
      msg(groupId, real),
      // Every junk row out-volumes the real person, so a missing filter is loud.
      ...Array.from({ length: 5 }, () => msg(groupId, groupJid)),
      ...Array.from({ length: 4 }, () => msg(groupId, phoneJid)),
      ...Array.from({ length: 3 }, () => msg(groupId, unknown)),
    ]);

    const roster = await listGroupParticipants(pool, groupId, 15, { includeOwner: true });
    expect(roster.map((p) => p.name.replace(/-[\d.]+$/, ""))).toEqual(["דנה"]);
  });

  it("returns an empty roster for a group with no real names", async () => {
    const groupId = await upsertGroup(pool, { name: `roster5-${Math.random()}`, source: "import" });
    const groupJid = await upsertParticipant(pool, `12036340656733${Math.random()}@g.us`);
    await insertMessages(pool, [msg(groupId, groupJid)]);

    expect(await listGroupParticipants(pool, groupId, 15, { includeOwner: true })).toEqual([]);
  });
});

describe("participantNamesForBiasing", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("includes the device owner (symmetric) and drops JIDs / Unknown", async () => {
    const groupId = await upsertGroup(pool, { name: `bias-${Math.random()}`, source: "import" });
    const bar = await upsertParticipant(pool, `בר-${Math.random()}`);
    const me = await upsertParticipant(pool, `אייל-${Math.random()}`);
    const jid = await upsertParticipant(pool, `972500000044@s.whatsapp.net`);
    const unknown = await upsertParticipant(pool, "Unknown");

    const { ids } = await insertMessages(pool, [
      msg(groupId, bar),
      msg(groupId, me, { fromMe: true }), // self — MUST be present, unlike the agent roster
      msg(groupId, jid),
      msg(groupId, unknown),
    ]);

    const names = await participantNamesForBiasing(pool, ids[0]!);
    expect(names.some((n) => n.startsWith("אייל-"))).toBe(true); // self included
    expect(names.some((n) => n.startsWith("בר-"))).toBe(true);
    expect(names.some((n) => n.includes("@"))).toBe(false); // raw JID dropped
    expect(names).not.toContain("Unknown"); // placeholder dropped
  });

  it("returns [] for a message whose group has no real names", async () => {
    const groupId = await upsertGroup(pool, { name: `bias2-${Math.random()}`, source: "import" });
    const jid = await upsertParticipant(pool, `972500000000@s.whatsapp.net`);
    const { ids } = await insertMessages(pool, [msg(groupId, jid)]);
    expect(await participantNamesForBiasing(pool, ids[0]!)).toEqual([]);
  });
});
