import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { buildGroupRoster } from "./roster.js";

/** Same shape as participants.test.ts's helper — the messages table requires
 *  dedupe_key, so this mirrors the canonical fixture rather than reinventing it. */
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

describe("buildGroupRoster", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("names the owner and the members, most active first, with no JIDs", async () => {
    const groupId = await upsertGroup(pool, { name: `r-${Math.random()}`, source: "import" });
    const royi = await upsertParticipant(pool, `Royi-${Math.random()}`);
    const owner = await upsertParticipant(pool, `Owner-${Math.random()}`);
    const junk = await upsertParticipant(pool, `12036340${Math.random()}@g.us`);

    await insertMessages(pool, [
      ...Array.from({ length: 3 }, () => msg(groupId, royi)),
      ...Array.from({ length: 2 }, () => msg(groupId, owner, { fromMe: true })),
      // Out-volumes everyone: on the live DB the group's own jid has 5855 rows,
      // so a missing filter would put it at the head of the roster.
      ...Array.from({ length: 9 }, () => msg(groupId, junk)),
    ]);

    const roster = await buildGroupRoster(pool, groupId);
    expect(roster.some((n) => n.includes("@"))).toBe(false);
    expect(roster[0]?.startsWith("Royi-")).toBe(true);
    expect(roster.some((n) => n.startsWith("Owner-"))).toBe(true);
  });

  // The whole feature degrades to inert if this returns [] — and an empty roster
  // has NO user-visible symptom (she keeps answering, just never as a member).
  // This repo has shipped inert features twice for exactly that reason, so the
  // empty case is pinned rather than assumed.
  it("returns an empty roster for a group with no real names", async () => {
    const groupId = await upsertGroup(pool, { name: `r2-${Math.random()}`, source: "import" });
    const junk = await upsertParticipant(pool, `12036341${Math.random()}@g.us`);
    await insertMessages(pool, [msg(groupId, junk)]);
    expect(await buildGroupRoster(pool, groupId)).toEqual([]);
  });

  it("propagates a query failure instead of silently returning an empty roster", async () => {
    // Callers decide how to handle it; the builder must not decide for them by
    // swallowing. The sandbox verifier and the doctor check both depend on this.
    const broken = { query: () => Promise.reject(new Error("db down")) } as unknown as pg.Pool;
    await expect(buildGroupRoster(broken, 1)).rejects.toThrow("db down");
  });
});
