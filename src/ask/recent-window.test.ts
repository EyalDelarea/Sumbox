import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAidaMessage } from "../db/repositories/aida-messages.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMediaAnalysis } from "../db/repositories/media-analyses.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { selectRecentMessages } from "./recent-window.js";

const T = (iso: string) => new Date(iso);

async function seed(
  pool: pg.Pool,
  groupId: number,
  text: string,
  externalId: string,
  sentAt: string,
  sender = "Royi",
) {
  const participantId = await upsertParticipant(pool, sender);
  const row: NormalizedMessage & { participantId: number | null } = {
    groupId,
    importId: null,
    source: "live",
    senderName: sender,
    messageType: "text",
    textContent: text,
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    externalId,
    participantId,
    sentAt: T(sentAt),
    dedupeKey: externalId,
  };
  const { ids } = await insertMessages(pool, [row]);
  return Number(ids[0]!);
}

async function seedMedia(
  pool: pg.Pool,
  groupId: number,
  opts: {
    externalId: string;
    sentAt: string;
    mediaFilename: string;
    caption?: string;
    mediaStatus?: "present" | "missing";
  },
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, source, external_id, message_type, media_filename, media_status, text_content, sent_at, dedupe_key)
     VALUES ($1, 'live', $2, 'media', $3, $4, $5, $6, $2)
     RETURNING id`,
    [
      groupId,
      opts.externalId,
      opts.mediaFilename,
      opts.mediaStatus ?? "present",
      opts.caption ?? null,
      T(opts.sentAt),
    ],
  );
  return Number(rows[0]!.id);
}

describe("selectRecentMessages", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns the last n messages oldest-first, so the prompt reads as a transcript", async () => {
    const g = await upsertGroup(pool, { name: "RW-1", source: "live" });
    await seed(pool, g, "ראשון", "rw1-a", "2026-07-16T13:00:00Z");
    await seed(pool, g, "שני", "rw1-b", "2026-07-16T13:01:00Z");
    await seed(pool, g, "שלישי", "rw1-c", "2026-07-16T13:02:00Z");

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 2,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    // The LAST two, in chronological order.
    expect(w.map((m) => m.content)).toEqual(["שני", "שלישי"]);
  });

  it("anchors on asOf, not now — a later message is invisible", async () => {
    // The trigger's sent_at is the conversational "now"; a reply arriving
    // seconds later must not shift what she saw.
    const g = await upsertGroup(pool, { name: "RW-2", source: "live" });
    await seed(pool, g, "לפני", "rw2-a", "2026-07-16T13:00:00Z");
    await seed(pool, g, "אחרי", "rw2-b", "2026-07-16T13:10:00Z");

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w.map((m) => m.content)).toEqual(["לפני"]);
  });

  it("is scoped to the group — the privacy boundary", async () => {
    const a = await upsertGroup(pool, { name: "RW-3a", source: "live" });
    const b = await upsertGroup(pool, { name: "RW-3b", source: "live" });
    await seed(pool, a, "של קבוצה א", "rw3-a", "2026-07-16T13:00:00Z");
    await seed(pool, b, "הסוד של קבוצה ב", "rw3-b", "2026-07-16T13:00:00Z");

    const w = await selectRecentMessages(pool, {
      groupId: a,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w.map((m) => m.content)).toEqual(["של קבוצה א"]);
  });

  it("labels @Aida's own turns as hers", async () => {
    // from_me is true for the owner's messages too, so only the marker can tell.
    const g = await upsertGroup(pool, { name: "RW-4", source: "live" });
    await seed(pool, g, "אידה מה המצב ?", "rw4-a", "2026-07-16T13:00:00Z");
    await seed(pool, g, "תכף תכף... לא מצאתי.", "rw4-b", "2026-07-16T13:01:00Z");
    await recordAidaMessage(pool, { groupId: g, externalId: "rw4-b" });

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w.map((m) => m.isAida)).toEqual([false, true]);
  });

  it("excludes the triggering message — it is the question, not context", async () => {
    const g = await upsertGroup(pool, { name: "RW-5", source: "live" });
    await seed(pool, g, "אידה מה המצב ?", "rw5-a", "2026-07-16T13:00:00Z");
    await seed(pool, g, "@אידה מה שאלו אותי", "rw5-trigger", "2026-07-16T13:01:00Z");

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:01:00Z"),
      excludeExternalId: "rw5-trigger",
    });
    expect(w.map((m) => m.content)).toEqual(["אידה מה המצב ?"]);
  });

  it("needs NO embeddings — it works while the sweep is dead", async () => {
    // The sweep died for ~50 minutes on 2026-07-16 and @Aida silently degraded to
    // lexical-only. Nothing here is seeded into message_embeddings.
    const g = await upsertGroup(pool, { name: "RW-6", source: "live" });
    await seed(pool, g, "הודעה בלי embedding", "rw6-a", "2026-07-16T13:00:00Z");

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w).toHaveLength(1);
  });

  it("skips system messages and empty content", async () => {
    const g = await upsertGroup(pool, { name: "RW-7", source: "live" });
    await seed(pool, g, "אמיתי", "rw7-a", "2026-07-16T13:00:00Z");
    await seed(pool, g, "", "rw7-b", "2026-07-16T13:01:00Z");

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w.map((m) => m.content)).toEqual(["אמיתי"]);
  });

  it("surfaces a captionless unanalyzed image with empty content and pendingMedia: image", async () => {
    const g = await upsertGroup(pool, { name: "RW-8", source: "live" });
    await seedMedia(pool, g, {
      externalId: "rw8-a",
      sentAt: "2026-07-16T13:00:00Z",
      mediaFilename: "photo.jpg",
    });

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w).toHaveLength(1);
    expect(w[0]!.content).toBe("");
    expect(w[0]!.pendingMedia).toBe("image");
  });

  it("surfaces an unanalyzed voice note with pendingMedia: voice", async () => {
    const g = await upsertGroup(pool, { name: "RW-9", source: "live" });
    await seedMedia(pool, g, {
      externalId: "rw9-a",
      sentAt: "2026-07-16T13:00:00Z",
      mediaFilename: "note.opus",
    });

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w).toHaveLength(1);
    expect(w[0]!.pendingMedia).toBe("voice");
  });

  it("keeps a captioned-but-unanalyzed image flagged pending — the caption must not hide the unread photo", async () => {
    const g = await upsertGroup(pool, { name: "RW-10", source: "live" });
    await seedMedia(pool, g, {
      externalId: "rw10-a",
      sentAt: "2026-07-16T13:00:00Z",
      mediaFilename: "photo.jpg",
      caption: "כיתוב",
    });

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w).toHaveLength(1);
    expect(w[0]!.content).toBe("כיתוב");
    expect(w[0]!.pendingMedia).toBe("image");
  });

  it("clears pendingMedia once the image is analyzed — description becomes content", async () => {
    const g = await upsertGroup(pool, { name: "RW-11", source: "live" });
    const id = await seedMedia(pool, g, {
      externalId: "rw11-a",
      sentAt: "2026-07-16T13:00:00Z",
      mediaFilename: "photo.jpg",
    });
    await insertMediaAnalysis(pool, {
      messageId: id,
      kind: "image",
      description: "תיאור התמונה",
      engine: "test",
      status: "completed",
    });

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w).toHaveLength(1);
    expect(w[0]!.content).toBe("תיאור התמונה");
    expect(w[0]!.pendingMedia).toBeNull();
  });

  it("still excludes stickers and empty-text rows even under the new pending check", async () => {
    const g = await upsertGroup(pool, { name: "RW-12", source: "live" });
    await seedMedia(pool, g, {
      externalId: "rw12-a",
      sentAt: "2026-07-16T13:00:00Z",
      mediaFilename: "STK-x.webp",
    });
    await seed(pool, g, "", "rw12-b", "2026-07-16T13:01:00Z");

    const w = await selectRecentMessages(pool, {
      groupId: g,
      n: 10,
      asOf: T("2026-07-16T13:05:00Z"),
    });
    expect(w).toHaveLength(0);
  });
});
