/**
 * messages.test.ts — Testcontainers integration tests for the new read queries:
 *   - countReadableByGroup
 *   - getNewestAnchor
 * Also covers the from_me column persistence for T003.
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import {
  countMediaByGroup,
  countReadableByGroup,
  getMessageIdByExternalId,
  getMessagesAround,
  getNewestAnchor,
  getOldestSentAt,
  getRecentMessages,
  insertMessages,
  markMessageMediaPresent,
} from "./messages.js";
import { upsertParticipant } from "./participants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    groupId: 0,
    importId: null,
    source: "import",
    senderName: "Alice",
    messageType: "text",
    textContent: "Hello",
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    sentAt: new Date("2024-01-15T10:00:00.000Z"),
    dedupeKey: `test-key-${Math.random()}`,
    externalId: null,
    fromMe: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("messages read queries", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("countMediaByGroup counts only media-type messages", async () => {
    const groupId = await upsertGroup(pool, { name: `media-${Math.random()}`, source: "import" });
    const pid = await upsertParticipant(pool, `media-sender-${Math.random()}`);
    await insertMessages(pool, [
      {
        ...makeMsg({ groupId, dedupeKey: `m1-${Math.random()}`, messageType: "media" }),
        participantId: pid,
      },
      {
        ...makeMsg({ groupId, dedupeKey: `m2-${Math.random()}`, messageType: "media" }),
        participantId: pid,
      },
      {
        ...makeMsg({ groupId, dedupeKey: `t1-${Math.random()}`, messageType: "text" }),
        participantId: pid,
      },
    ]);
    expect(await countMediaByGroup(pool, groupId)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // T003: from_me column persistence
  // -------------------------------------------------------------------------

  describe("from_me column persistence", () => {
    it("persists from_me=true when fromMe is set to true", async () => {
      const groupId = await upsertGroup(pool, { name: "fromMe-true-group", source: "import" });
      const participantId = await upsertParticipant(pool, "fromMe-sender");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "fromme-true-001",
            externalId: "ext-fromme-true",
            fromMe: true,
          }),
          participantId,
        },
      ]);

      const { rows } = await pool.query(`SELECT from_me FROM messages WHERE external_id = $1`, [
        "ext-fromme-true",
      ]);
      expect(rows.length).toBe(1);
      expect(rows[0].from_me).toBe(true);
    });

    it("persists from_me=null when fromMe is not set (import rows)", async () => {
      const groupId = await upsertGroup(pool, { name: "fromMe-null-group", source: "import" });
      const participantId = await upsertParticipant(pool, "fromMe-null-sender");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "fromme-null-001",
            externalId: null,
            fromMe: null,
          }),
          participantId,
        },
      ]);

      const { rows } = await pool.query(
        `SELECT from_me FROM messages WHERE dedupe_key = 'fromme-null-001'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].from_me).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // T004: countReadableByGroup
  // -------------------------------------------------------------------------

  describe("countReadableByGroup", () => {
    it("returns 0 for an empty group", async () => {
      const groupId = await upsertGroup(pool, { name: "count-empty-group", source: "import" });
      const count = await countReadableByGroup(pool, groupId);
      expect(count).toBe(0);
    });

    it("excludes system messages", async () => {
      const groupId = await upsertGroup(pool, { name: "count-system-group", source: "import" });
      const participantId = await upsertParticipant(pool, "count-system-sender");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "count-sys-001",
            messageType: "system",
            senderName: null,
            textContent: "You were added",
          }),
          participantId: null,
        },
        {
          ...makeMsg({
            groupId,
            dedupeKey: "count-text-001",
            messageType: "text",
            textContent: "Hello",
          }),
          participantId,
        },
      ]);

      const count = await countReadableByGroup(pool, groupId);
      expect(count).toBe(1); // only the text message
    });

    it("excludes messages with null or empty text_content (and no completed transcript)", async () => {
      const groupId = await upsertGroup(pool, {
        name: "count-empty-content-group",
        source: "import",
      });
      const participantId = await upsertParticipant(pool, "count-empty-sender");

      await insertMessages(pool, [
        // media with no text content, no transcript → excluded
        {
          ...makeMsg({
            groupId,
            dedupeKey: "count-media-notext-001",
            messageType: "media",
            textContent: null,
            mediaFilename: "audio.opus",
          }),
          participantId,
        },
        // text but whitespace-only → excluded (length(trim(...)) = 0)
        {
          ...makeMsg({
            groupId,
            dedupeKey: "count-ws-001",
            messageType: "text",
            textContent: "   ",
          }),
          participantId,
        },
        // good text → included
        {
          ...makeMsg({
            groupId,
            dedupeKey: "count-good-001",
            messageType: "text",
            textContent: "Good message",
          }),
          participantId,
        },
      ]);

      const count = await countReadableByGroup(pool, groupId);
      expect(count).toBe(1);
    });

    it("counts a voice note that has a completed transcript (transcript-substituted)", async () => {
      const groupId = await upsertGroup(pool, { name: "count-vn-group", source: "import" });
      const participantId = await upsertParticipant(pool, "count-vn-sender");

      const result = await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "count-vn-001",
            messageType: "media",
            textContent: null,
            mediaFilename: "voice.opus",
            mediaPath: "/tmp/voice.opus",
            mediaStatus: "present",
          }),
          participantId,
        },
      ]);

      const messageId = result.ids[0]!;

      // Insert a completed transcript for the voice note
      await pool.query(
        `INSERT INTO transcripts (message_id, status, engine, transcript) VALUES ($1, 'completed', 'whisper', 'This is the transcript')`,
        [messageId],
      );

      const count = await countReadableByGroup(pool, groupId);
      expect(count).toBe(1);
    });

    it("does NOT count a voice note with only a failed (non-completed) transcript", async () => {
      const groupId = await upsertGroup(pool, { name: "count-vn-pending-group", source: "import" });
      const participantId = await upsertParticipant(pool, "count-vn-pending-sender");

      const result = await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "count-vn-pending-001",
            messageType: "media",
            textContent: null,
            mediaFilename: "voice.opus",
            mediaPath: "/tmp/voice.opus",
            mediaStatus: "present",
          }),
          participantId,
        },
      ]);

      const messageId = result.ids[0]!;

      // Insert a failed transcript — NOT completed, so not substituted
      await pool.query(
        `INSERT INTO transcripts (message_id, status, engine, error_message) VALUES ($1, 'failed', 'whisper', 'transcription error')`,
        [messageId],
      );

      const count = await countReadableByGroup(pool, groupId);
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // T004: getNewestAnchor
  // -------------------------------------------------------------------------

  describe("getNewestAnchor", () => {
    it("returns null for a group with no messages", async () => {
      const groupId = await upsertGroup(pool, { name: "anchor-empty-group", source: "import" });
      const anchor = await getNewestAnchor(pool, groupId);
      expect(anchor).toBeNull();
    });

    it("returns null for a group with only import rows (external_id null)", async () => {
      const groupId = await upsertGroup(pool, {
        name: "anchor-import-only-group",
        source: "import",
      });
      const participantId = await upsertParticipant(pool, "anchor-import-sender");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "anchor-import-001",
            externalId: null,
            sentAt: new Date("2024-01-15T10:00:00.000Z"),
          }),
          participantId,
        },
      ]);

      const anchor = await getNewestAnchor(pool, groupId);
      expect(anchor).toBeNull();
    });

    it("returns null when the group has no whatsapp_id", async () => {
      // upsertGroup does NOT set whatsapp_id
      const groupId = await upsertGroup(pool, { name: "anchor-no-jid-group", source: "import" });
      const participantId = await upsertParticipant(pool, "anchor-no-jid-sender");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "anchor-no-jid-001",
            externalId: "EXT-NO-JID-001",
            sentAt: new Date("2024-01-15T10:00:00.000Z"),
          }),
          participantId,
        },
      ]);

      const anchor = await getNewestAnchor(pool, groupId);
      expect(anchor).toBeNull();
    });

    it("returns the newest anchor with correct fields including remoteJid and fromMe", async () => {
      // Create a group with whatsapp_id
      const groupJid = "anchor-test-group@g.us";
      await pool.query(
        `INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live') ON CONFLICT (tenant_id, name) DO NOTHING`,
        [groupJid, "anchor-live-group"],
      );
      const { rows: gRows } = await pool.query(`SELECT id FROM groups WHERE whatsapp_id = $1`, [
        groupJid,
      ]);
      const groupId = Number(gRows[0]!.id);

      const participantId = await upsertParticipant(pool, "anchor-live-sender");

      const older = new Date("2024-01-10T10:00:00.000Z");
      const newer = new Date("2024-01-20T10:00:00.000Z");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "anchor-live-older-001",
            externalId: "EXT-ANCHOR-OLD",
            sentAt: older,
            fromMe: false,
          }),
          participantId,
        },
        {
          ...makeMsg({
            groupId,
            dedupeKey: "anchor-live-newer-001",
            externalId: "EXT-ANCHOR-NEW",
            sentAt: newer,
            fromMe: true,
          }),
          participantId,
        },
        // An import row with null external_id — must NOT be returned
        {
          ...makeMsg({
            groupId,
            dedupeKey: "anchor-live-import-001",
            externalId: null,
            sentAt: new Date("2024-01-25T10:00:00.000Z"),
          }),
          participantId,
        },
      ]);

      const anchor = await getNewestAnchor(pool, groupId);
      expect(anchor).not.toBeNull();
      expect(anchor!.externalId).toBe("EXT-ANCHOR-NEW");
      expect(anchor!.sentAt).toEqual(newer);
      expect(anchor!.fromMe).toBe(true);
      expect(anchor!.remoteJid).toBe(groupJid);
    });

    it("coalesces from_me=null to false", async () => {
      const groupJid = "anchor-fromme-null@g.us";
      await pool.query(
        `INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live') ON CONFLICT (tenant_id, name) DO NOTHING`,
        [groupJid, "anchor-fromme-null-group"],
      );
      const { rows: gRows } = await pool.query(`SELECT id FROM groups WHERE whatsapp_id = $1`, [
        groupJid,
      ]);
      const groupId = Number(gRows[0]!.id);
      const participantId = await upsertParticipant(pool, "anchor-null-fromme-sender");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "anchor-null-fromme-001",
            externalId: "EXT-NULL-FROMME",
            sentAt: new Date("2024-02-01T10:00:00.000Z"),
            fromMe: null,
          }),
          participantId,
        },
      ]);

      const anchor = await getNewestAnchor(pool, groupId);
      expect(anchor).not.toBeNull();
      expect(anchor!.fromMe).toBe(false);
    });

    it("orders by (sent_at DESC, id DESC) to pick the newest", async () => {
      const groupJid = "anchor-order@g.us";
      await pool.query(
        `INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live') ON CONFLICT (tenant_id, name) DO NOTHING`,
        [groupJid, "anchor-order-group"],
      );
      const { rows: gRows } = await pool.query(`SELECT id FROM groups WHERE whatsapp_id = $1`, [
        groupJid,
      ]);
      const groupId = Number(gRows[0]!.id);
      const participantId = await upsertParticipant(pool, "anchor-order-sender");

      const sameTime = new Date("2024-03-01T12:00:00.000Z");

      // Insert two messages with same sent_at — id DESC should pick the second (higher id)
      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "anchor-order-first",
            externalId: "EXT-ORDER-FIRST",
            sentAt: sameTime,
          }),
          participantId,
        },
      ]);
      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "anchor-order-second",
            externalId: "EXT-ORDER-SECOND",
            sentAt: sameTime,
          }),
          participantId,
        },
      ]);

      const anchor = await getNewestAnchor(pool, groupId);
      expect(anchor).not.toBeNull();
      // Higher id is the second one inserted
      expect(anchor!.externalId).toBe("EXT-ORDER-SECOND");
    });
  });

  // -------------------------------------------------------------------------
  // getOldestSentAt
  // -------------------------------------------------------------------------

  describe("getOldestSentAt", () => {
    it("returns null for an empty group", async () => {
      const groupId = await upsertGroup(pool, { name: "oldest-empty-group", source: "import" });
      const oldest = await getOldestSentAt(pool, groupId);
      expect(oldest).toBeNull();
    });

    it("returns the oldest sent_at among readable messages", async () => {
      const groupId = await upsertGroup(pool, { name: "oldest-basic-group", source: "import" });
      const participantId = await upsertParticipant(pool, "oldest-sender");

      const early = new Date("2024-01-05T08:00:00.000Z");
      const late = new Date("2024-06-20T18:00:00.000Z");

      await insertMessages(pool, [
        {
          ...makeMsg({ groupId, dedupeKey: "oldest-late-001", sentAt: late, textContent: "later" }),
          participantId,
        },
        {
          ...makeMsg({
            groupId,
            dedupeKey: "oldest-early-001",
            sentAt: early,
            textContent: "earlier",
          }),
          participantId,
        },
      ]);

      const oldest = await getOldestSentAt(pool, groupId);
      expect(oldest).not.toBeNull();
      expect(oldest!.getTime()).toBe(early.getTime());
    });

    it("ignores system messages when computing the minimum", async () => {
      const groupId = await upsertGroup(pool, { name: "oldest-system-group", source: "import" });
      const participantId = await upsertParticipant(pool, "oldest-sys-sender");

      const sysDate = new Date("2020-01-01T00:00:00.000Z"); // very old system message
      const textDate = new Date("2024-03-15T12:00:00.000Z");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "oldest-sys-001",
            messageType: "system",
            senderName: null,
            textContent: "You were added",
            sentAt: sysDate,
          }),
          participantId: null,
        },
        {
          ...makeMsg({
            groupId,
            dedupeKey: "oldest-text-001",
            messageType: "text",
            textContent: "Hello",
            sentAt: textDate,
          }),
          participantId,
        },
      ]);

      const oldest = await getOldestSentAt(pool, groupId);
      expect(oldest).not.toBeNull();
      // Should return textDate, not sysDate (system messages excluded)
      expect(oldest!.getTime()).toBe(textDate.getTime());
    });

    it("ignores messages with null/empty content", async () => {
      const groupId = await upsertGroup(pool, {
        name: "oldest-nullcontent-group",
        source: "import",
      });
      const participantId = await upsertParticipant(pool, "oldest-nullcontent-sender");

      const mediaDate = new Date("2022-05-01T10:00:00.000Z"); // media with no content
      const textDate = new Date("2024-08-10T14:00:00.000Z");

      await insertMessages(pool, [
        {
          ...makeMsg({
            groupId,
            dedupeKey: "oldest-media-001",
            messageType: "media",
            textContent: null,
            mediaFilename: "img.jpg",
            sentAt: mediaDate,
          }),
          participantId,
        },
        {
          ...makeMsg({
            groupId,
            dedupeKey: "oldest-hastext-001",
            textContent: "Hi",
            sentAt: textDate,
          }),
          participantId,
        },
      ]);

      const oldest = await getOldestSentAt(pool, groupId);
      expect(oldest).not.toBeNull();
      expect(oldest!.getTime()).toBe(textDate.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // Shared seed helpers for the lookup / update tests below
  // -------------------------------------------------------------------------

  async function seedGroup(name: string): Promise<number> {
    return upsertGroup(pool, { name, source: "import" });
  }

  async function seedMessageWithExternalId(groupId: number, externalId: string): Promise<number> {
    const participantId = await upsertParticipant(pool, `participant-${externalId}`);
    const result = await insertMessages(pool, [
      {
        ...makeMsg({
          groupId,
          dedupeKey: `dedupe-${externalId}-${Math.random()}`,
          externalId,
        }),
        participantId,
      },
    ]);
    return Number(result.ids[0]!);
  }

  // -------------------------------------------------------------------------
  // getMessageIdByExternalId
  // -------------------------------------------------------------------------

  describe("getMessageIdByExternalId", () => {
    it("returns { id, mediaStatus } for an existing row and null when not found", async () => {
      const groupId = await seedGroup("getid-basic-group");
      const id = await seedMessageWithExternalId(groupId, "EXT-1");

      const result = await getMessageIdByExternalId(pool, groupId, "EXT-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(id);
      // seedMessageWithExternalId uses makeMsg which has mediaStatus: null
      expect(result!.mediaStatus).toBeNull();

      expect(await getMessageIdByExternalId(pool, groupId, "NOPE")).toBeNull();
    });

    it("reflects the actual media_status stored on the row", async () => {
      const groupId = await seedGroup("getid-mediastatus-group");
      const id = await seedMessageWithExternalId(groupId, "EXT-MS-1");
      await markMessageMediaPresent(pool, id, "/tmp/test.jpg");

      const result = await getMessageIdByExternalId(pool, groupId, "EXT-MS-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(id);
      expect(result!.mediaStatus).toBe("present");
    });
  });

  // -------------------------------------------------------------------------
  // markMessageMediaPresent
  // -------------------------------------------------------------------------

  describe("markMessageMediaPresent", () => {
    it("sets media_path and media_status='present'", async () => {
      const groupId = await seedGroup("mark-media-group");
      const id = await seedMessageWithExternalId(groupId, "EXT-2");
      await markMessageMediaPresent(pool, id, "/data/media/live/x.jpg");
      const { rows } = await pool.query(
        "SELECT media_path, media_status FROM messages WHERE id=$1",
        [id],
      );
      expect(rows[0].media_path).toBe("/data/media/live/x.jpg");
      expect(rows[0].media_status).toBe("present");
    });

    it("backfills a blank media_filename from the path basename (so the analyzer can classify it)", async () => {
      const groupId = await seedGroup("mark-media-filename-blank");
      const id = await seedMessageWithExternalId(groupId, "EXT-FN-BLANK");
      // Deferred-backfill rows arrive with no filename.
      await pool.query("UPDATE messages SET media_filename='' WHERE id=$1", [id]);

      await markMessageMediaPresent(pool, id, "/data/media/backfill/bf-123.jpg");

      const { rows } = await pool.query("SELECT media_filename FROM messages WHERE id=$1", [id]);
      expect(rows[0].media_filename).toBe("bf-123.jpg");
    });

    it("preserves an existing non-blank media_filename", async () => {
      const groupId = await seedGroup("mark-media-filename-keep");
      const id = await seedMessageWithExternalId(groupId, "EXT-FN-KEEP");
      await pool.query("UPDATE messages SET media_filename='IMG-001.jpg' WHERE id=$1", [id]);

      await markMessageMediaPresent(pool, id, "/data/media/backfill/bf-999.mp4");

      const { rows } = await pool.query("SELECT media_filename FROM messages WHERE id=$1", [id]);
      expect(rows[0].media_filename).toBe("IMG-001.jpg");
    });
  });

  // -------------------------------------------------------------------------
  // getMessagesAround
  // -------------------------------------------------------------------------

  describe("getMessagesAround", () => {
    it("returns a window centered on the anchor, ascending, with sender + text", async () => {
      const groupId = await seedGroup("around-window");
      const ids: number[] = [];
      for (let i = 1; i <= 5; i++) {
        ids.push(await seedMessageWithExternalId(groupId, `AROUND-${i}`));
      }
      const [, m2, m3, m4, m5] = ids;

      const rows = await getMessagesAround(pool, groupId, m3!, 4);

      expect(rows.map((r) => r.id)).toEqual([m2, m3, m4, m5]);
      const anchor = rows.find((r) => r.id === m3)!;
      expect(typeof anchor.text).toBe("string");
      expect(anchor.text.length).toBeGreaterThan(0);
      expect(typeof anchor.sender).toBe("string");
      expect(typeof anchor.fromMe).toBe("boolean");
    });

    it("returns [] when the anchor is in a different group", async () => {
      const g1 = await seedGroup("around-g1");
      const g2 = await seedGroup("around-g2");
      const id = await seedMessageWithExternalId(g1, "AROUND-OTHER");
      expect(await getMessagesAround(pool, g2, id, 4)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getRecentMessages
  // -------------------------------------------------------------------------

  describe("getRecentMessages", () => {
    it("returns the most recent N messages ascending, with sender + text", async () => {
      const groupId = await seedGroup("recent-window");
      const ids: number[] = [];
      for (let i = 1; i <= 5; i++) {
        ids.push(await seedMessageWithExternalId(groupId, `RECENT-${i}`));
      }
      const [, , m3, m4, m5] = ids;

      const rows = await getRecentMessages(pool, groupId, 3);

      expect(rows.map((r) => r.id)).toEqual([m3, m4, m5]);
      const last = rows.find((r) => r.id === m5)!;
      expect(typeof last.text).toBe("string");
      expect(typeof last.sender).toBe("string");
      expect(typeof last.fromMe).toBe("boolean");
    });

    it("returns [] for a group with no messages", async () => {
      const groupId = await seedGroup("recent-empty");
      expect(await getRecentMessages(pool, groupId, 4)).toEqual([]);
    });
  });
});
