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
import { recordLink } from "./identity-links.js";
import { insertMessages } from "./messages.js";
import {
  displayNamesForJids,
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

/**
 * Turning a stored identity back into a person's name — what the memories screen
 * needs before it can say who a belief is about.
 *
 * The case that matters is the one where the bridge is MISSING: 68% of the lids
 * in the live corpus were unlinked when this was written, and a resolver that
 * crashed or leaked a raw JID there would have shipped looking fine on the one
 * fully-linked group it was developed against.
 */
describe("displayNamesForJids", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function spoke(name: string, jid: string, at = "2026-05-01T10:00:00.000Z") {
    const g = await upsertGroup(pool, { name: `n-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, name);
    await insertMessages(pool, [msg(g, p, { senderJid: jid, sentAt: new Date(at) })]);
    return g;
  }

  it("finds the name across the bridge, where the stored form has none of its own", async () => {
    // The real shape: the belief is filed against the PHONE jid, and every
    // message carrying a name arrived under the lid.
    const lid = "4578552635558@lid";
    const pn = "972542795343@s.whatsapp.net";
    await spoke("Royi", lid);
    await recordLink(pool, { lidJid: lid, pnJid: pn, source: "bridge" });

    expect((await displayNamesForJids(pool, [pn])).get(pn)).toBe("Royi");
  });

  it("falls back to the phone number when the bridge is missing, never a raw JID", async () => {
    const orphan = "972500000077@s.whatsapp.net";
    expect((await displayNamesForJids(pool, [orphan])).get(orphan)).toBe("+972500000077");
  });

  it("labels an unbridged lid as an unknown participant rather than leaking it", async () => {
    const lid = "999888777666@lid";
    const label = (await displayNamesForJids(pool, [lid])).get(lid);
    expect(label).not.toContain("@lid");
    expect(label).toBe("משתתף לא ידוע");
  });

  it("never labels a subject with a placeholder participant row", async () => {
    // The JID-shaped participant every unresolved sender collapses onto, and the
    // Unknown row — the two the author rule exists to reject.
    const jid = "972500000055@s.whatsapp.net";
    await spoke("120363406567322025@g.us", jid);
    await spoke("Unknown", jid);
    expect((await displayNamesForJids(pool, [jid])).get(jid)).toBe("+972500000055");
  });

  it("prefers the most recent name, because push names change", async () => {
    const jid = "972500000066@s.whatsapp.net";
    await spoke("Old Name", jid, "2026-05-01T10:00:00.000Z");
    await spoke("New Name", jid, "2026-06-01T10:00:00.000Z");
    expect((await displayNamesForJids(pool, [jid])).get(jid)).toBe("New Name");
  });

  it("labels every jid it was asked about, in one query", async () => {
    const known = "972500000088@s.whatsapp.net";
    await spoke("דנה", known);
    const labels = await displayNamesForJids(pool, [known, "972500000099@s.whatsapp.net", "  "]);
    expect([...labels.keys()]).toHaveLength(2);
    expect(labels.get(known)).toBe("דנה");
    expect(labels.get("972500000099@s.whatsapp.net")).toBe("+972500000099");
  });

  it("asks nothing when there is nothing to ask about", async () => {
    expect(await displayNamesForJids(pool, [])).toEqual(new Map());
  });
});
