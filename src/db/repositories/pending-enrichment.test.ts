import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import { insertMediaAnalysis } from "./media-analyses.js";
import { countPendingEnrichment } from "./pending-enrichment.js";
import { insertTranscript } from "./transcripts.js";

const T = (iso: string) => new Date(iso);

async function seedMedia(
  pool: pg.Pool,
  groupId: number,
  opts: {
    externalId: string;
    sentAt: string;
    mediaFilename: string;
    mediaStatus?: "present" | "missing";
  },
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, source, external_id, message_type, media_filename, media_status, sent_at, dedupe_key)
     VALUES ($1, 'live', $2, 'media', $3, $4, $5, $2)
     RETURNING id`,
    [groupId, opts.externalId, opts.mediaFilename, opts.mediaStatus ?? "present", T(opts.sentAt)],
  );
  return Number(rows[0]!.id);
}

async function seedText(
  pool: pg.Pool,
  groupId: number,
  opts: { externalId: string; sentAt: string },
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, source, external_id, message_type, text_content, sent_at, dedupe_key)
     VALUES ($1, 'live', $2, 'text', 'טקסט', $3, $2)
     RETURNING id`,
    [groupId, opts.externalId, T(opts.sentAt)],
  );
  return Number(rows[0]!.id);
}

describe("countPendingEnrichment", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const since = T("2026-07-19T10:00:00Z");
  const until = T("2026-07-19T11:00:00Z");

  it("counts a captionless image with no media_analyses row", async () => {
    const g = await upsertGroup(pool, { name: "PE-1", source: "live" });
    await seedMedia(pool, g, {
      externalId: "pe1-a",
      sentAt: "2026-07-19T10:30:00Z",
      mediaFilename: "photo.jpg",
    });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(1);
  });

  it("excludes an image once a completed analysis exists", async () => {
    const g = await upsertGroup(pool, { name: "PE-2", source: "live" });
    const id = await seedMedia(pool, g, {
      externalId: "pe2-a",
      sentAt: "2026-07-19T10:30:00Z",
      mediaFilename: "photo.jpg",
    });
    await insertMediaAnalysis(pool, {
      messageId: id,
      kind: "image",
      description: "תיאור",
      engine: "test",
      status: "completed",
    });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(0);
  });

  it("still counts an image whose only analysis row failed — the sweep retries it", async () => {
    const g = await upsertGroup(pool, { name: "PE-3", source: "live" });
    const id = await seedMedia(pool, g, {
      externalId: "pe3-a",
      sentAt: "2026-07-19T10:30:00Z",
      mediaFilename: "photo.jpg",
    });
    await insertMediaAnalysis(pool, {
      messageId: id,
      kind: "image",
      description: null,
      engine: "test",
      status: "failed",
      errorMessage: "boom",
    });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(1);
  });

  it("counts a voice note with no transcript", async () => {
    const g = await upsertGroup(pool, { name: "PE-4", source: "live" });
    await seedMedia(pool, g, {
      externalId: "pe4-a",
      sentAt: "2026-07-19T10:30:00Z",
      mediaFilename: "note.opus",
    });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(1);
  });

  it("excludes a voice note once a completed transcript exists", async () => {
    const g = await upsertGroup(pool, { name: "PE-5", source: "live" });
    const id = await seedMedia(pool, g, {
      externalId: "pe5-a",
      sentAt: "2026-07-19T10:30:00Z",
      mediaFilename: "note.opus",
    });
    await insertTranscript(pool, {
      messageId: id,
      transcript: "טקסט מתומלל",
      engine: "test",
      status: "completed",
    });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(0);
  });

  it("excludes stickers even though .webp matches the image predicate", async () => {
    const g = await upsertGroup(pool, { name: "PE-6", source: "live" });
    await seedMedia(pool, g, {
      externalId: "pe6-a",
      sentAt: "2026-07-19T10:30:00Z",
      mediaFilename: "STK-x.webp",
    });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(0);
  });

  it("excludes an image sent before the window's since bound", async () => {
    const g = await upsertGroup(pool, { name: "PE-7", source: "live" });
    await seedMedia(pool, g, {
      externalId: "pe7-a",
      sentAt: "2026-07-19T09:00:00Z",
      mediaFilename: "photo.jpg",
    });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(0);
  });

  it("excludes plain text messages", async () => {
    const g = await upsertGroup(pool, { name: "PE-8", source: "live" });
    await seedText(pool, g, { externalId: "pe8-a", sentAt: "2026-07-19T10:30:00Z" });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(0);
  });

  it("excludes an image whose media is missing on disk", async () => {
    const g = await upsertGroup(pool, { name: "PE-9", source: "live" });
    await seedMedia(pool, g, {
      externalId: "pe9-a",
      sentAt: "2026-07-19T10:30:00Z",
      mediaFilename: "photo.jpg",
      mediaStatus: "missing",
    });

    const n = await countPendingEnrichment(pool, { groupId: g, since, until });
    expect(n).toBe(0);
  });
});
