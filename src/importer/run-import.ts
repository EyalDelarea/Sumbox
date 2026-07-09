/**
 * runImport — end-to-end import orchestrator (T016 + T017 orchestration).
 *
 * Flow:
 *   1. sha256 the original file bytes.
 *   2. Upsert the group by name.
 *   3. Create import row with status='pending' and a placeholder original_file_path.
 *   4. Write files to disk (original + extracted media).
 *   5. UPDATE original_file_path with the real path.
 *   6. Parse / extract → normalize → attach participant ids + media fields.
 *   7. insertMessages.
 *   8. markImportCompleted (or markImportFailed on error, then rethrow).
 *
 * Returns: { groupName, inserted, skipped, mediaFiles }
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "../config.js";
import { upsertGroup } from "../db/repositories/groups.js";
import {
  createImport,
  markImportCompleted,
  markImportFailed,
  updateImportFilePath,
} from "../db/repositories/imports.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipants } from "../db/repositories/participants.js";
import { currentTenantId } from "../db/tenant-context.js";
import type { JobBus } from "../jobs/job-bus.js";
import { extractWhatsAppZip } from "./extract-whatsapp-zip.js";
import { normalize } from "./normalize.js";
import { parseWhatsAppTextExport } from "./parse-whatsapp-text.js";
import type { ImportedMessage, NormalizedMessage } from "./types.js";

export type RunImportInput = {
  filePath: string;
  name: string;
};

export type RunImportResult = {
  groupName: string;
  inserted: number;
  skipped: number;
  /** Number of media files written to disk (present status). */
  mediaFiles: number;
};

type RunImportDeps = {
  databaseUrl: string;
  dataDir: string;
  /** Optional job bus. When provided, analyze.image is enqueued for present non-sticker images. */
  bus?: JobBus;
};

/**
 * Run the full import pipeline.
 *
 * @param input   - { filePath, name } — the file to import and the group name.
 * @param deps    - Optional override for databaseUrl / dataDir (used in tests).
 *                  Defaults to loadConfig().
 */
export async function runImport(
  input: RunImportInput,
  deps?: Partial<RunImportDeps>,
): Promise<RunImportResult> {
  const config = loadConfig();
  const databaseUrl = deps?.databaseUrl ?? config.databaseUrl;
  const dataDir = deps?.dataDir ?? config.dataDir;

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    return await _runImport(input, dataDir, pool, deps?.bus);
  } finally {
    await pool.end();
  }
}

async function _runImport(
  input: RunImportInput,
  dataDir: string,
  pool: pg.Pool,
  bus?: JobBus,
): Promise<RunImportResult> {
  const { filePath, name } = input;

  // --- 1. Read original file bytes ---
  const fileBytes = await fsp.readFile(filePath);
  const sourceHash = crypto.createHash("sha256").update(fileBytes).digest("hex");
  const ext = path.extname(filePath).toLowerCase();

  // --- 2. Upsert group ---
  const groupId = await upsertGroup(pool, { name, source: "import" });

  // --- 3. Create import row (pending) with a placeholder original_file_path ---
  //    original_file_path is NOT NULL, but the path depends on the generated id.
  //    We insert with a placeholder, then UPDATE after we know the id.
  const importId = await createImport(pool, {
    groupId,
    sourcePath: filePath,
    sourceHash,
    originalFilePath: "__pending__", // overwritten below
    status: "pending",
  });

  let inserted = 0;
  let skipped = 0;
  let mediaFilesCount = 0;

  try {
    // --- 4. Write files to disk ---
    const importDir = path.join(dataDir, "imports", String(importId));
    const mediaDir = path.join(dataDir, "media", String(importId));
    fs.mkdirSync(importDir, { recursive: true });

    const originalFileName = `original${ext}`;
    const originalFilePath = path.join(importDir, originalFileName);
    await fsp.writeFile(originalFilePath, fileBytes);

    // --- 5. UPDATE original_file_path ---
    await updateImportFilePath(pool, importId, originalFilePath);

    // --- 6. Parse / extract ---
    let rawMessages: ImportedMessage[];
    // Map of filename → buffer for media present in the zip
    const mediaMap = new Map<string, Buffer>();

    if (ext === ".zip") {
      const extracted = await extractWhatsAppZip(filePath);
      rawMessages = extracted.messages;

      // Write extracted media to disk
      if (extracted.mediaFiles.length > 0) {
        fs.mkdirSync(mediaDir, { recursive: true });
        for (const mf of extracted.mediaFiles) {
          const dest = path.join(mediaDir, mf.filename);
          await fsp.writeFile(dest, mf.data);
          mediaMap.set(mf.filename, mf.data);
        }
      }
    } else {
      // .txt
      const text = fileBytes.toString("utf8");
      rawMessages = parseWhatsAppTextExport(text);
    }

    // --- 7. Normalize ---
    const normalized: NormalizedMessage[] = normalize(rawMessages, {
      groupId,
      importId,
      source: "import",
    });

    // Attach media fields based on the extracted media map
    for (const msg of normalized) {
      if (msg.messageType === "media" && msg.mediaFilename) {
        if (mediaMap.has(msg.mediaFilename)) {
          msg.mediaPath = path.join(mediaDir, msg.mediaFilename);
          msg.mediaStatus = "present";
          mediaFilesCount++;
        } else {
          msg.mediaPath = null;
          msg.mediaStatus = "missing";
        }
      }
      // non-media rows keep mediaPath: null, mediaStatus: null (set by normalizer)
    }

    // --- 8. Resolve participant ids ---
    const senderNames = [
      ...new Set(normalized.map((m) => m.senderName).filter((n): n is string => n !== null)),
    ];

    const participantMap =
      senderNames.length > 0
        ? await upsertParticipants(pool, senderNames)
        : new Map<string, number>();

    // Build rows with participantId attached
    const rows = normalized.map((msg) => ({
      ...msg,
      participantId: msg.senderName ? (participantMap.get(msg.senderName) ?? null) : null,
    }));

    // --- 9. Insert messages ---
    const result = await insertMessages(pool, rows);
    inserted = result.inserted;
    skipped = result.skipped;

    // --- 10. Enqueue analyze.image for present non-sticker images (newest-first) ---
    if (bus && result.inserted > 0) {
      // Query present image messages for this group, newest-first, to enqueue
      const { rows: imageRows } = await pool.query<{ id: string }>(
        `
        SELECT m.id
        FROM messages m
        WHERE m.group_id = $1
          AND m.import_id = $2
          AND m.message_type = 'media'
          AND m.media_status = 'present'
          AND m.media_path IS NOT NULL
          AND (
            lower(m.media_filename) LIKE '%.jpg'  OR
            lower(m.media_filename) LIKE '%.jpeg' OR
            lower(m.media_filename) LIKE '%.png'  OR
            lower(m.media_filename) LIKE '%.gif'  OR
            lower(m.media_filename) LIKE '%.webp'
          )
          -- skip WhatsApp stickers (exported as STK-*.webp) per FR-005
          AND m.media_filename NOT ILIKE 'STK-%'
        ORDER BY m.sent_at DESC, m.id DESC
        `,
        [groupId, importId],
      );
      for (const imgRow of imageRows) {
        await bus.enqueue("analyze.image", {
          messageId: String(imgRow.id),
          tenantId: currentTenantId(),
        });
      }

      // --- 10b. Enqueue analyze.video for present non-sticker videos (newest-first) ---
      const { rows: videoRows } = await pool.query<{ id: string }>(
        `
        SELECT m.id
        FROM messages m
        WHERE m.group_id = $1
          AND m.import_id = $2
          AND m.message_type = 'media'
          AND m.media_status = 'present'
          AND m.media_path IS NOT NULL
          AND (
            lower(m.media_filename) LIKE '%.mp4' OR
            lower(m.media_filename) LIKE '%.mov'
          )
          -- skip stickers (none expected in video context, but guard for safety)
          AND m.media_filename NOT ILIKE 'STK-%'
        ORDER BY m.sent_at DESC, m.id DESC
        `,
        [groupId, importId],
      );
      for (const vidRow of videoRows) {
        await bus.enqueue("analyze.video", {
          messageId: String(vidRow.id),
          tenantId: currentTenantId(),
        });
      }
    }

    // --- 11. Mark completed ---
    await markImportCompleted(pool, importId);
  } catch (err) {
    // Mark failed and rethrow
    const message = err instanceof Error ? err.message : String(err);
    await markImportFailed(pool, importId, message);
    throw err;
  }

  return {
    groupName: name,
    inserted,
    skipped,
    mediaFiles: mediaFilesCount,
  };
}
