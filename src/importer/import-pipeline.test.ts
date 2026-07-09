/**
 * T010 — Full-pipeline integration test.
 *
 * Tests the end-to-end import flow:
 * - Android .txt, iOS .txt, and sample-chat.zip fixtures
 * - Counts match what the parser/extractor produces
 * - Re-import of the same file → 0 new (SC-002 idempotency)
 * - Zip: media files written to disk, at least one message has media_status='present'
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db.js";
import { extractWhatsAppZip } from "./extract-whatsapp-zip.js";
import { parseWhatsAppTextExport } from "./parse-whatsapp-text.js";
import { runImport } from "./run-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");

describe("import pipeline integration", () => {
  let connectionString: string;
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    connectionString = await createTestDatabase();
    pool = new pg.Pool({ connectionString });

    // Use a temp dir as DATA_DIR so we don't pollute the repo
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-test-"));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    // Clean up temp dir
    if (dataDir && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Android .txt import
  // ---------------------------------------------------------------------------

  it("imports android-chat.txt and returns inserted count matching parser output", async () => {
    const filePath = path.join(FIXTURES_DIR, "android-chat.txt");

    // Derive expected count from parser directly (don't hardcode)
    const text = fs.readFileSync(filePath, "utf8");
    const expected = parseWhatsAppTextExport(text).length;
    expect(expected).toBeGreaterThan(0);

    const result = await runImport(
      { filePath, name: "Android Chat" },
      { databaseUrl: connectionString, dataDir },
    );

    expect(result.inserted).toBe(expected);
    expect(result.inserted).toBeGreaterThan(0);
  });

  it("re-importing android-chat.txt yields inserted=0 (SC-002)", async () => {
    const filePath = path.join(FIXTURES_DIR, "android-chat.txt");

    // Get original DB count
    const { rows: before } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages WHERE group_id IN (SELECT id FROM groups WHERE name = 'Android Chat')`,
    );
    const countBefore = Number(before[0].cnt);

    const result = await runImport(
      { filePath, name: "Android Chat" },
      { databaseUrl: connectionString, dataDir },
    );

    expect(result.inserted).toBe(0);

    // DB count must not have changed
    const { rows: after } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages WHERE group_id IN (SELECT id FROM groups WHERE name = 'Android Chat')`,
    );
    const countAfter = Number(after[0].cnt);
    expect(countAfter).toBe(countBefore);
  });

  // ---------------------------------------------------------------------------
  // iOS .txt import
  // ---------------------------------------------------------------------------

  it("imports ios-chat.txt and returns inserted count matching parser output", async () => {
    const filePath = path.join(FIXTURES_DIR, "ios-chat.txt");

    const text = fs.readFileSync(filePath, "utf8");
    const expected = parseWhatsAppTextExport(text).length;
    expect(expected).toBeGreaterThan(0);

    const result = await runImport(
      { filePath, name: "iOS Chat" },
      { databaseUrl: connectionString, dataDir },
    );

    expect(result.inserted).toBe(expected);
    expect(result.inserted).toBeGreaterThan(0);
  });

  it("re-importing ios-chat.txt yields inserted=0 (SC-002)", async () => {
    const filePath = path.join(FIXTURES_DIR, "ios-chat.txt");

    const { rows: before } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages WHERE group_id IN (SELECT id FROM groups WHERE name = 'iOS Chat')`,
    );
    const countBefore = Number(before[0].cnt);

    const result = await runImport(
      { filePath, name: "iOS Chat" },
      { databaseUrl: connectionString, dataDir },
    );

    expect(result.inserted).toBe(0);

    const { rows: after } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages WHERE group_id IN (SELECT id FROM groups WHERE name = 'iOS Chat')`,
    );
    expect(Number(after[0].cnt)).toBe(countBefore);
  });

  // ---------------------------------------------------------------------------
  // ZIP import
  // ---------------------------------------------------------------------------

  it("imports sample-chat.zip and returns inserted count matching extractor output", async () => {
    const filePath = path.join(FIXTURES_DIR, "sample-chat.zip");

    const extracted = await extractWhatsAppZip(filePath);
    const expected = extracted.messages.length;
    expect(expected).toBeGreaterThan(0);

    const result = await runImport(
      { filePath, name: "Zip Chat" },
      { databaseUrl: connectionString, dataDir },
    );

    expect(result.inserted).toBe(expected);
    expect(result.inserted).toBeGreaterThan(0);
  });

  it("re-importing sample-chat.zip yields inserted=0 (SC-002)", async () => {
    const filePath = path.join(FIXTURES_DIR, "sample-chat.zip");

    const { rows: before } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages WHERE group_id IN (SELECT id FROM groups WHERE name = 'Zip Chat')`,
    );
    const countBefore = Number(before[0].cnt);

    const result = await runImport(
      { filePath, name: "Zip Chat" },
      { databaseUrl: connectionString, dataDir },
    );

    expect(result.inserted).toBe(0);

    const { rows: after } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages WHERE group_id IN (SELECT id FROM groups WHERE name = 'Zip Chat')`,
    );
    expect(Number(after[0].cnt)).toBe(countBefore);
  });

  it("zip import: media files written to disk under dataDir", async () => {
    // The zip import was done in the earlier test; query the DB for the import id
    const { rows } = await pool.query(
      `SELECT i.id FROM imports i JOIN groups g ON g.id = i.group_id WHERE g.name = 'Zip Chat' ORDER BY i.id LIMIT 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const importId = rows[0].id;

    const mediaDir = path.join(dataDir, "media", String(importId));
    // The zip fixture has one media file: IMG-20260531-WA0001.jpg
    expect(fs.existsSync(mediaDir)).toBe(true);
    const files = fs.readdirSync(mediaDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it("zip import: at least one message row has media_status='present'", async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages m
       JOIN groups g ON g.id = m.group_id
       WHERE g.name = 'Zip Chat' AND m.media_status = 'present'`,
    );
    expect(Number(rows[0].cnt)).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // original_file_path written for each import
  // ---------------------------------------------------------------------------

  it("import records have non-null original_file_path after completion", async () => {
    const { rows } = await pool.query(
      `SELECT original_file_path, status FROM imports WHERE status = 'completed'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.original_file_path).toBe("string");
      expect(row.original_file_path.length).toBeGreaterThan(0);
    }
  });
}, 120_000);
