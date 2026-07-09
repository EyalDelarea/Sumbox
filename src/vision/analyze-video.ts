/**
 * analyzeVideo — orchestrate keyframe extraction + audio transcription for a video.
 *
 * Deps are fully injected so tests pass fakes; production wires real ffmpeg helpers.
 *
 * Logic:
 *  - If mediaPath present AND fileSizeMb(mediaPath) <= maxVideoMb:
 *      extractKeyframe → describeImage (visual)
 *      extractAudio → transcribeAudio (speech, if audio stream present)
 *      compose: "וידאו: <visual>" + (speech?.trim() ? " · דיבור: <speech>" : "")
 *  - Else (oversized or no mediaPath):
 *      if thumbnailPath: describeImage(thumbnailPath); speech = "" (no audio)
 *      else: return a sentinel description (nothing describable — see NO_PREVIEW_RESULT)
 *
 * Engine label: `<visionEngine>+<transcriberEngine|none>`
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { VisionAnalyzer } from "./analyzer.js";

const execFileAsync = promisify(execFile);

/**
 * Result recorded when a video has nothing describable — no usable frames AND
 * no thumbnail (e.g. oversized video with no embedded thumbnail, or a video
 * whose frame extraction yielded nothing). Returned (a `completed` analysis with
 * a clear Hebrew sentinel) rather than thrown, so the job is acked instead of
 * dead-lettering and retry-storming on a permanently-undescribable item.
 */
const NO_PREVIEW_RESULT = {
  description: "וידאו ללא תצוגה מקדימה זמינה",
  engine: "none+none",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtractFramesResult = {
  /** Extracted frame paths in temporal order (may be empty). */
  frames: string[];
  /**
   * Temp directory that contains the frames, or null if no real FS dir was
   * created (e.g. test fakes). When non-null, analyzeVideo cleans it up via
   * fsp.rm(dir, { recursive: true, force: true }) in a finally block.
   */
  dir: string | null;
};

export type AnalyzeVideoDeps = {
  visionAnalyzer: VisionAnalyzer;
  /** Transcribe an audio file (WAV) to text. Returns empty string if no speech. */
  transcribeAudio: (audioPath: string) => Promise<string>;
  /**
   * Extract a SEQUENCE of frames (in temporal order) from a video file.
   * Returns the frame image paths + the temp dir for cleanup. The vision model
   * sees them together so it can describe motion/scene changes, not just one still.
   */
  extractFrames: (videoPath: string) => Promise<ExtractFramesResult>;
  /**
   * Extract the audio stream from a video file.
   * Returns a WAV path if an audio stream exists, or null if there is no audio.
   */
  extractAudio: (videoPath: string) => Promise<string | null>;
  /** Max video file size in MB before we fall back to thumbnail. */
  maxVideoMb: number;
  /** Returns the file size in MB (synchronous for testability). */
  fileSizeMb: (filePath: string) => number;
};

export type AnalyzeVideoInput = {
  /** Path to the video file on disk, or null if not downloaded. */
  mediaPath: string | null;
  /** Path to an embedded JPEG thumbnail, or null if none. */
  thumbnailPath: string | null;
};

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Analyze a video message: extract a representative keyframe and (optionally)
 * transcribe the audio stream. Returns a composed Hebrew description and an
 * engine label.
 *
 * When nothing is describable (no usable frames/mediaPath AND no thumbnail),
 * returns the NO_PREVIEW_RESULT sentinel rather than throwing — a permanently
 * undescribable video should be recorded, not retried.
 */
export async function analyzeVideo(
  deps: AnalyzeVideoDeps,
  input: AnalyzeVideoInput,
): Promise<{ description: string; engine: string }> {
  const { visionAnalyzer, transcribeAudio, extractFrames, extractAudio, maxVideoMb, fileSizeMb } =
    deps;
  const { mediaPath, thumbnailPath } = input;

  const useFullVideo = mediaPath !== null && fileSizeMb(mediaPath) <= maxVideoMb;

  let visual: string;
  let visionEngine: string;
  let speech: string | null = null;
  let transcriberEngine: string = "none";

  if (useFullVideo) {
    // --- Full video path: sample a sequence of frames so the model sees motion ---
    const { frames, dir: frameDir } = await extractFrames(mediaPath!);
    try {
      if (frames.length === 0) {
        // Extraction produced nothing usable — fall back to the thumbnail if we have one.
        if (thumbnailPath === null) {
          // No frames AND no thumbnail → record sentinel instead of dead-lettering.
          // TODO: a real thumbnail_path column (future enhancement) would let us use the
          //       embedded JPEG here.
          return NO_PREVIEW_RESULT;
        }
        const described = await visionAnalyzer.describeImages([thumbnailPath]);
        visual = described.description;
        visionEngine = described.engine;
      } else {
        const described = await visionAnalyzer.describeImages(frames);
        visual = described.description;
        visionEngine = described.engine;

        // Extract and transcribe audio; clean up the WAV after use.
        const audioPath = await extractAudio(mediaPath!);
        if (audioPath !== null) {
          try {
            speech = await transcribeAudio(audioPath);
            transcriberEngine = "whisper";
          } finally {
            await fsp.unlink(audioPath).catch(() => {});
          }
        }
      }
    } finally {
      // Clean up the frames temp dir regardless of success/failure.
      if (frameDir !== null) {
        await fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } else if (thumbnailPath !== null) {
    // --- Thumbnail fallback (oversized / undownloaded video) ---
    const described = await visionAnalyzer.describeImages([thumbnailPath]);
    visual = described.description;
    visionEngine = described.engine;
    speech = null;
  } else {
    // Oversized (or undownloaded) video AND no thumbnail → nothing describable.
    // Record the sentinel instead of throwing, mirroring the no-frames case
    // above, so the bus acks rather than retry-storming a permanently
    // undescribable item.
    return NO_PREVIEW_RESULT;
  }

  // Compose description
  const speechTrimmed = speech?.trim() ?? "";
  const description = speechTrimmed
    ? `וידאו: ${visual} · דיבור: ${speechTrimmed}`
    : `וידאו: ${visual}`;

  const engine = `${visionEngine}+${transcriberEngine}`;

  return { description, engine };
}

// ---------------------------------------------------------------------------
// Production ffmpeg helpers (injected in tests with fakes)
// ---------------------------------------------------------------------------

/**
 * Extract a SEQUENCE of frames from a video using ffmpeg, sampling at `fps`
 * frames per second and capping the total at `maxFrames`. Frames are written
 * into a fresh temp directory and returned in temporal order.
 *
 * The returned object includes the frame paths AND the temp directory path so
 * the caller can clean up with fsp.rm(dir, { recursive: true, force: true }).
 *
 * Fallback: if the fps pass produces 0 frames (e.g. sub-1-second clip), a
 * single-frame grab is attempted so at least one frame is always returned for
 * analyzable videos.
 *
 * 1fps up to ~60 frames matches Gemma 4's video-understanding guidance; a low
 * frame cap also bounds KV-cache memory when several frames share one request.
 */
export async function extractFramesWithFfmpeg(
  ffmpegPath: string,
  videoPath: string,
  opts: { fps: number; maxFrames: number },
  exec: typeof execFileAsync = execFileAsync,
): Promise<{ frames: string[]; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wsum-frames-"));
  const pattern = path.join(dir, "frame-%04d.jpg");
  // ffmpeg ≥8 exits non-zero ("Nothing was written into output file…") when the
  // fps filter yields zero frames — e.g. a sub-1-second clip where fps=1 lands no
  // sample. Older ffmpeg exited 0 with an empty output. Swallow the failure so the
  // zero-frame fallback below still runs; a genuinely unreadable video falls through
  // to the fallback's own catch and returns no frames, which analyzeVideo treats as
  // a non-fatal sentinel rather than dead-lettering the job.
  await exec(ffmpegPath, [
    "-y",
    "-autorotate",
    "-i",
    videoPath,
    "-vf",
    `fps=${opts.fps}`,
    "-frames:v",
    String(opts.maxFrames),
    pattern,
  ]).catch(() => {});
  let files = (await fsp.readdir(dir))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(dir, f));

  // Fallback for sub-1-second videos: fps=1 produces 0 frames, grab one frame.
  if (files.length === 0) {
    const fallbackPath = path.join(dir, "frame-0001.jpg");
    await exec(ffmpegPath, ["-y", "-i", videoPath, "-frames:v", "1", fallbackPath]).catch(() => {});
    const stat = await fsp.stat(fallbackPath).catch(() => null);
    if (stat && stat.size > 0) {
      files = [fallbackPath];
    }
  }

  return { frames: files, dir };
}

/**
 * Extract the audio stream from a video into a 16 kHz mono WAV. Returns
 * the temp WAV path if the video contains an audio stream, or null if ffmpeg
 * exits non-zero (typically means no audio stream). Caller is responsible for
 * cleanup.
 */
export async function extractAudioWithFfmpeg(
  ffmpegPath: string,
  videoPath: string,
): Promise<string | null> {
  const outPath = path.join(os.tmpdir(), `wsum-va-${crypto.randomUUID()}.wav`);
  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-vn", // skip video stream
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
      outPath,
    ]);
    // Verify the output file was actually created and has non-zero size
    const stat = await fsp.stat(outPath).catch(() => null);
    if (!stat || stat.size === 0) return null;
    return outPath;
  } catch {
    // ffmpeg exits non-zero when there is no audio stream
    return null;
  }
}

/**
 * Synchronously returns the file size in MB.
 * Used as the production `fileSizeMb` dep.
 */
export function fileSizeMbSync(filePath: string): number {
  const stat = statSync(filePath);
  return stat.size / (1024 * 1024);
}
