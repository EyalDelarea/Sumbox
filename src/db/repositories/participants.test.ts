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
    const jid = await upsertParticipant(pool, `972523893791@s.whatsapp.net`);
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
