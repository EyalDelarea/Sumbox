import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import {
  isDisplayNameUnresolved,
  listGroups,
  listUnresolvedGroups,
  representativeSenderName,
  updateDisplayName,
  upsertGroup,
  upsertGroupByCanonicalJid,
  upsertGroupByWhatsappId,
} from "./groups.js";
import { insertMessages } from "./messages.js";
import { upsertParticipant } from "./participants.js";

function makeMsg(
  groupId: number,
  dedupeKey: string,
  sentAt: Date,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage & { participantId: number | null } {
  return {
    groupId,
    importId: null,
    source: "import",
    senderName: "Alice",
    messageType: "text",
    textContent: "Hello",
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    externalId: null,
    sentAt,
    dedupeKey,
    participantId: null,
    ...overrides,
  };
}

describe("listGroups — lastMessageAt (T015)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns lastMessageAt as the newest message's sent_at", async () => {
    const groupId = await upsertGroup(pool, { name: "LMA-group-a", source: "import" });

    const older = new Date("2026-01-01T09:00:00Z");
    const newer = new Date("2026-01-02T15:30:00Z");

    await insertMessages(pool, [
      makeMsg(groupId, "lma-a-001", older),
      makeMsg(groupId, "lma-a-002", newer),
    ]);

    const groups = await listGroups(pool);
    const g = groups.find((x) => x.name === "LMA-group-a");
    expect(g).toBeDefined();
    expect(g!.lastMessageAt).not.toBeNull();
    // Compare via ISO string to avoid timezone noise
    expect(g!.lastMessageAt!.toISOString()).toBe(newer.toISOString());
  });

  it("returns lastMessageAt as null for a group with no messages", async () => {
    await upsertGroup(pool, { name: "LMA-empty-group", source: "import" });
    const groups = await listGroups(pool);
    const g = groups.find((x) => x.name === "LMA-empty-group");
    expect(g).toBeDefined();
    expect(g!.lastMessageAt).toBeNull();
  });

  it("existing fields (name, source, messageCount) remain intact (backward-compat)", async () => {
    const groupId = await upsertGroup(pool, { name: "LMA-compat-group", source: "import" });
    await insertMessages(pool, [
      makeMsg(groupId, "lma-compat-001", new Date("2026-03-01T10:00:00Z")),
      makeMsg(groupId, "lma-compat-002", new Date("2026-03-02T10:00:00Z")),
    ]);
    const groups = await listGroups(pool);
    const g = groups.find((x) => x.name === "LMA-compat-group");
    expect(g).toBeDefined();
    expect(g!.source).toBe("import");
    expect(g!.messageCount).toBe(2);
    // lastMessageAt should also be present
    expect(g!.lastMessageAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listGroups — summaryPreview (issue #13: surface the cached catch-up summary
// on the Updates cards, folded into the one /api/groups query)
// ---------------------------------------------------------------------------

describe("listGroups — summaryPreview (#13)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function insertSummaryRow(
    groupId: number,
    summaryType: "watermark" | "last_n" | "since",
    output: Record<string, unknown>,
    createdAt: Date,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO summaries (group_id, summary_type, parameters, output, model, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [groupId, summaryType, "{}", JSON.stringify(output), "test-model", createdAt],
    );
  }

  it("returns null when the group has no summaries", async () => {
    await upsertGroup(pool, { name: "sp-none", source: "import" });
    const g = (await listGroups(pool)).find((x) => x.name === "sp-none");
    expect(g).toBeDefined();
    expect(g!.summaryPreview).toBeNull();
  });

  it("surfaces the latest watermark summary's TL;DR", async () => {
    const groupId = await upsertGroup(pool, { name: "sp-tldr", source: "import" });
    await insertSummaryRow(
      groupId,
      "watermark",
      {
        version: 2,
        overview: "## תקציר\nתמצית מלאה",
        tldr: "התקבלה החלטה לארגן טיול",
        topics: [],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      },
      new Date("2026-05-01T10:00:00Z"),
    );
    const g = (await listGroups(pool)).find((x) => x.name === "sp-tldr");
    expect(g!.summaryPreview).toBe("התקבלה החלטה לארגן טיול");
  });

  it("derives a preview from the overview when a row predates the TL;DR field", async () => {
    const groupId = await upsertGroup(pool, { name: "sp-legacy", source: "import" });
    await insertSummaryRow(
      groupId,
      "watermark",
      { overview: "## תקציר\nשיחה על ועד הבית." },
      new Date("2026-05-01T10:00:00Z"),
    );
    const g = (await listGroups(pool)).find((x) => x.name === "sp-legacy");
    expect(g!.summaryPreview).toBe("שיחה על ועד הבית.");
  });

  it("prefers the newest watermark summary", async () => {
    const groupId = await upsertGroup(pool, { name: "sp-newest", source: "import" });
    await insertSummaryRow(
      groupId,
      "watermark",
      {
        version: 2,
        overview: "x",
        tldr: "ישן",
        topics: [],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      },
      new Date("2026-05-01T10:00:00Z"),
    );
    await insertSummaryRow(
      groupId,
      "watermark",
      {
        version: 2,
        overview: "y",
        tldr: "חדש",
        topics: [],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      },
      new Date("2026-05-02T10:00:00Z"),
    );
    const g = (await listGroups(pool)).find((x) => x.name === "sp-newest");
    expect(g!.summaryPreview).toBe("חדש");
  });

  it("ignores non-watermark summaries (only the catch-up summary previews)", async () => {
    const groupId = await upsertGroup(pool, { name: "sp-nonwatermark", source: "import" });
    await insertSummaryRow(
      groupId,
      "last_n",
      {
        version: 2,
        overview: "z",
        tldr: "לא אמור להופיע",
        topics: [],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      },
      new Date("2026-05-01T10:00:00Z"),
    );
    const g = (await listGroups(pool)).find((x) => x.name === "sp-nonwatermark");
    expect(g!.summaryPreview).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T019 — updateDisplayName + isDisplayNameUnresolved
// ---------------------------------------------------------------------------

describe("updateDisplayName + isDisplayNameUnresolved (T019)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("updateDisplayName returns true and renames when name == whatsapp_id (still the raw JID)", async () => {
    const jid = "dn-test-001@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const result = await updateDisplayName(pool, jid, "My Group");

    expect(result).toBe(true);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("My Group");
  });

  it("updateDisplayName returns false (no-op) when name was already changed from the JID", async () => {
    const jid = "dn-test-002@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });
    // Rename it first
    await updateDisplayName(pool, jid, "Already Named");

    // Second call with a different name should be a no-op
    const result = await updateDisplayName(pool, jid, "Should Not Apply");

    expect(result).toBe(false);

    // Name should remain "Already Named"
    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("Already Named");
  });

  it("updateDisplayName round-trips: stored name equals the new display name after update", async () => {
    const jid = "dn-test-003@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    await updateDisplayName(pool, jid, "Round-Trip Name");

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("Round-Trip Name");
  });

  it("isDisplayNameUnresolved returns true when name == whatsapp_id (still the raw JID)", async () => {
    const jid = "dn-unresolved-001@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const unresolved = await isDisplayNameUnresolved(pool, jid);
    expect(unresolved).toBe(true);
  });

  it("isDisplayNameUnresolved returns false after the name has been changed from the JID", async () => {
    const jid = "dn-unresolved-002@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });
    await updateDisplayName(pool, jid, "Resolved Name");

    const unresolved = await isDisplayNameUnresolved(pool, jid);
    expect(unresolved).toBe(false);
  });

  it("isDisplayNameUnresolved returns false when the group does not exist", async () => {
    const unresolved = await isDisplayNameUnresolved(pool, "nonexistent@g.us");
    expect(unresolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// upsertGroupByCanonicalJid — route-to-existing identity canonicalization (#17)
// ---------------------------------------------------------------------------

describe("upsertGroupByCanonicalJid", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function countByJid(jid: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM groups WHERE whatsapp_id = $1`,
      [jid],
    );
    return Number(rows[0]!.n);
  }

  it("returns the existing row (keyed on primaryJid) when one already exists", async () => {
    const primary = "cj-primary-001@s.whatsapp.net";
    const sibling = "cj-sibling-001@lid";
    const existingId = await upsertGroupByWhatsappId(pool, {
      whatsappId: primary,
      name: primary,
      source: "live",
    });

    const { groupId, canonicalJid } = await upsertGroupByCanonicalJid(pool, {
      primaryJid: primary,
      siblingJid: sibling,
      name: primary,
      source: "live",
    });

    expect(groupId).toBe(existingId);
    expect(canonicalJid).toBe(primary);
    // No row was created under the sibling identity.
    expect(await countByJid(sibling)).toBe(0);
  });

  it("routes into the existing SIBLING row when the primary identity has no row (no duplicate)", async () => {
    // The person's chat already exists under @lid (named survivor). A message now
    // arrives under their @s.whatsapp.net identity, which has no row yet.
    const sibling = "cj-survivor-002@lid";
    const primary = "cj-newcomer-002@s.whatsapp.net";
    const survivorId = await upsertGroupByWhatsappId(pool, {
      whatsappId: sibling,
      name: sibling,
      source: "live",
    });
    await updateDisplayName(pool, sibling, "Noa");

    const { groupId, canonicalJid } = await upsertGroupByCanonicalJid(pool, {
      primaryJid: primary,
      siblingJid: sibling,
      name: primary,
      source: "live",
    });

    // Routed into the survivor — no new duplicate group under the phone JID.
    expect(groupId).toBe(survivorId);
    expect(canonicalJid).toBe(sibling);
    expect(await countByJid(primary)).toBe(0);
    // Survivor keeps its resolved name.
    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [sibling]);
    expect(rows[0].name).toBe("Noa");
  });

  it("creates a new row keyed on primaryJid when neither identity has a row", async () => {
    const primary = "cj-fresh-003@s.whatsapp.net";
    const sibling = "cj-fresh-003@lid";

    const { groupId, canonicalJid } = await upsertGroupByCanonicalJid(pool, {
      primaryJid: primary,
      siblingJid: sibling,
      name: primary,
      source: "live",
    });

    expect(typeof groupId).toBe("number");
    expect(canonicalJid).toBe(primary);
    expect(await countByJid(primary)).toBe(1);
    expect(await countByJid(sibling)).toBe(0);
  });

  it("creates a new row when there is no sibling identity (siblingJid null, e.g. @g.us)", async () => {
    const primary = "cj-group-004@g.us";

    const { groupId, canonicalJid } = await upsertGroupByCanonicalJid(pool, {
      primaryJid: primary,
      siblingJid: null,
      name: primary,
      source: "live",
    });

    expect(typeof groupId).toBe("number");
    expect(canonicalJid).toBe(primary);
    expect(await countByJid(primary)).toBe(1);
  });

  it("prefers the primary row over the sibling when BOTH exist (deterministic routing)", async () => {
    // An un-merged pair. Ingest must route deterministically to one — the primary
    // (the identity the message arrived under) — rather than spawning a third row.
    const primary = "cj-both-005@s.whatsapp.net";
    const sibling = "cj-both-005@lid";
    const primaryId = await upsertGroupByWhatsappId(pool, {
      whatsappId: primary,
      name: primary,
      source: "live",
    });
    await upsertGroupByWhatsappId(pool, { whatsappId: sibling, name: sibling, source: "live" });

    const { groupId, canonicalJid } = await upsertGroupByCanonicalJid(pool, {
      primaryJid: primary,
      siblingJid: sibling,
      name: primary,
      source: "live",
    });

    expect(groupId).toBe(primaryId);
    expect(canonicalJid).toBe(primary);
  });
});

// ---------------------------------------------------------------------------
// listUnresolvedGroups
// ---------------------------------------------------------------------------

describe("listUnresolvedGroups", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns only groups where name == whatsapp_id (unresolved)", async () => {
    const jidA = "lu-unresolved-a@g.us";
    const jidB = "lu-unresolved-b@lid";
    const jidC = "lu-resolved-c@g.us";

    await upsertGroupByWhatsappId(pool, { whatsappId: jidA, name: jidA, source: "live" });
    await upsertGroupByWhatsappId(pool, { whatsappId: jidB, name: jidB, source: "live" });
    await upsertGroupByWhatsappId(pool, { whatsappId: jidC, name: jidC, source: "live" });
    // Resolve jidC so it is excluded
    await updateDisplayName(pool, jidC, "Already Named");

    const unresolved = await listUnresolvedGroups(pool);
    const jids = unresolved.map((r) => r.whatsappId);

    expect(jids).toContain(jidA);
    expect(jids).toContain(jidB);
    expect(jids).not.toContain(jidC);
  });

  it("returns empty array when all groups are resolved", async () => {
    const jid = "lu-all-resolved@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });
    await updateDisplayName(pool, jid, "Named Group");

    // Only check that this jid is not included (other tests may have unresolved groups)
    const unresolved = await listUnresolvedGroups(pool);
    const jids = unresolved.map((r) => r.whatsappId);
    expect(jids).not.toContain(jid);
  });

  it("returns the id and whatsappId for each unresolved group", async () => {
    const jid = "lu-fields-check@lid";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const unresolved = await listUnresolvedGroups(pool);
    const entry = unresolved.find((r) => r.whatsappId === jid);
    expect(entry).toBeDefined();
    expect(typeof entry!.id).toBe("number");
    expect(entry!.whatsappId).toBe(jid);
  });
});

// ---------------------------------------------------------------------------
// representativeSenderName — must name a DM after the OTHER party, never `from_me`
// ---------------------------------------------------------------------------

describe("representativeSenderName", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("ignores from_me messages so a DM is named after the other party even when the owner sent last", async () => {
    const groupId = await upsertGroup(pool, { name: "rsn-dm-owner-last", source: "import" });
    const otherId = await upsertParticipant(pool, "Bar Hevr");
    const ownerId = await upsertParticipant(pool, "Dana Cohen");

    // The OTHER party spoke earlier; the device owner sent the most-recent message.
    await insertMessages(pool, [
      makeMsg(groupId, "rsn-owner-1", new Date("2026-06-05T20:00:00Z"), {
        senderName: "Bar Hevr",
        participantId: otherId,
        fromMe: false,
      }),
      makeMsg(groupId, "rsn-owner-2", new Date("2026-06-05T22:00:00Z"), {
        senderName: "Dana Cohen",
        participantId: ownerId,
        fromMe: true,
      }),
    ]);

    const name = await representativeSenderName(pool, groupId);
    expect(name).toBe("Bar Hevr");
  });

  it("returns the most-recent non-owner sender when several exist", async () => {
    const groupId = await upsertGroup(pool, { name: "rsn-dm-multi", source: "import" });
    const otherId = await upsertParticipant(pool, "Rivi Shimshi");
    const ownerId = await upsertParticipant(pool, "Dana Cohen");

    await insertMessages(pool, [
      makeMsg(groupId, "rsn-multi-1", new Date("2026-06-01T10:00:00Z"), {
        senderName: "Rivi Shimshi",
        participantId: otherId,
        fromMe: false,
      }),
      makeMsg(groupId, "rsn-multi-2", new Date("2026-06-02T10:00:00Z"), {
        senderName: "Dana Cohen",
        participantId: ownerId,
        fromMe: true,
      }),
    ]);

    const name = await representativeSenderName(pool, groupId);
    expect(name).toBe("Rivi Shimshi");
  });

  it("returns null when the only messages are from the owner", async () => {
    const groupId = await upsertGroup(pool, { name: "rsn-only-owner", source: "import" });
    const ownerId = await upsertParticipant(pool, "Dana Cohen");
    await insertMessages(pool, [
      makeMsg(groupId, "rsn-only-owner-1", new Date("2026-06-01T10:00:00Z"), {
        senderName: "Dana Cohen",
        participantId: ownerId,
        fromMe: true,
      }),
    ]);

    const name = await representativeSenderName(pool, groupId);
    expect(name).toBeNull();
  });
});
