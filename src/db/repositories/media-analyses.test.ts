import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import {
  getVisualMediaPath,
  hasAnalysis,
  insertMediaAnalysis,
  selectVisualMediaNeedingAnalysis,
} from "./media-analyses.js";
import { insertMessages } from "./messages.js";

describe("media-analyses", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seedMediaMessage(
    groupId: number,
    overrides: Partial<NormalizedMessage> = {},
  ): Promise<number> {
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: null,
      messageType: "media",
      textContent: null,
      mediaFilename: "IMG-001.jpg",
      mediaPath: "/tmp/IMG-001.jpg",
      mediaStatus: "present",
      sentAt: new Date("2026-01-01T08:00:00.000Z"),
      dedupeKey: `dk-${Math.random()}`,
      externalId: null,
      participantId: null,
      ...overrides,
    };
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key = $1`,
      [row.dedupeKey],
    );
    return Number(rows[0].id);
  }

  describe("schema", () => {
    it("rejects a second analysis for the same message_id (UNIQUE constraint)", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-schema-dup", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "schema-dup-1" });

      await pool.query(
        `INSERT INTO media_analyses (message_id, kind, description, engine, status)
         VALUES ($1, 'image', 'a cat', 'test-engine', 'completed')`,
        [messageId],
      );

      await expect(
        pool.query(
          `INSERT INTO media_analyses (message_id, kind, description, engine, status)
           VALUES ($1, 'image', 'a dog', 'test-engine', 'completed')`,
          [messageId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("allows a failed analysis with null description", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-schema-fail", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "schema-fail-1" });

      await expect(
        pool.query(
          `INSERT INTO media_analyses (message_id, kind, description, engine, status, error_message)
           VALUES ($1, 'image', NULL, 'test-engine', 'failed', 'model timeout')`,
          [messageId],
        ),
      ).resolves.toBeDefined();
    });

    it("rejects a completed analysis with null description (CHECK constraint)", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-schema-check", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "schema-check-1" });

      await expect(
        pool.query(
          `INSERT INTO media_analyses (message_id, kind, description, engine, status)
           VALUES ($1, 'image', NULL, 'test-engine', 'completed')`,
          [messageId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("rejects an invalid kind value", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-schema-kind", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "schema-kind-1" });

      await expect(
        pool.query(
          `INSERT INTO media_analyses (message_id, kind, description, engine, status)
           VALUES ($1, 'audio', 'something', 'test-engine', 'completed')`,
          [messageId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("rejects an invalid status value", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-schema-status", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "schema-status-1" });

      await expect(
        pool.query(
          `INSERT INTO media_analyses (message_id, kind, description, engine, status)
           VALUES ($1, 'image', 'something', 'test-engine', 'pending')`,
          [messageId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("insertMediaAnalysis", () => {
    it("inserts a completed analysis for an image", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-insert-img", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "ins-img-1" });

      await insertMediaAnalysis(pool, {
        messageId,
        kind: "image",
        description: "a sunny beach",
        engine: "llama3.2-vision",
        status: "completed",
      });

      const { rows } = await pool.query(
        `SELECT kind, description, engine, status FROM media_analyses WHERE message_id = $1`,
        [messageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("image");
      expect(rows[0].description).toBe("a sunny beach");
      expect(rows[0].engine).toBe("llama3.2-vision");
      expect(rows[0].status).toBe("completed");
    });

    it("inserts a failed analysis for a video", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-insert-fail", source: "import" });
      const messageId = await seedMediaMessage(groupId, {
        dedupeKey: "ins-fail-1",
        mediaFilename: "clip.mp4",
        mediaPath: "/tmp/clip.mp4",
      });

      await insertMediaAnalysis(pool, {
        messageId,
        kind: "video",
        description: null,
        engine: "llama3.2-vision",
        status: "failed",
        errorMessage: "file too large",
      });

      const { rows } = await pool.query(
        `SELECT kind, description, status, error_message FROM media_analyses WHERE message_id = $1`,
        [messageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("video");
      expect(rows[0].description).toBeNull();
      expect(rows[0].status).toBe("failed");
      expect(rows[0].error_message).toBe("file too large");
    });

    it("upserts — inserting completed over an existing failed row upgrades it to completed with the new description", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-idem", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "ins-idem-1" });

      // First insert: failed (e.g. transient Ollama error)
      await insertMediaAnalysis(pool, {
        messageId,
        kind: "image",
        description: null,
        engine: "llama3.2-vision",
        status: "failed",
        errorMessage: "fetch failed",
      });

      // Second insert: successful retry — should upgrade failed → completed
      await insertMediaAnalysis(pool, {
        messageId,
        kind: "image",
        description: "a sunny beach",
        engine: "llama3.2-vision",
        status: "completed",
      });

      const { rows } = await pool.query(
        `SELECT description, status, error_message FROM media_analyses WHERE message_id = $1`,
        [messageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("completed");
      expect(rows[0].description).toBe("a sunny beach");
      expect(rows[0].error_message).toBeNull();
    });
  });

  describe("hasAnalysis", () => {
    it("returns true when an analysis row exists (completed)", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-has-true", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "has-true-1" });

      await insertMediaAnalysis(pool, {
        messageId,
        kind: "image",
        description: "something",
        engine: "llama3.2-vision",
        status: "completed",
      });

      expect(await hasAnalysis(pool, messageId)).toBe(true);
    });

    it("returns false when only a failed analysis row exists (failed rows are retryable)", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-has-failed", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "has-fail-1" });

      await insertMediaAnalysis(pool, {
        messageId,
        kind: "image",
        description: null,
        engine: "llama3.2-vision",
        status: "failed",
        errorMessage: "oops",
      });

      expect(await hasAnalysis(pool, messageId)).toBe(false);
    });

    it("returns false when no analysis row exists", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-has-false", source: "import" });
      const messageId = await seedMediaMessage(groupId, { dedupeKey: "has-false-1" });

      expect(await hasAnalysis(pool, messageId)).toBe(false);
    });
  });

  describe("getVisualMediaPath", () => {
    it("returns path and kind='image' for a present image message", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-path-img", source: "import" });
      const messageId = await seedMediaMessage(groupId, {
        dedupeKey: "path-img-1",
        mediaFilename: "photo.jpg",
        mediaPath: "/data/photo.jpg",
        mediaStatus: "present",
      });

      const result = await getVisualMediaPath(pool, messageId);
      expect(result).not.toBeNull();
      expect(result!.path).toBe("/data/photo.jpg");
      expect(result!.kind).toBe("image");
    });

    it("returns path and kind='video' for a present video message", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-path-vid", source: "import" });
      const messageId = await seedMediaMessage(groupId, {
        dedupeKey: "path-vid-1",
        mediaFilename: "clip.mp4",
        mediaPath: "/data/clip.mp4",
        mediaStatus: "present",
      });

      const result = await getVisualMediaPath(pool, messageId);
      expect(result).not.toBeNull();
      expect(result!.path).toBe("/data/clip.mp4");
      expect(result!.kind).toBe("video");
    });

    it("returns null for a missing media message", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-path-miss", source: "import" });
      const messageId = await seedMediaMessage(groupId, {
        dedupeKey: "path-miss-1",
        mediaFilename: "photo.jpg",
        mediaPath: null,
        mediaStatus: "missing",
      });

      const result = await getVisualMediaPath(pool, messageId);
      expect(result).toBeNull();
    });

    it("returns null for an audio message", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-path-audio", source: "import" });
      const messageId = await seedMediaMessage(groupId, {
        dedupeKey: "path-audio-1",
        mediaFilename: "voice.opus",
        mediaPath: "/data/voice.opus",
        mediaStatus: "present",
      });

      const result = await getVisualMediaPath(pool, messageId);
      expect(result).toBeNull();
    });

    it("returns null for a non-existent messageId", async () => {
      const result = await getVisualMediaPath(pool, 999999999);
      expect(result).toBeNull();
    });

    it("returns path for .webp image", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-path-webp", source: "import" });
      const messageId = await seedMediaMessage(groupId, {
        dedupeKey: "path-webp-1",
        mediaFilename: "img.webp",
        mediaPath: "/data/img.webp",
        mediaStatus: "present",
      });

      const result = await getVisualMediaPath(pool, messageId);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("image");
    });

    it("returns path for .mov video", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-path-mov", source: "import" });
      const messageId = await seedMediaMessage(groupId, {
        dedupeKey: "path-mov-1",
        mediaFilename: "recording.mov",
        mediaPath: "/data/recording.mov",
        mediaStatus: "present",
      });

      const result = await getVisualMediaPath(pool, messageId);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("video");
    });
  });

  describe("selectVisualMediaNeedingAnalysis", () => {
    it("returns present image and video messages without a completed analysis, newest-first", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-needs-analysis", source: "import" });

      const older = await seedMediaMessage(groupId, {
        dedupeKey: "needs-old-1",
        mediaFilename: "old.jpg",
        mediaPath: "/data/old.jpg",
        mediaStatus: "present",
        sentAt: new Date("2026-03-01T08:00:00.000Z"),
      });
      const newer = await seedMediaMessage(groupId, {
        dedupeKey: "needs-new-1",
        mediaFilename: "new.mp4",
        mediaPath: "/data/new.mp4",
        mediaStatus: "present",
        sentAt: new Date("2026-03-02T08:00:00.000Z"),
      });

      const result = await selectVisualMediaNeedingAnalysis(pool);
      const ids = result.map((r) => r.messageId);
      expect(ids).toContain(older);
      expect(ids).toContain(newer);
      // Newer comes before older (newest-first)
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    });

    it("includes rows whose only analysis is failed (COMPLETED-only exclusion)", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-needs-failed", source: "import" });

      const failedMsg = await seedMediaMessage(groupId, {
        dedupeKey: "needs-fail-1",
        mediaFilename: "fail.jpg",
        mediaPath: "/data/fail.jpg",
        mediaStatus: "present",
      });

      await insertMediaAnalysis(pool, {
        messageId: failedMsg,
        kind: "image",
        description: null,
        engine: "test-engine",
        status: "failed",
        errorMessage: "transient error",
      });

      const result = await selectVisualMediaNeedingAnalysis(pool);
      const ids = result.map((r) => r.messageId);
      expect(ids).toContain(failedMsg);
    });

    it("excludes messages that already have a completed analysis", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-needs-completed", source: "import" });

      const completedMsg = await seedMediaMessage(groupId, {
        dedupeKey: "needs-comp-1",
        mediaFilename: "done.jpg",
        mediaPath: "/data/done.jpg",
        mediaStatus: "present",
      });

      await insertMediaAnalysis(pool, {
        messageId: completedMsg,
        kind: "image",
        description: "already analyzed",
        engine: "test-engine",
        status: "completed",
      });

      const result = await selectVisualMediaNeedingAnalysis(pool);
      const ids = result.map((r) => r.messageId);
      expect(ids).not.toContain(completedMsg);
    });

    it("excludes sticker messages (STK-* filenames)", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-needs-sticker", source: "import" });

      const stickerMsg = await seedMediaMessage(groupId, {
        dedupeKey: "needs-stk-1",
        mediaFilename: "STK-20240601-WA0001.webp",
        mediaPath: "/data/STK-20240601-WA0001.webp",
        mediaStatus: "present",
      });

      const result = await selectVisualMediaNeedingAnalysis(pool);
      const ids = result.map((r) => r.messageId);
      expect(ids).not.toContain(stickerMsg);
    });

    it("excludes missing media (media_status != present or null path)", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-needs-missing", source: "import" });

      const missingMsg = await seedMediaMessage(groupId, {
        dedupeKey: "needs-miss-1",
        mediaFilename: "missing.jpg",
        mediaPath: null,
        mediaStatus: "missing",
      });

      const result = await selectVisualMediaNeedingAnalysis(pool);
      const ids = result.map((r) => r.messageId);
      expect(ids).not.toContain(missingMsg);
    });

    it("returns the correct kind for image and video messages", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-needs-kind", source: "import" });

      const imgMsg = await seedMediaMessage(groupId, {
        dedupeKey: "needs-kind-img",
        mediaFilename: "photo.png",
        mediaPath: "/data/photo.png",
        mediaStatus: "present",
      });
      const vidMsg = await seedMediaMessage(groupId, {
        dedupeKey: "needs-kind-vid",
        mediaFilename: "clip.mp4",
        mediaPath: "/data/clip.mp4",
        mediaStatus: "present",
      });

      const result = await selectVisualMediaNeedingAnalysis(pool);
      const imgRow = result.find((r) => r.messageId === imgMsg);
      const vidRow = result.find((r) => r.messageId === vidMsg);
      expect(imgRow?.kind).toBe("image");
      expect(vidRow?.kind).toBe("video");
    });

    it("respects the optional limit parameter", async () => {
      const groupId = await upsertGroup(pool, { name: "MA-needs-limit", source: "import" });

      for (let i = 0; i < 5; i++) {
        await seedMediaMessage(groupId, {
          dedupeKey: `needs-lim-${i}`,
          mediaFilename: `lim${i}.jpg`,
          mediaPath: `/data/lim${i}.jpg`,
          mediaStatus: "present",
          sentAt: new Date(`2026-04-0${i + 1}T08:00:00.000Z`),
        });
      }

      const result = await selectVisualMediaNeedingAnalysis(pool, 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });
});
