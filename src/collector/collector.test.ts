/**
 * Integration tests for collector.ts (uses testcontainers PostgreSQL).
 * Tests that handleIncomingMessage persists live messages correctly,
 * including deduplication.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordLink } from "../db/repositories/identity-links.js";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import { createTestDatabase } from "../test/db.js";
import { handleIncomingMessage } from "./collector.js";

// ---------------------------------------------------------------------------
// Fake Baileys message factories
// ---------------------------------------------------------------------------

function makeFakeWATextMessage(
  overrides: Partial<{
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant: string;
    pushName: string;
    timestampSeconds: number;
    text: string;
  }> = {},
): WAMessage {
  const {
    id = "LIVE_MSG_001",
    remoteJid = "111222333-444555666@g.us",
    fromMe = false,
    pushName = "TestSender",
    timestampSeconds = 1700001000,
    text = "Live text message",
  } = overrides;

  return {
    key: {
      id,
      remoteJid,
      fromMe,
    },
    messageTimestamp: timestampSeconds,
    pushName,
    message: {
      conversation: text,
    },
  } as unknown as WAMessage;
}

function makeFakeWAImageMessage(
  overrides: Partial<{
    id: string;
    remoteJid: string;
    pushName: string;
    timestampSeconds: number;
  }> = {},
): WAMessage {
  const {
    id = "LIVE_IMG_001",
    remoteJid = "111222333-444555666@g.us",
    pushName = "ImgSender",
    timestampSeconds = 1700008000,
  } = overrides;

  return {
    key: {
      id,
      remoteJid,
      fromMe: false,
    },
    messageTimestamp: timestampSeconds,
    pushName,
    message: {
      imageMessage: {
        mediaKey: new Uint8Array([1, 2, 3, 4]),
        directPath: "/v/t62.7117-24/fake-direct-path",
        url: "https://mmg.whatsapp.net/fake-url",
        mimetype: "image/jpeg",
      },
    },
  } as unknown as WAMessage;
}

function makeFakeWAStickerMessage(
  overrides: Partial<{
    id: string;
    remoteJid: string;
    pushName: string;
    timestampSeconds: number;
  }> = {},
): WAMessage {
  const {
    id = "LIVE_STICKER_001",
    remoteJid = "111222333-444555666@g.us",
    pushName = "StickerSender",
    timestampSeconds = 1700009000,
  } = overrides;

  return {
    key: {
      id,
      remoteJid,
      fromMe: false,
    },
    messageTimestamp: timestampSeconds,
    pushName,
    message: {
      stickerMessage: {
        mediaKey: new Uint8Array([5, 6, 7, 8]),
        directPath: "/v/t62.7117-24/fake-sticker-path",
        url: "https://mmg.whatsapp.net/fake-sticker-url",
        mimetype: "image/webp",
      },
    },
  } as unknown as WAMessage;
}

function makeFakeWAVoiceNoteMessage(
  overrides: Partial<{
    id: string;
    remoteJid: string;
    pushName: string;
    timestampSeconds: number;
  }> = {},
): WAMessage {
  const {
    id = "LIVE_VOICE_001",
    remoteJid = "111222333-444555666@g.us",
    pushName = "VoiceSender",
    timestampSeconds = 1700007000,
  } = overrides;

  return {
    key: {
      id,
      remoteJid,
      fromMe: false,
    },
    messageTimestamp: timestampSeconds,
    pushName,
    message: {
      audioMessage: {
        seconds: 15,
        ptt: true,
      },
    },
  } as unknown as WAMessage;
}

/** A fake voice-note media downloader (returns deterministic bytes). */
const FAKE_AUDIO = Buffer.from("fake-opus-audio-bytes");
const fakeDownloader = async () => FAKE_AUDIO;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("collector integration", () => {
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-collector-test-"));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it("stores a live text message with source='live' and external_id set", async () => {
    const waMsg = makeFakeWATextMessage({
      id: "EXT_001",
      remoteJid: "111@g.us",
      pushName: "Alice",
      text: "Hello from live",
      timestampSeconds: 1700002000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir });
    expect(stored).toBe(true);

    const { rows } = await pool.query(
      `SELECT source, external_id, text_content, sent_at FROM messages WHERE external_id = $1`,
      ["EXT_001"],
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.source).toBe("live");
    expect(row.external_id).toBe("EXT_001");
    expect(row.text_content).toBe("Hello from live");
    expect(new Date(row.sent_at).getTime()).toBe(1700002000 * 1000);
  });

  it("creates a group row with source='live' for the remoteJid", async () => {
    const waMsg = makeFakeWATextMessage({
      id: "EXT_002",
      remoteJid: "222@g.us",
      pushName: "Bob",
      text: "Group test",
      timestampSeconds: 1700003000,
    });

    await handleIncomingMessage(pool, waMsg, { dataDir });

    const { rows } = await pool.query(
      `SELECT whatsapp_id, source FROM groups WHERE whatsapp_id = $1`,
      ["222@g.us"],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("live");
  });

  it("deduplicates: storing the same message twice stores it once", async () => {
    const waMsg = makeFakeWATextMessage({
      id: "EXT_DUPE_001",
      remoteJid: "333@g.us",
      pushName: "Carol",
      text: "Dedupe test message",
      timestampSeconds: 1700004000,
    });

    const first = await handleIncomingMessage(pool, waMsg, { dataDir });
    const second = await handleIncomingMessage(pool, waMsg, { dataDir });

    expect(first).toBe(true);
    expect(second).toBe(false); // duplicate, not stored again

    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages WHERE external_id = $1`,
      ["EXT_DUPE_001"],
    );
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it("stores sender as a participant", async () => {
    const waMsg = makeFakeWATextMessage({
      id: "EXT_PART_001",
      remoteJid: "444@g.us",
      pushName: "Dana",
      text: "Participant test",
      timestampSeconds: 1700005000,
    });

    await handleIncomingMessage(pool, waMsg, { dataDir });

    const { rows } = await pool.query(
      `SELECT p.display_name FROM messages m JOIN participants p ON p.id = m.participant_id WHERE m.external_id = $1`,
      ["EXT_PART_001"],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].display_name).toBe("Dana");
  });

  it("sets source to 'mixed' when an import group already exists for the same JID", async () => {
    // First, insert an import group with whatsapp_id set
    await pool.query(`INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, $3)`, [
      "555@g.us",
      "Pre-existing Import Group",
      "import",
    ]);

    const waMsg = makeFakeWATextMessage({
      id: "EXT_MIXED_001",
      remoteJid: "555@g.us",
      pushName: "Eve",
      text: "Mixed source test",
      timestampSeconds: 1700006000,
    });

    await handleIncomingMessage(pool, waMsg, { dataDir });

    const { rows } = await pool.query(`SELECT source FROM groups WHERE whatsapp_id = $1`, [
      "555@g.us",
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("mixed");
  });

  // ---------------------------------------------------------------------------
  // T040 — enqueue transcribe.voicenote for new voice notes
  // ---------------------------------------------------------------------------

  it("enqueues exactly one transcribe.voicenote job when a NEW voice note is stored", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAVoiceNoteMessage({
      id: "EXT_VN_ENQUEUE_001",
      remoteJid: "enqueue-vn@g.us",
      pushName: "Fay",
      timestampSeconds: 1700010000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVoiceNote: fakeDownloader,
    });
    expect(stored).toBe(true);

    // Exactly one job enqueued
    expect(recorder.enqueuedJobs.length).toBe(1);
    const enqueued = recorder.enqueuedJobs[0]!;
    expect(enqueued.job.type).toBe("transcribe.voicenote");

    // The messageId must be a non-empty string (the DB row id)
    const { messageId } = enqueued.job.payload as { messageId: string };
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);

    // Verify the messageId actually corresponds to a real messages row with
    // downloaded, present media (so the worker can transcribe it).
    const { rows } = await pool.query(
      `SELECT id, media_filename, media_path, media_status FROM messages WHERE external_id = $1`,
      ["EXT_VN_ENQUEUE_001"],
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0].id)).toBe(messageId);
    expect(rows[0].media_status).toBe("present");
    expect(rows[0].media_filename).toMatch(/\.opus$/);
    expect(rows[0].media_path).toBeTruthy();
  });

  it("downloads voice-note media to disk and marks it present (transcribable)", async () => {
    const waMsg = makeFakeWAVoiceNoteMessage({
      id: "EXT_VN_DL_001",
      remoteJid: "vn-dl@g.us",
      pushName: "Mia",
      timestampSeconds: 1700020000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      downloadVoiceNote: fakeDownloader,
    });
    expect(stored).toBe(true);

    const { rows } = await pool.query(
      `SELECT media_filename, media_path, media_status, message_type FROM messages WHERE external_id = $1`,
      ["EXT_VN_DL_001"],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].message_type).toBe("media");
    expect(rows[0].media_status).toBe("present");
    expect(rows[0].media_filename).toMatch(/^live-EXT_VN_DL_001\.opus$/);
    // The file was actually written with the downloaded bytes.
    expect(fs.existsSync(rows[0].media_path)).toBe(true);
    expect(fs.readFileSync(rows[0].media_path).equals(FAKE_AUDIO)).toBe(true);
  });

  it("marks media 'missing' and does NOT enqueue when the download fails", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const failingDownloader = async () => {
      throw new Error("download boom");
    };

    const waMsg = makeFakeWAVoiceNoteMessage({
      id: "EXT_VN_DLFAIL_001",
      remoteJid: "vn-dlfail@g.us",
      pushName: "Noa",
      timestampSeconds: 1700021000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVoiceNote: failingDownloader,
    });
    expect(stored).toBe(true); // the message row is still recorded

    const { rows } = await pool.query(
      `SELECT media_status, media_path FROM messages WHERE external_id = $1`,
      ["EXT_VN_DLFAIL_001"],
    );
    expect(rows[0].media_status).toBe("missing");
    expect(rows[0].media_path).toBeNull();
    // No dead job: a note without media is not enqueued.
    expect(recorder.enqueuedJobs.length).toBe(0);
  });

  it("does NOT enqueue a voice note when no downloader is provided (no media to transcribe)", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAVoiceNoteMessage({
      id: "EXT_VN_NODL_001",
      remoteJid: "vn-nodl@g.us",
      pushName: "Omri",
      timestampSeconds: 1700022000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir, bus });
    expect(stored).toBe(true);
    expect(recorder.enqueuedJobs.length).toBe(0);
  });

  it("does NOT enqueue a job for a non-voice-note (text) message", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWATextMessage({
      id: "EXT_TEXT_NOQUEUE_001",
      remoteJid: "text-noqueue@g.us",
      pushName: "Gail",
      text: "Just a text",
      timestampSeconds: 1700011000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir, bus });
    expect(stored).toBe(true);
    expect(recorder.enqueuedJobs.length).toBe(0);
  });

  it("does NOT enqueue a job for a DUPLICATE voice note (already-stored)", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAVoiceNoteMessage({
      id: "EXT_VN_DUPE_001",
      remoteJid: "vn-dupe@g.us",
      pushName: "Harry",
      timestampSeconds: 1700012000,
    });

    // First insertion — should enqueue (media downloaded → present)
    const first = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVoiceNote: fakeDownloader,
    });
    expect(first).toBe(true);
    expect(recorder.enqueuedJobs.length).toBe(1);

    // Second insertion (duplicate) — should NOT enqueue again
    const second = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVoiceNote: fakeDownloader,
    });
    expect(second).toBe(false);
    expect(recorder.enqueuedJobs.length).toBe(1); // still only 1
  });

  it("does NOT enqueue when no bus is provided (backward-compatible collect path)", async () => {
    // No bus — just confirm the function still returns true and no error thrown
    const waMsg = makeFakeWAVoiceNoteMessage({
      id: "EXT_VN_NOBUS_001",
      remoteJid: "no-bus@g.us",
      pushName: "Iris",
      timestampSeconds: 1700013000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir });
    expect(stored).toBe(true);
    // No assertion on bus — just verifying no crash and correct return value
  });

  // ---------------------------------------------------------------------------
  // T021 — display-name resolution
  // ---------------------------------------------------------------------------

  it("T021: group JID (@g.us) gets its name updated to the groupSubject return value", async () => {
    const jid = "resolve-group-001@g.us";
    let groupSubjectCallCount = 0;
    const groupSubject = async (_jid: string) => {
      groupSubjectCallCount++;
      return "My Resolved Group";
    };

    const waMsg = makeFakeWATextMessage({
      id: "EXT_DN_GRP_001",
      remoteJid: jid,
      pushName: "Someone",
      text: "hello",
      timestampSeconds: 1700030000,
    });

    await handleIncomingMessage(pool, waMsg, { dataDir, groupSubject });

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("My Resolved Group");
    expect(groupSubjectCallCount).toBe(1);
  });

  it("T021: 1:1 JID (@s.whatsapp.net) gets its name updated to pushName", async () => {
    const jid = "1234567890@s.whatsapp.net";

    const waMsg = makeFakeWATextMessage({
      id: "EXT_DN_11_001",
      remoteJid: jid,
      pushName: "Alice",
      text: "hey",
      timestampSeconds: 1700031000,
    });

    await handleIncomingMessage(pool, waMsg, { dataDir });

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("Alice");
  });

  it("T021: groupSubject that throws leaves name as the raw JID (resolution failure is non-fatal; message still stored)", async () => {
    const jid = "resolve-fail-001@g.us";
    const groupSubject = async (_jid: string): Promise<string> => {
      throw new Error("network error");
    };

    const waMsg = makeFakeWATextMessage({
      id: "EXT_DN_FAIL_001",
      remoteJid: jid,
      pushName: "Bob",
      text: "testing",
      timestampSeconds: 1700032000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir, groupSubject });
    expect(stored).toBe(true); // message was still stored

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    // Name stays as the raw JID (unchanged)
    expect(rows[0].name).toBe(jid);
  });

  it("T021: second message for an already-resolved group does NOT call groupSubject again and leaves name unchanged", async () => {
    const jid = "resolve-once-001@g.us";
    let groupSubjectCallCount = 0;
    const groupSubject = async (_jid: string) => {
      groupSubjectCallCount++;
      return "Resolved Once";
    };

    const firstMsg = makeFakeWATextMessage({
      id: "EXT_DN_ONCE_001",
      remoteJid: jid,
      pushName: "Carol",
      text: "first message",
      timestampSeconds: 1700033000,
    });
    const secondMsg = makeFakeWATextMessage({
      id: "EXT_DN_ONCE_002",
      remoteJid: jid,
      pushName: "Carol",
      text: "second message",
      timestampSeconds: 1700033001,
    });

    await handleIncomingMessage(pool, firstMsg, { dataDir, groupSubject });
    await handleIncomingMessage(pool, secondMsg, { dataDir, groupSubject });

    // groupSubject called exactly once (first message) — gate prevents second call
    expect(groupSubjectCallCount).toBe(1);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("Resolved Once");
  });

  it("T021-lid: @lid JID gets its name updated to pushName (same as @s.whatsapp.net treatment)", async () => {
    const jid = "70390252580989@lid";

    const waMsg = makeFakeWATextMessage({
      id: "EXT_DN_LID_001",
      remoteJid: jid,
      pushName: "Lid Person",
      text: "message from lid",
      timestampSeconds: 1700034000,
    });

    await handleIncomingMessage(pool, waMsg, { dataDir });

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("Lid Person");
  });

  it("T021-lid: groupSubject is NOT called for @lid JIDs (must never call groupSubject for @lid)", async () => {
    const jid = "99887766554433@lid";
    let groupSubjectCalled = false;
    const groupSubject = async (_jid: string) => {
      groupSubjectCalled = true;
      return "Should Not Be Used";
    };

    const waMsg = makeFakeWATextMessage({
      id: "EXT_DN_LID_002",
      remoteJid: jid,
      pushName: "Another Lid Person",
      text: "another lid message",
      timestampSeconds: 1700035000,
    });

    await handleIncomingMessage(pool, waMsg, { dataDir, groupSubject });

    expect(groupSubjectCalled).toBe(false);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("Another Lid Person");
  });

  // ---------------------------------------------------------------------------
  // Deferred media descriptor tests (Task 5)
  // ---------------------------------------------------------------------------

  type Recorded = { messageId: number; kind: string; state: string };

  it("descriptor: persists a pending descriptor for an onboarding image (no downloaders)", async () => {
    const recorded: Recorded[] = [];
    const persistMediaDescriptor = async (
      messageId: number,
      descriptor: { mediaKind: string },
      state: "pending" | "present",
    ) => {
      recorded.push({ messageId, kind: descriptor.mediaKind, state });
    };

    const waMsg = makeFakeWAImageMessage({
      id: "DESC_PENDING_001",
      remoteJid: "desc-pending@g.us",
      pushName: "PendingSender",
      timestampSeconds: 1700050000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir, persistMediaDescriptor });
    expect(stored).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("image");
    expect(recorded[0]!.state).toBe("pending");
  });

  it("descriptor: re-pull of an already-stored image still persists/refreshes the descriptor", async () => {
    const waMsg = makeFakeWAImageMessage({
      id: "DESC_REPULL_001",
      remoteJid: "desc-repull@g.us",
      pushName: "RepullSender",
      timestampSeconds: 1700051000,
    });

    // First insertion — store without a descriptor spy to get the row in.
    const first = await handleIncomingMessage(pool, waMsg, { dataDir });
    expect(first).toBe(true);

    // Fetch the inserted message id from DB.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE external_id = $1`,
      ["DESC_REPULL_001"],
    );
    const existingId = Number(rows[0]!.id);
    expect(existingId).toBeGreaterThan(0);

    // Second call (duplicate) — spy should still be called for the existing row.
    const recorded: Recorded[] = [];
    const persistMediaDescriptor = async (
      messageId: number,
      descriptor: { mediaKind: string },
      state: "pending" | "present",
    ) => {
      recorded.push({ messageId, kind: descriptor.mediaKind, state });
    };

    const second = await handleIncomingMessage(pool, waMsg, { dataDir, persistMediaDescriptor });
    expect(second).toBe(false); // still a duplicate, no new row
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.messageId).toBe(existingId);
    expect(recorded[0]!.kind).toBe("image");
    expect(recorded[0]!.state).toBe("pending");
  });

  it("descriptor: marks descriptor 'present' when the image is downloaded inline (live path)", async () => {
    const recorded: Recorded[] = [];
    const persistMediaDescriptor = async (
      messageId: number,
      descriptor: { mediaKind: string },
      state: "pending" | "present",
    ) => {
      recorded.push({ messageId, kind: descriptor.mediaKind, state });
    };

    const waMsg = makeFakeWAImageMessage({
      id: "DESC_PRESENT_001",
      remoteJid: "desc-present@g.us",
      pushName: "PresentSender",
      timestampSeconds: 1700052000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      persistMediaDescriptor,
      downloadImage: async () => Buffer.from([0xff, 0xd8, 0xff]),
    });
    expect(stored).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("image");
    expect(recorded[0]!.state).toBe("present");
  });

  // Fix 3: sticker/document descriptors must never be persisted
  it("descriptor: sticker message does NOT persist a descriptor (non-analyzable kind)", async () => {
    const recorded: Recorded[] = [];
    const persistMediaDescriptor = async (
      messageId: number,
      descriptor: { mediaKind: string },
      state: "pending" | "present",
    ) => {
      recorded.push({ messageId, kind: descriptor.mediaKind, state });
    };

    const waMsg = makeFakeWAStickerMessage({
      id: "DESC_STICKER_001",
      remoteJid: "desc-sticker@g.us",
      pushName: "StickerSender",
      timestampSeconds: 1700053000,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir, persistMediaDescriptor });
    expect(stored).toBe(true);
    // Stickers are not analyzable — no message_media row should be created.
    expect(recorded).toHaveLength(0);
  });

  // Fix 4a: re-pull of a legacy already-present message must yield state='present'
  it("descriptor: re-pull of a message with media_status='present' persists descriptor with state 'present'", async () => {
    const waMsg = makeFakeWAImageMessage({
      id: "DESC_LEGACY_PRESENT_001",
      remoteJid: "desc-legacy-present@g.us",
      pushName: "LegacySender",
      timestampSeconds: 1700054000,
    });

    // First insertion with a live downloader (sets media_status='present'), but
    // WITHOUT a persistMediaDescriptor — simulates a legacy row collected before
    // the deferred-media feature was added.
    const first = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      downloadImage: async () => Buffer.from([0xff, 0xd8, 0xff]),
    });
    expect(first).toBe(true);

    // Verify the row has media_status='present' but no message_media row yet.
    const { rows } = await pool.query<{ id: string; media_status: string }>(
      `SELECT id, media_status FROM messages WHERE external_id = $1`,
      ["DESC_LEGACY_PRESENT_001"],
    );
    expect(rows[0]!.media_status).toBe("present");

    // Second call (duplicate re-pull) — the descriptor spy must be called with
    // state='present' so the backfill loop won't re-download the existing file.
    const recorded: Recorded[] = [];
    const persistMediaDescriptor = async (
      messageId: number,
      descriptor: { mediaKind: string },
      state: "pending" | "present",
    ) => {
      recorded.push({ messageId, kind: descriptor.mediaKind, state });
    };

    const second = await handleIncomingMessage(pool, waMsg, { dataDir, persistMediaDescriptor });
    expect(second).toBe(false); // still a duplicate
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("image");
    expect(recorded[0]!.state).toBe("present"); // NOT 'pending'
  });

  // Fix 4b: re-pull of a pruned message must not call persistMediaDescriptor at all
  it("descriptor: re-pull of a message with media_status='pruned' does NOT persist a descriptor", async () => {
    const waMsg = makeFakeWAImageMessage({
      id: "DESC_PRUNED_001",
      remoteJid: "desc-pruned@g.us",
      pushName: "PrunedSender",
      timestampSeconds: 1700055000,
    });

    // First insertion (no downloader, no descriptor).
    const first = await handleIncomingMessage(pool, waMsg, { dataDir });
    expect(first).toBe(true);

    // Manually mark the row's media_status as 'pruned' to simulate a message
    // whose media was intentionally discarded.
    await pool.query(`UPDATE messages SET media_status='pruned' WHERE external_id = $1`, [
      "DESC_PRUNED_001",
    ]);

    // Second call (duplicate re-pull) — spy must NOT be called for a pruned row.
    const recorded: Recorded[] = [];
    const persistMediaDescriptor = async (
      messageId: number,
      descriptor: { mediaKind: string },
      state: "pending" | "present",
    ) => {
      recorded.push({ messageId, kind: descriptor.mediaKind, state });
    };

    const second = await handleIncomingMessage(pool, waMsg, { dataDir, persistMediaDescriptor });
    expect(second).toBe(false); // still a duplicate
    expect(recorded).toHaveLength(0); // pruned → skip entirely
  });
});

// ---------------------------------------------------------------------------
// Ingest identity-canonicalization (#17): a person's messages land in ONE chat
// regardless of which WhatsApp identity (@lid vs @s.whatsapp.net) they arrive
// under, so LID-migration duplicates stop re-forming.
// ---------------------------------------------------------------------------

/** Build a fake 1:1 WAMessage, optionally carrying an alternate identity on the key. */
function makeFakeWADmMessage(opts: {
  id: string;
  remoteJid: string;
  remoteJidAlt?: string;
  pushName?: string;
  text?: string;
  timestampSeconds?: number;
}): WAMessage {
  return {
    key: {
      id: opts.id,
      remoteJid: opts.remoteJid,
      remoteJidAlt: opts.remoteJidAlt,
      fromMe: false,
    },
    messageTimestamp: opts.timestampSeconds ?? 1700040000,
    pushName: opts.pushName ?? "Sender",
    message: { conversation: opts.text ?? "hi" },
  } as unknown as WAMessage;
}

describe("collector identity-canonicalization (#17)", () => {
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-collector-canon-test-"));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  async function groupIdForJid(jid: string): Promise<number | null> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [jid],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  it("routes a phone-JID message into the existing @lid chat via lidForPn (no duplicate group)", async () => {
    const lid = "4578552635558@lid";
    const pn = "972542795343@s.whatsapp.net";
    // The named survivor already exists under @lid.
    await pool.query(`INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live')`, [
      lid,
      "Noa",
    ]);
    const lidGroupId = await groupIdForJid(lid);

    const waMsg = makeFakeWADmMessage({
      id: "CANON_BRIDGE_001",
      remoteJid: pn,
      pushName: "Noa",
      text: "message under the phone identity",
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      lidForPn: async (j) => (j === pn ? lid : null),
      pnForLid: async () => null,
    });
    expect(stored).toBe(true);

    // The message landed in the existing @lid chat...
    const { rows } = await pool.query<{ group_id: string }>(
      `SELECT group_id FROM messages WHERE external_id = $1`,
      ["CANON_BRIDGE_001"],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.group_id)).toBe(lidGroupId);
    // ...and NO duplicate group was created under the phone JID.
    expect(await groupIdForJid(pn)).toBeNull();
    // Survivor keeps its resolved name (no UNIQUE(name) collision warning path).
    const named = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [lid]);
    expect(named.rows[0].name).toBe("Noa");
  });

  it("routes a @lid message into the existing phone-JID chat via pnForLid (reverse direction)", async () => {
    const pn = "972540000099@s.whatsapp.net";
    const lid = "9999999999999@lid";
    // The existing named chat is keyed under the phone JID this time.
    await pool.query(`INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live')`, [
      pn,
      "Phone-Keyed Person",
    ]);
    const pnGroupId = await groupIdForJid(pn);

    const waMsg = makeFakeWADmMessage({
      id: "CANON_REVERSE_001",
      remoteJid: lid,
      pushName: "Phone-Keyed Person",
      text: "message under the lid identity",
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      lidForPn: async () => null,
      pnForLid: async (j) => (j === lid ? pn : null),
    });
    expect(stored).toBe(true);

    const { rows } = await pool.query<{ group_id: string }>(
      `SELECT group_id FROM messages WHERE external_id = $1`,
      ["CANON_REVERSE_001"],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.group_id)).toBe(pnGroupId);
    expect(await groupIdForJid(lid)).toBeNull();
  });

  it("falls back to key.remoteJidAlt when the lid<->pn bridge is cold (returns null)", async () => {
    const lid = "1111111111111@lid";
    const pn = "972500000001@s.whatsapp.net";
    await pool.query(`INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live')`, [
      lid,
      "Cold Bridge Person",
    ]);
    const lidGroupId = await groupIdForJid(lid);

    const waMsg = makeFakeWADmMessage({
      id: "CANON_ALT_001",
      remoteJid: pn,
      remoteJidAlt: lid, // WhatsApp ships the alternate identity on the key itself
      pushName: "Cold Bridge Person",
      text: "bridge store not warm yet",
    });

    // Bridge returns null (store cold) — routing must use remoteJidAlt instead.
    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      lidForPn: async () => null,
      pnForLid: async () => null,
    });
    expect(stored).toBe(true);

    const { rows } = await pool.query<{ group_id: string }>(
      `SELECT group_id FROM messages WHERE external_id = $1`,
      ["CANON_ALT_001"],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.group_id)).toBe(lidGroupId);
    expect(await groupIdForJid(pn)).toBeNull();
  });

  it("creates a single chat keyed on the phone JID when the person has no existing chat", async () => {
    const pn = "972500000002@s.whatsapp.net";
    const lid = "2222222222222@lid";

    const waMsg = makeFakeWADmMessage({
      id: "CANON_FRESH_001",
      remoteJid: pn,
      pushName: "Brand New",
      text: "first ever message",
    });

    await handleIncomingMessage(pool, waMsg, {
      dataDir,
      lidForPn: async (j) => (j === pn ? lid : null),
      pnForLid: async () => null,
    });

    // No existing chat under either identity → new chat keyed on the phone JID.
    expect(await groupIdForJid(pn)).not.toBeNull();
    expect(await groupIdForJid(lid)).toBeNull();
  });
});

describe("DB-first identity canonicalization (cold live bridge)", () => {
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-collector-idlink-"));
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  }, 30_000);

  it("routes a pn-keyed message into the existing lid row using the DB map when the live bridge is cold", async () => {
    const lid = "123@lid";
    const pn = "972500000000@s.whatsapp.net";

    // A named lid chat already exists; a link maps lid <-> pn. tenant_id defaults
    // to the default tenant (no GUC set on this raw superuser pool).
    await pool.query("INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live')", [
      lid,
      "Dana",
    ]);
    await recordLink(pool, { lidJid: lid, pnJid: pn, source: "message_alt" });

    // A message arrives under the PN identity with the live bridge COLD (returns null).
    const waMsg = makeFakeWATextMessage({ id: "IDLINK_001", remoteJid: pn, pushName: "Dana" });
    await handleIncomingMessage(pool, waMsg, {
      dataDir,
      lidForPn: async () => null,
      pnForLid: async () => null,
    });

    // Exactly one row exists for this person — the message was routed into the lid row.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM groups WHERE whatsapp_id IN ($1, $2)",
      [lid, pn],
    );
    expect(rows[0].n).toBe(1);
  });

  it("routes a lid-keyed message into the existing pn row using the DB map when the live bridge is cold", async () => {
    const lid = "456@lid";
    const pn = "972511112222@s.whatsapp.net";

    // A named pn chat already exists; a link maps lid <-> pn.
    await pool.query("INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live')", [
      pn,
      "Roni",
    ]);
    await recordLink(pool, { lidJid: lid, pnJid: pn, source: "message_alt" });

    // A message arrives under the LID identity with the live bridge COLD.
    const waMsg = makeFakeWATextMessage({ id: "IDLINK_002", remoteJid: lid, pushName: "Roni" });
    await handleIncomingMessage(pool, waMsg, {
      dataDir,
      lidForPn: async () => null,
      pnForLid: async () => null,
    });

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM groups WHERE whatsapp_id IN ($1, $2)",
      [lid, pn],
    );
    expect(rows[0].n).toBe(1);
  });

  it("persists a freshly bridge-resolved pairing into identity_links", async () => {
    const lid = "999@lid";
    const pn = "972599998888@s.whatsapp.net";
    // No pre-existing link; a WARM bridge maps pn -> lid (a newly learned fact).
    const waMsg = makeFakeWATextMessage({ id: "IDLINK_003", remoteJid: pn, pushName: "Gil" });
    await handleIncomingMessage(pool, waMsg, {
      dataDir,
      lidForPn: async (j) => (j === pn ? lid : null),
      pnForLid: async () => null,
    });

    const { rows } = await pool.query(
      "SELECT lid_jid, pn_jid, source FROM identity_links WHERE pn_jid = $1",
      [pn],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].lid_jid).toBe(lid);
    expect(rows[0].source).toBe("message_alt");
  });
});
