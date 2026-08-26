import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import {
  disambiguationCandidates,
  isDisplayNameUnresolved,
  listGroups,
  listUnresolvedGroups,
  representativeSenderName,
  updateDisplayName,
  updateDisplayNameDisambiguated,
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

// ---------------------------------------------------------------------------
// updateDisplayNameDisambiguated (#85 defect 1)
// ---------------------------------------------------------------------------

describe("disambiguationCandidates (#85)", () => {
  it("prefers the phone side of a lid<->pn pair for the digits", () => {
    expect(
      disambiguationCandidates("1234567890@lid", "דנה כהן", "972501239876@s.whatsapp.net"),
    ).toEqual(["דנה כהן (~9876)", "דנה כהן (~972501239876)", "דנה כהן (1234567890@lid)"]);
  });

  it("falls back to the chat's own digits when no sibling is known", () => {
    expect(disambiguationCandidates("1234567890@lid", "דנה כהן")).toEqual([
      "דנה כהן (~7890)",
      "דנה כהן (~1234567890)",
      "דנה כהן (1234567890@lid)",
    ]);
  });

  it("ignores a sibling that is not a phone JID", () => {
    expect(disambiguationCandidates("972500001111@s.whatsapp.net", "Dana", "555@lid")[0]).toBe(
      "Dana (~1111)",
    );
  });

  it("ends in a name unique by construction, so it can never fall back to the JID", () => {
    const jid = "972500002222@s.whatsapp.net";
    const candidates = disambiguationCandidates(jid, "Dana");
    expect(candidates.at(-1)).toBe(`Dana (${jid})`);
    expect(candidates).not.toContain(jid);
  });

  it("uses the trailing digits of a real numeric @g.us JID", () => {
    expect(disambiguationCandidates("123456789-987654321@g.us", "צוות")[0]).toBe("צוות (~4321)");
  });

  it("does not emit a redundant short form when the digits are already short", () => {
    expect(disambiguationCandidates("12@lid", "Dana")).toEqual(["Dana (~12)", "Dana (12@lid)"]);
  });
});

describe("updateDisplayNameDisambiguated (#85)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const seed = async (jid: string) => {
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });
  };
  const nameOf = async (jid: string) => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM groups WHERE whatsapp_id = $1`,
      [jid],
    );
    return rows[0]?.name ?? null;
  };

  it("claims a free name exactly like updateDisplayName", async () => {
    const jid = "dis-free-001@s.whatsapp.net";
    await seed(jid);

    expect(await updateDisplayNameDisambiguated(pool, jid, "Free Name")).toEqual({
      status: "updated",
      name: "Free Name",
    });
    expect(await nameOf(jid)).toBe("Free Name");
  });

  it("disambiguates when a STRANGER holds the name, instead of throwing", async () => {
    const stranger = "972500001111@s.whatsapp.net";
    const mine = "972500002222@s.whatsapp.net";
    await seed(stranger);
    await seed(mine);
    await updateDisplayName(pool, stranger, "דנה כהן");

    const outcome = await updateDisplayNameDisambiguated(pool, mine, "דנה כהן");

    expect(outcome).toEqual({ status: "updated", name: "דנה כהן (~2222)" });
    expect(await nameOf(mine)).toBe("דנה כהן (~2222)");
    // The stranger keeps the plain name; nobody was renamed out from under.
    expect(await nameOf(stranger)).toBe("דנה כהן");
  });

  it("uses the linked phone digits for a @lid chat, not the opaque lid number", async () => {
    const stranger = "972500003333@s.whatsapp.net";
    const mine = "8881112223334@lid";
    await seed(stranger);
    await seed(mine);
    await updateDisplayName(pool, stranger, "רון לוי");

    const outcome = await updateDisplayNameDisambiguated(
      pool,
      mine,
      "רון לוי",
      "972500004444@s.whatsapp.net",
    );

    expect(outcome).toEqual({ status: "updated", name: "רון לוי (~4444)" });
  });

  it("leaves the chat NAMELESS when its own lid/pn sibling holds the name", async () => {
    // Same person under two identities, awaiting reconcile. Naming this row
    // would disqualify it from findMergeCandidates forever.
    const pn = "972500005555@s.whatsapp.net";
    const lid = "7770001112223@lid";
    await seed(pn);
    await seed(lid);
    await updateDisplayName(pool, pn, "אבי מזרחי");

    const outcome = await updateDisplayNameDisambiguated(pool, lid, "אבי מזרחי", pn);

    expect(outcome).toEqual({ status: "skipped-sibling", heldBy: pn });
    expect(await nameOf(lid)).toBe(lid);
    // Still eligible for the merge path, which requires name == whatsapp_id.
    expect(await isDisplayNameUnresolved(pool, lid)).toBe(true);
  });

  it("escalates to the full number when the short suffix is also taken", async () => {
    const a = "972500006666@s.whatsapp.net";
    const b = "972510006666@s.whatsapp.net"; // same last 4
    const c = "972520006666@s.whatsapp.net"; // and again
    await seed(a);
    await seed(b);
    await seed(c);
    await updateDisplayName(pool, a, "Shared");

    expect(await updateDisplayNameDisambiguated(pool, b, "Shared")).toEqual({
      status: "updated",
      name: "Shared (~6666)",
    });
    expect(await updateDisplayNameDisambiguated(pool, c, "Shared")).toEqual({
      status: "updated",
      name: "Shared (~972520006666)",
    });
  });

  it("never leaves the row named after its own JID, so the retry loop cannot return", async () => {
    const jid = "972500007777@s.whatsapp.net";
    const holder = "972500008888@s.whatsapp.net";
    await seed(jid);
    await seed(holder);
    await updateDisplayName(pool, holder, "Taken");
    // Pre-occupy every escalation step except the last.
    for (const [i, candidate] of ["Taken (~7777)", "Taken (~972500007777)"].entries()) {
      const squatter = `squatter-${i}@g.us`;
      await seed(squatter);
      await updateDisplayName(pool, squatter, candidate);
    }

    const outcome = await updateDisplayNameDisambiguated(pool, jid, "Taken");

    expect(outcome).toEqual({ status: "updated", name: `Taken (${jid})` });
    expect(await isDisplayNameUnresolved(pool, jid)).toBe(false);
  });

  it("disambiguates when a THIRD, unrelated chat holds the name — not just any collision", async () => {
    // The sibling check must not swallow a collision with a stranger just
    // because this chat happens to have a known sibling elsewhere.
    const stranger = "972500001212@s.whatsapp.net";
    const mine = "9990001112223@lid";
    const mySibling = "972500003434@s.whatsapp.net";
    await seed(stranger);
    await seed(mine);
    await seed(mySibling);
    await updateDisplayName(pool, stranger, "משותף");
    await updateDisplayName(pool, mySibling, "שם אחר לגמרי");

    expect(await updateDisplayNameDisambiguated(pool, mine, "משותף", mySibling)).toEqual({
      status: "updated",
      name: "משותף (~3434)",
    });
  });

  it("is a no-op on an already-resolved row (never clobbers a resolved name)", async () => {
    const jid = "dis-resolved-001@s.whatsapp.net";
    await seed(jid);
    await updateDisplayName(pool, jid, "Already Named");

    expect(await updateDisplayNameDisambiguated(pool, jid, "Something Else")).toEqual({
      status: "noop",
    });
    expect(await nameOf(jid)).toBe("Already Named");
  });

  it("is a no-op when the group does not exist", async () => {
    expect(await updateDisplayNameDisambiguated(pool, "ghost@s.whatsapp.net", "Ghost")).toEqual({
      status: "noop",
    });
  });

  it("leaves updateDisplayName's throwing behaviour untouched for the contacts path", async () => {
    const holder = "dis-throw-001@s.whatsapp.net";
    const other = "dis-throw-002@s.whatsapp.net";
    await seed(holder);
    await seed(other);
    await updateDisplayName(pool, holder, "Contact Name");

    await expect(updateDisplayName(pool, other, "Contact Name")).rejects.toMatchObject({
      code: "23505",
    });
    expect(await nameOf(other)).toBe(other);
  });
});
