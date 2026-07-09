/**
 * T016 (collector side) — Tests for image enqueue behavior in handleIncomingMessage.
 *
 * Verifies:
 * - Non-sticker image: downloaded, media_status='present', analyze.image enqueued
 * - Sticker: NOT enqueued
 * - Image download failure: media 'missing', NOT enqueued
 * - No downloadImage provided: NOT enqueued
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import type { Logger } from "../logging/logger.js";
import { createTestDatabase } from "../test/db.js";
import { handleIncomingMessage } from "./collector.js";

/** Minimal pino-shaped spy logger for asserting which level a path logs at. */
function makeFakeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// Fake WAMessage factories
// ---------------------------------------------------------------------------

function makeFakeWAImageMessage(
  overrides: Partial<{
    id: string;
    remoteJid: string;
    pushName: string;
    timestampSeconds: number;
    caption: string | null;
  }> = {},
): WAMessage {
  const {
    id = "LIVE_IMG_001",
    remoteJid = "img-group@g.us",
    pushName = "ImgSender",
    timestampSeconds = 1700100000,
    caption = null,
  } = overrides;
  return {
    key: { id, remoteJid, fromMe: false },
    messageTimestamp: timestampSeconds,
    pushName,
    message: {
      imageMessage: {
        caption: caption ?? undefined,
        mimetype: "image/jpeg",
      },
    },
  } as unknown as WAMessage;
}

function makeFakeWAStickerMessage(
  overrides: Partial<{
    id: string;
    remoteJid: string;
    timestampSeconds: number;
  }> = {},
): WAMessage {
  const {
    id = "LIVE_STICKER_001",
    remoteJid = "sticker-group@g.us",
    timestampSeconds = 1700200000,
  } = overrides;
  return {
    key: { id, remoteJid, fromMe: false },
    messageTimestamp: timestampSeconds,
    pushName: "StickerSender",
    message: {
      stickerMessage: {
        mimetype: "image/webp",
        isAnimated: false,
      },
    },
  } as unknown as WAMessage;
}

const FAKE_IMAGE = Buffer.from("fake-jpeg-bytes");
const fakeImageDownloader = async () => FAKE_IMAGE;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collector image enqueue (T016)", () => {
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-collector-image-test-"));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it("enqueues analyze.image for a new non-sticker image when downloaded successfully", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_ENQUEUE_001",
      remoteJid: "img-enqueue@g.us",
      timestampSeconds: 1700100001,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: fakeImageDownloader,
    });
    expect(stored).toBe(true);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(1);
    const { messageId } = imageJobs[0]!.job.payload as { messageId: string };
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);

    // Verify the DB row has media_status='present'
    const { rows } = await pool.query(`SELECT media_status FROM messages WHERE external_id = $1`, [
      "IMG_ENQUEUE_001",
    ]);
    expect(rows[0]!.media_status).toBe("present");
  });

  it("does NOT enqueue analyze.image for a sticker", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAStickerMessage({
      id: "STICKER_SKIP_001",
      remoteJid: "sticker-skip@g.us",
      timestampSeconds: 1700200001,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: fakeImageDownloader,
    });
    expect(stored).toBe(true);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(0);
  });

  it("marks media 'missing' and does NOT enqueue when image download fails", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const failingDownloader = async () => {
      throw new Error("download boom");
    };

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_DLFAIL_001",
      remoteJid: "img-dlfail@g.us",
      timestampSeconds: 1700100002,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: failingDownloader,
    });
    expect(stored).toBe(true);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(0);

    const { rows } = await pool.query(`SELECT media_status FROM messages WHERE external_id = $1`, [
      "IMG_DLFAIL_001",
    ]);
    expect(rows[0]!.media_status).toBe("missing");
  });

  it("logs at debug (not warn) when an image download is terminally gone (CDN 403)", async () => {
    // A Boom 403 (expired signed URL) is terminal and expected — it must be quiet
    // (debug), not a warning, mirroring the backfill loop's gone/transient split.
    const log = makeFakeLog();
    const goneDownloader = async () => {
      throw Object.assign(new Error("Failed to fetch stream from https://mmg/x"), {
        output: { statusCode: 403 },
      });
    };

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_GONE_403",
      remoteJid: "img-gone@g.us",
      timestampSeconds: 1700100006,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      downloadImage: goneDownloader,
      log: log as unknown as Logger,
    });
    expect(stored).toBe(true);

    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs at warn (not debug) when an image download fails non-terminally", async () => {
    // A generic error (no gone status, no not-found text) is a real warning — the
    // media might come back on a later attempt, so it must be visible at warn.
    const log = makeFakeLog();
    const failingDownloader = async () => {
      throw new Error("socket hiccup");
    };

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_WARN_DLFAIL",
      remoteJid: "img-warn@g.us",
      timestampSeconds: 1700100007,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      downloadImage: failingDownloader,
      log: log as unknown as Logger,
    });
    expect(stored).toBe(true);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("does NOT enqueue analyze.image when no downloadImage is provided", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_NODL_001",
      remoteJid: "img-nodl@g.us",
      timestampSeconds: 1700100003,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir, bus });
    expect(stored).toBe(true);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(0);
  });

  it("excluded chat: image is downloaded (present) but analyze.image is NOT enqueued", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const waMsg = makeFakeWAImageMessage({
      id: "IMG_EXCL",
      remoteJid: "excl@g.us",
      timestampSeconds: 1700100010,
    });
    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: async () => Buffer.from([1, 2, 3]),
      isGroupIncluded: async () => false, // excluded
    });
    expect(stored).toBe(true);
    const rows = (
      await pool.query("SELECT media_status FROM messages WHERE external_id=$1", ["IMG_EXCL"])
    ).rows;
    expect(rows[0].media_status).toBe("present"); // captured
    expect(recorder.enqueuedJobs.some((j) => j.job.type === "analyze.image")).toBe(false); // not analyzed
  });

  it("included chat: analyze.image IS enqueued", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const waMsg = makeFakeWAImageMessage({
      id: "IMG_INCL",
      remoteJid: "incl@g.us",
      timestampSeconds: 1700100011,
    });
    await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: async () => Buffer.from([1, 2, 3]),
      isGroupIncluded: async () => true,
    });
    expect(recorder.enqueuedJobs.some((j) => j.job.type === "analyze.image")).toBe(true);
  });

  it("does NOT enqueue a second analyze.image for a duplicate image message", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_DUPE_001",
      remoteJid: "img-dupe@g.us",
      timestampSeconds: 1700100004,
    });

    const first = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: fakeImageDownloader,
    });
    expect(first).toBe(true);

    const second = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: fakeImageDownloader,
    });
    expect(second).toBe(false);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(1); // only from first insertion
  });

  it("does NOT re-download media for an already-stored message (history re-push)", async () => {
    // On reconnect WhatsApp re-pushes recent history; we must skip the media
    // download for messages we already have (the expensive, crash-prone step).
    const spyDownloader = vi.fn(async () => FAKE_IMAGE);

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_SKIP_001",
      remoteJid: "img-skip@g.us",
      timestampSeconds: 1700100005,
    });

    const first = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      downloadImage: spyDownloader,
    });
    expect(first).toBe(true);
    expect(spyDownloader).toHaveBeenCalledTimes(1);

    // Second (duplicate) delivery must short-circuit before the downloader runs.
    const second = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      downloadImage: spyDownloader,
    });
    expect(second).toBe(false);
    expect(spyDownloader).toHaveBeenCalledTimes(1); // NOT called again
  });
});
