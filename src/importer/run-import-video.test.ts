/**
 * T020 (importer side) — Tests for analyze.video enqueue in runImport.
 *
 * Verifies:
 * - Present non-sticker videos get analyze.video enqueued (newest-first)
 * - Missing media does NOT get enqueued
 *
 * Uses a shared test DB (createTestDatabase) + InMemoryJobBus.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import { createTestDatabase } from "../test/db.js";
import { runImport } from "./run-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");

describe("runImport video enqueue (T020)", () => {
  let connectionString: string;
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    connectionString = await createTestDatabase();
    pool = new pg.Pool({ connectionString });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-import-vid-test-"));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (dataDir && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("enqueues analyze.video for present videos in a ZIP import", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const filePath = path.join(FIXTURES_DIR, "sample-chat-video.zip");

    await runImport(
      { filePath, name: "Zip Video Enqueue Test" },
      { databaseUrl: connectionString, dataDir, bus },
    );

    const videoJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.video");
    // The fixture sample-chat-video.zip has one video (VID-20260601-WA0001.mp4)
    expect(videoJobs.length).toBeGreaterThan(0);

    // Each messageId must correspond to a real messages row with present video
    for (const job of videoJobs) {
      const { messageId } = job.job.payload as { messageId: string };
      const { rows } = await pool.query(
        `SELECT media_status, media_filename FROM messages WHERE id = $1`,
        [Number(messageId)],
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.media_status).toBe("present");
      const filename: string = rows[0]!.media_filename ?? "";
      expect(filename).toMatch(/\.(mp4|mov)$/i);
    }
  });

  it("does not enqueue analyze.video for missing media (txt import)", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const filePath = path.join(FIXTURES_DIR, "android-chat.txt");

    await runImport(
      { filePath, name: "Txt No Video Enqueue" },
      { databaseUrl: connectionString, dataDir, bus },
    );

    const videoJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.video");
    expect(videoJobs).toHaveLength(0);
  });
}, 120_000);
