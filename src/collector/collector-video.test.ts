/**
 * T020 (collector side) — Tests for video enqueue behavior in handleIncomingMessage.
 *
 * Verifies:
 * - Non-sticker video: downloaded (if downloadVideo provided), media_status='present', analyze.video enqueued
 * - Sticker: NOT enqueued for video
 * - Oversized/no downloadVideo: if thumbnail bytes available, thumbnail saved, analyze.video still enqueued
 * - No thumbnail either: NOT enqueued
 * - No downloadVideo provided: NOT enqueued
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import { createTestDatabase } from "../test/db.js";
import { handleIncomingMessage } from "./collector.js";

// ---------------------------------------------------------------------------
// Fake WAMessage factories
// ---------------------------------------------------------------------------

const FAKE_THUMBNAIL = Buffer.from("fake-jpeg-thumbnail-bytes");

function makeFakeWAVideoMessage(
  overrides: Partial<{
    id: string;
    remoteJid: string;
    pushName: string;
    timestampSeconds: number;
    caption: string | null;
    jpegThumbnail: Buffer | null;
  }> = {},
): WAMessage {
  const {
    id = "LIVE_VID_001",
    remoteJid = "vid-group@g.us",
    pushName = "VidSender",
    timestampSeconds = 1700300000,
    caption = null,
    jpegThumbnail = FAKE_THUMBNAIL,
  } = overrides;
  return {
    key: { id, remoteJid, fromMe: false },
    messageTimestamp: timestampSeconds,
    pushName,
    message: {
      videoMessage: {
        caption: caption ?? undefined,
        mimetype: "video/mp4",
        jpegThumbnail: jpegThumbnail ?? undefined,
      },
    },
  } as unknown as WAMessage;
}

const FAKE_VIDEO = Buffer.from("fake-mp4-bytes");
const fakeVideoDownloader = async () => FAKE_VIDEO;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collector video enqueue (T020)", () => {
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-collector-video-test-"));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it("enqueues analyze.video for a new non-sticker video when downloaded successfully", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAVideoMessage({
      id: "VID_ENQUEUE_001",
      remoteJid: "vid-enqueue@g.us",
      timestampSeconds: 1700300001,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVideo: fakeVideoDownloader,
    });
    expect(stored).toBe(true);

    const videoJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.video");
    expect(videoJobs).toHaveLength(1);
    const { messageId } = videoJobs[0]!.job.payload as { messageId: string };
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);

    // Verify the DB row has media_status='present'
    const { rows } = await pool.query(`SELECT media_status FROM messages WHERE external_id = $1`, [
      "VID_ENQUEUE_001",
    ]);
    expect(rows[0]!.media_status).toBe("present");
  });

  it("does NOT enqueue analyze.video for a sticker", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    // Sticker messages use stickerMessage, not videoMessage — handled by existing sticker logic
    const waMsg = {
      key: { id: "VID_STICKER_001", remoteJid: "vid-sticker@g.us", fromMe: false },
      messageTimestamp: 1700300002,
      pushName: "StickerSender",
      message: {
        stickerMessage: {
          mimetype: "image/webp",
          isAnimated: false,
        },
      },
    } as unknown as WAMessage;

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVideo: fakeVideoDownloader,
    });
    expect(stored).toBe(true);

    const videoJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.video");
    expect(videoJobs).toHaveLength(0);
  });

  it("marks media 'missing' and does NOT enqueue when video download fails (no thumbnail fallback path)", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const failingDownloader = async () => {
      throw new Error("download boom");
    };

    const waMsg = makeFakeWAVideoMessage({
      id: "VID_DLFAIL_001",
      remoteJid: "vid-dlfail@g.us",
      timestampSeconds: 1700300003,
      jpegThumbnail: null, // no thumbnail either
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVideo: failingDownloader,
    });
    expect(stored).toBe(true);

    const videoJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.video");
    expect(videoJobs).toHaveLength(0);

    const { rows } = await pool.query(`SELECT media_status FROM messages WHERE external_id = $1`, [
      "VID_DLFAIL_001",
    ]);
    expect(rows[0]!.media_status).toBe("missing");
  });

  it("does NOT enqueue analyze.video when no downloadVideo is provided", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAVideoMessage({
      id: "VID_NODL_001",
      remoteJid: "vid-nodl@g.us",
      timestampSeconds: 1700300004,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir, bus });
    expect(stored).toBe(true);

    const videoJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.video");
    expect(videoJobs).toHaveLength(0);
  });

  it("does NOT enqueue a second analyze.video for a duplicate video message", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAVideoMessage({
      id: "VID_DUPE_001",
      remoteJid: "vid-dupe@g.us",
      timestampSeconds: 1700300005,
    });

    const first = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVideo: fakeVideoDownloader,
    });
    expect(first).toBe(true);

    const second = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVideo: fakeVideoDownloader,
    });
    expect(second).toBe(false);

    const videoJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.video");
    expect(videoJobs).toHaveLength(1); // only from first insertion
  });

  it("enqueues analyze.video with thumbnail path when download fails but jpegThumbnail exists", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const failingDownloader = async () => {
      throw new Error("download boom");
    };

    const waMsg = makeFakeWAVideoMessage({
      id: "VID_THUMB_001",
      remoteJid: "vid-thumb@g.us",
      timestampSeconds: 1700300006,
      jpegThumbnail: FAKE_THUMBNAIL,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadVideo: failingDownloader,
    });
    expect(stored).toBe(true);

    // Should still enqueue because thumbnail is available
    const videoJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.video");
    expect(videoJobs).toHaveLength(1);
  });
});
