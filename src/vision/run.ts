/**
 * analyzeMediaOne — single-item glue function for the analyze worker.
 *
 * Analog of transcription/run.ts#transcribeOneNote.
 *
 * Flow for kind='image':
 *   1. Resolve media path via getVisualMediaPath (null → skip, see below).
 *   2. Normalize image orientation via injected normalizeImage (default: real ffmpeg impl).
 *   3. Call visionAnalyzer.describeImage.
 *   4. insertMediaAnalysis(status='completed').
 *
 * Flow for kind='video':
 *   1. Resolve media path via getVisualMediaPath (null → skip, see below).
 *   2. Resolve thumbnail path via getThumbnailPath (may be null).
 *   3. Call analyzeVideo({ mediaPath, thumbnailPath }).
 *   4. insertMediaAnalysis(status='completed').
 *
 * If no analyzable media is present (null path — pruned, absent, or a stale
 * queued job), return early WITHOUT a 'failed' row or a throw: there is nothing
 * to retry, so the bus should ack rather than redeliver.
 *
 * On an actual analysis error:
 *   - insertMediaAnalysis(status='failed', errorMessage) then rethrow (bus retries).
 */
import fsp from "node:fs/promises";
import type pg from "pg";
import type { InsertMediaAnalysisInput } from "../db/repositories/media-analyses.js";
import type { AnalyzeVideoInput } from "./analyze-video.js";
import type { VisionAnalyzer } from "./analyzer.js";

export type AnalyzeMediaOneDeps = {
  pool: pg.Pool | pg.PoolClient;
  /** Resolves to { path, kind } for a present visual media row, or null if not found. */
  getVisualMediaPath: (
    messageId: number,
  ) => Promise<{ path: string; kind: "image" | "video" } | null>;
  visionAnalyzer: VisionAnalyzer;
  /**
   * Orientation-normalize the image at `inputPath`; returns the path to the
   * normalized file (may be the same path or a temp file).
   * Default (production): uses ffmpeg -autorotate.
   * Tests inject a fake (identity function or similar).
   */
  normalizeImage: (inputPath: string) => Promise<string>;
  insertMediaAnalysis: (input: InsertMediaAnalysisInput) => Promise<void>;
  engineLabel: string;
  /**
   * Video orchestration — called for kind='video'.
   * Injected so tests can pass fakes without real ffmpeg/Whisper.
   * Production wires analyzeVideo from analyze-video.ts.
   */
  analyzeVideo: (input: AnalyzeVideoInput) => Promise<{ description: string; engine: string }>;
  /**
   * Retrieve the embedded JPEG thumbnail path for a video message, or null if
   * none was persisted. Used as a fallback when the video is oversized.
   * Injected for testability.
   */
  getThumbnailPath: (messageId: number) => Promise<string | null>;
  /**
   * When true, keep the media file on disk after a successful analysis.
   * Default false (prune after caption).
   */
  retainMedia: boolean;
  /**
   * Called after a successful analysis to delete the on-disk media file.
   * Injected so tests can verify it is called without real FS operations.
   * Production wires pruneMediaFile from src/media/prune.ts (partially applied).
   */
  pruneMediaFile: (messageId: number) => Promise<void>;
};

/**
 * Analyze a single visual media message and persist the result.
 * Throws on failure (after recording a 'failed' row) so the bus can retry.
 */
export async function analyzeMediaOne(
  messageId: number,
  kind: "image" | "video",
  deps: AnalyzeMediaOneDeps,
): Promise<void> {
  if (kind === "video") {
    // ── Video branch (T019) ────────────────────────────────────────────────
    let videoMediaPath: string | null = null;
    try {
      // 1. Resolve media path. null → no analyzable media present (pruned,
      //    absent, or a stale queued job). Terminal non-error: skip without a
      //    'failed' row or a throw, so the bus acks instead of retry-storming.
      const resolved = await deps.getVisualMediaPath(messageId);
      if (!resolved) return;
      videoMediaPath = resolved.path;

      // 2. Resolve thumbnail path (may be null)
      const thumbnailPath = await deps.getThumbnailPath(messageId);

      // 3. Run video analysis (keyframe + optional audio)
      const { description, engine } = await deps.analyzeVideo({
        mediaPath: videoMediaPath,
        thumbnailPath,
      });

      // 4. Persist completed
      await deps.insertMediaAnalysis({
        messageId,
        kind,
        description,
        engine,
        status: "completed",
      });

      // 5. Prune media file (only on success, gated by retainMedia)
      if (!deps.retainMedia) {
        await deps.pruneMediaFile(messageId);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await deps.insertMediaAnalysis({
        messageId,
        kind,
        description: null,
        engine: deps.engineLabel,
        status: "failed",
        errorMessage,
      });
      throw err;
    }
    return;
  }

  // ── Image branch ────────────────────────────────────────────────────────
  let mediaPath: string | null = null;

  try {
    // 1. Resolve path. null → no analyzable media present (pruned, absent, or a
    //    stale queued job). Terminal non-error: skip without a 'failed' row or a
    //    throw, so the bus acks instead of retry-storming.
    const resolved = await deps.getVisualMediaPath(messageId);
    if (!resolved) return;
    mediaPath = resolved.path;

    // 2. Orientation normalize; clean up temp file afterwards if it differs from input.
    const normalizedPath = await deps.normalizeImage(mediaPath);
    try {
      // 3. Describe image
      const { description, engine } = await deps.visionAnalyzer.describeImage(normalizedPath);

      // 4. Persist completed
      await deps.insertMediaAnalysis({
        messageId,
        kind,
        description,
        engine,
        status: "completed",
      });

      // 5. Prune media file (only on success, gated by retainMedia)
      if (!deps.retainMedia) {
        await deps.pruneMediaFile(messageId);
      }
    } finally {
      // Clean up the normalized temp file only when it is a different path.
      if (normalizedPath !== mediaPath) {
        await fsp.unlink(normalizedPath).catch(() => {});
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Record the failure (best-effort; if this also throws, let it propagate)
    await deps.insertMediaAnalysis({
      messageId,
      kind,
      description: null,
      engine: deps.engineLabel,
      status: "failed",
      errorMessage,
    });

    // Rethrow so the bus retries
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Production normalizeImage using ffmpeg -autorotate
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Orientation-normalize an image using ffmpeg's -autorotate flag.
 * Returns a temp file path containing the normalized image (JPEG).
 * The caller is responsible for cleaning up the temp file.
 *
 * Injected as `normalizeImage` in production; tests replace with a fake.
 */
export async function normalizeImageWithFfmpeg(
  ffmpegPath: string,
  inputPath: string,
): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `normalized-${Date.now()}-${path.basename(inputPath)}`);
  await execFileAsync(ffmpegPath, [
    "-y",
    "-autorotate",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    tmpFile,
  ]);
  return tmpFile;
}
