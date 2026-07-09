import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import { insertMessages } from "./messages.js";
import {
  countTranscribedVoiceNotes,
  insertTranscript,
  listUntranscribedVoiceNoteIdsByGroup,
  selectPendingVoiceNotes,
} from "./transcripts.js";

describe("transcripts", () => {
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
      mediaFilename: "PTT-0001.opus",
      mediaPath: "/tmp/PTT-0001.opus",
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
    it("rejects a second transcript for the same message_id (FR-012)", async () => {
      const groupId = await upsertGroup(pool, { name: "TG-schema", source: "import" });
      const messageId = await seedMediaMessage(groupId);

      await pool.query(
        `INSERT INTO transcripts (message_id, transcript, engine, status)
         VALUES ($1, 'שלום', 'test-engine', 'completed')`,
        [messageId],
      );

      await expect(
        pool.query(
          `INSERT INTO transcripts (message_id, transcript, engine, status)
           VALUES ($1, 'שלום שוב', 'test-engine', 'completed')`,
          [messageId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("allows a failed transcript with null transcript text (FR-013)", async () => {
      const groupId = await upsertGroup(pool, { name: "TG-failed", source: "import" });
      const messageId = await seedMediaMessage(groupId);

      await expect(
        pool.query(
          `INSERT INTO transcripts (message_id, transcript, engine, status, error_message)
           VALUES ($1, NULL, 'test-engine', 'failed', 'corrupt audio')`,
          [messageId],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("repository", () => {
    it("selectPendingVoiceNotes returns only audio media without a transcript", async () => {
      const groupId = await upsertGroup(pool, { name: "TG-pending", source: "import" });
      const opusId = await seedMediaMessage(groupId, {
        mediaFilename: "PTT-A.opus",
        mediaPath: "/tmp/PTT-A.opus",
        dedupeKey: "pend-opus",
      });
      // Non-audio media must be ignored:
      await seedMediaMessage(groupId, {
        mediaFilename: "IMG-1.jpg",
        mediaPath: "/tmp/IMG-1.jpg",
        dedupeKey: "pend-img",
      });
      // Missing-media audio must be ignored:
      await seedMediaMessage(groupId, {
        mediaFilename: "PTT-B.opus",
        mediaPath: null,
        mediaStatus: "missing",
        dedupeKey: "pend-missing",
      });

      const pending = await selectPendingVoiceNotes(pool, "TG-pending");
      expect(pending.map((p) => p.messageId)).toEqual([opusId]);
      expect(pending[0].mediaPath).toBe("/tmp/PTT-A.opus");
    });

    it("insertTranscript is idempotent and excludes the row from pending; count reflects it", async () => {
      const groupId = await upsertGroup(pool, { name: "TG-insert", source: "import" });
      const messageId = await seedMediaMessage(groupId, {
        mediaFilename: "PTT-C.opus",
        mediaPath: "/tmp/PTT-C.opus",
        dedupeKey: "ins-opus",
      });

      await insertTranscript(pool, {
        messageId,
        transcript: "שלום",
        engine: "test-engine",
        status: "completed",
      });
      // Second call must not throw and must not create a duplicate (FR-012).
      await insertTranscript(pool, {
        messageId,
        transcript: "שלום שוב",
        engine: "test-engine",
        status: "completed",
      });

      const pending = await selectPendingVoiceNotes(pool, "TG-insert");
      expect(pending).toHaveLength(0);
      expect(await countTranscribedVoiceNotes(pool, "TG-insert")).toBe(1);
    });

    it("listUntranscribedVoiceNoteIdsByGroup returns string IDs for untranscribed audio", async () => {
      const groupId = await upsertGroup(pool, { name: "TG-list-ids", source: "import" });

      // Untranscribed opus
      const id1 = await seedMediaMessage(groupId, {
        mediaFilename: "PTT-X1.opus",
        mediaPath: "/tmp/PTT-X1.opus",
        dedupeKey: "list-opus-1",
      });
      // Untranscribed m4a
      const id2 = await seedMediaMessage(groupId, {
        mediaFilename: "AUD-X2.m4a",
        mediaPath: "/tmp/AUD-X2.m4a",
        dedupeKey: "list-m4a-1",
      });
      // Non-audio media — must NOT be included
      await seedMediaMessage(groupId, {
        mediaFilename: "IMG-X.jpg",
        mediaPath: "/tmp/IMG-X.jpg",
        dedupeKey: "list-img-1",
      });
      // Missing-media audio — must NOT be included
      await seedMediaMessage(groupId, {
        mediaFilename: "PTT-X3.opus",
        mediaPath: null,
        mediaStatus: "missing",
        dedupeKey: "list-missing-1",
      });

      const ids = await listUntranscribedVoiceNoteIdsByGroup(pool, "TG-list-ids");
      expect(ids.sort()).toEqual([String(id1), String(id2)].sort());
      // All values must be strings
      for (const id of ids) {
        expect(typeof id).toBe("string");
      }
    });

    it("listUntranscribedVoiceNoteIdsByGroup excludes already-transcribed notes", async () => {
      const groupId = await upsertGroup(pool, { name: "TG-list-skip", source: "import" });

      const id1 = await seedMediaMessage(groupId, {
        mediaFilename: "PTT-S1.opus",
        mediaPath: "/tmp/PTT-S1.opus",
        dedupeKey: "skip-opus-1",
      });
      const id2 = await seedMediaMessage(groupId, {
        mediaFilename: "PTT-S2.opus",
        mediaPath: "/tmp/PTT-S2.opus",
        dedupeKey: "skip-opus-2",
      });

      // Transcribe id1
      await insertTranscript(pool, {
        messageId: id1,
        transcript: "already done",
        engine: "test-engine",
        status: "completed",
      });

      const ids = await listUntranscribedVoiceNoteIdsByGroup(pool, "TG-list-skip");
      expect(ids).toEqual([String(id2)]);
    });

    it("listUntranscribedVoiceNoteIdsByGroup returns empty array for unknown group", async () => {
      const ids = await listUntranscribedVoiceNoteIdsByGroup(pool, "no-such-group-xyz");
      expect(ids).toEqual([]);
    });
  });
});
