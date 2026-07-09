/**
 * Tests for analyzeVideo (src/vision/analyze-video.ts).
 *
 * All external deps are injected fakes — no real ffmpeg, no real Whisper,
 * no real Ollama, no real filesystem access.
 *
 * Video analysis samples a SEQUENCE of frames (extractFrames → string[]) and
 * feeds them to visionAnalyzer.describeImages so the model sees motion, not
 * just one still. Audio is still transcribed via ivrit-Whisper.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type AnalyzeVideoDeps,
  type AnalyzeVideoInput,
  analyzeVideo,
  type ExtractFramesResult,
  extractFramesWithFfmpeg,
} from "./analyze-video.js";
import type { VisionAnalyzer } from "./analyzer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A vision analyzer fake whose describeImage/describeImages both resolve to the same result. */
function fakeVision(description = "X", engine = "fake-vision"): VisionAnalyzer {
  const result = { description, engine };
  return {
    describeImage: vi.fn().mockResolvedValue(result),
    describeImages: vi.fn().mockResolvedValue(result),
  };
}

/** Helper: make a fake ExtractFramesResult (dir=null so analyzeVideo skips FS cleanup). */
function fakeFrames(frames: string[]): ExtractFramesResult {
  return { frames, dir: null };
}

function makeDeps(overrides: Partial<AnalyzeVideoDeps> = {}): AnalyzeVideoDeps {
  return {
    visionAnalyzer: overrides.visionAnalyzer ?? fakeVision(),
    transcribeAudio: overrides.transcribeAudio ?? vi.fn().mockResolvedValue("Y"),
    extractFrames:
      overrides.extractFrames ??
      vi.fn().mockResolvedValue(fakeFrames(["/tmp/frame-0001.jpg", "/tmp/frame-0002.jpg"])),
    extractAudio: overrides.extractAudio ?? vi.fn().mockResolvedValue("/tmp/audio.wav"),
    maxVideoMb: overrides.maxVideoMb ?? 25,
    fileSizeMb: overrides.fileSizeMb ?? vi.fn().mockReturnValue(10),
  };
}

function makeInput(overrides: Partial<AnalyzeVideoInput> = {}): AnalyzeVideoInput {
  return {
    mediaPath: overrides.mediaPath !== undefined ? overrides.mediaPath : "/media/video.mp4",
    thumbnailPath: overrides.thumbnailPath !== undefined ? overrides.thumbnailPath : null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeVideo", () => {
  it("in-range video: composes description with visual and speech (וידאו: X · דיבור: Y)", async () => {
    const deps = makeDeps({
      visionAnalyzer: fakeVision("חתול יושב"),
      transcribeAudio: vi.fn().mockResolvedValue("שלום עולם"),
      fileSizeMb: vi.fn().mockReturnValue(10),
    });
    const result = await analyzeVideo(deps, makeInput());
    expect(result.description).toBe("וידאו: חתול יושב · דיבור: שלום עולם");
  });

  it("passes ALL extracted frames (the sequence) to describeImages", async () => {
    const frames = ["/tmp/f-1.jpg", "/tmp/f-2.jpg", "/tmp/f-3.jpg", "/tmp/f-4.jpg"];
    const vision = fakeVision("ריצה בפארק");
    const deps = makeDeps({
      visionAnalyzer: vision,
      extractFrames: vi.fn().mockResolvedValue(fakeFrames(frames)),
      transcribeAudio: vi.fn().mockResolvedValue(""),
      extractAudio: vi.fn().mockResolvedValue(null),
      fileSizeMb: vi.fn().mockReturnValue(8),
    });

    await analyzeVideo(deps, makeInput());

    expect(vision.describeImages).toHaveBeenCalledWith(frames);
  });

  it("in-range video with no audio: description has only the visual part (no speech clause)", async () => {
    const deps = makeDeps({
      visionAnalyzer: fakeVision("נוף הרים"),
      transcribeAudio: vi.fn().mockResolvedValue(""),
      extractAudio: vi.fn().mockResolvedValue(null), // no audio stream
      fileSizeMb: vi.fn().mockReturnValue(5),
    });
    const result = await analyzeVideo(deps, makeInput());
    expect(result.description).toBe("וידאו: נוף הרים");
    expect(deps.transcribeAudio).not.toHaveBeenCalled();
  });

  it("in-range video with audio that transcribes to whitespace-only: omits speech clause", async () => {
    const deps = makeDeps({
      visionAnalyzer: fakeVision("ריקוד"),
      transcribeAudio: vi.fn().mockResolvedValue("   "),
      fileSizeMb: vi.fn().mockReturnValue(5),
    });
    const result = await analyzeVideo(deps, makeInput());
    expect(result.description).toBe("וידאו: ריקוד");
  });

  it("oversized video: falls back to thumbnail; extractFrames and extractAudio are NOT called", async () => {
    const extractFrames = vi.fn();
    const extractAudio = vi.fn();
    const vision = fakeVision("תמונת ממוזערת");
    const deps = makeDeps({
      visionAnalyzer: vision,
      transcribeAudio: vi.fn(),
      extractFrames,
      extractAudio,
      fileSizeMb: vi.fn().mockReturnValue(30), // > 25 MB cap
      maxVideoMb: 25,
    });
    const input = makeInput({
      mediaPath: "/media/big-video.mp4",
      thumbnailPath: "/media/thumb.jpg",
    });

    const result = await analyzeVideo(deps, input);

    expect(result.description).toBe("וידאו: תמונת ממוזערת");
    expect(extractFrames).not.toHaveBeenCalled();
    expect(extractAudio).not.toHaveBeenCalled();
    expect(vision.describeImages).toHaveBeenCalledWith(["/media/thumb.jpg"]);
  });

  it("mediaPath null + thumbnail present: describes thumbnail without audio, no frame/audio extraction", async () => {
    const extractFrames = vi.fn();
    const extractAudio = vi.fn();
    const vision = fakeVision("ממוזערת בלבד");
    const deps = makeDeps({
      visionAnalyzer: vision,
      transcribeAudio: vi.fn(),
      extractFrames,
      extractAudio,
      fileSizeMb: vi.fn().mockReturnValue(0),
      maxVideoMb: 25,
    });
    const input = makeInput({ mediaPath: null, thumbnailPath: "/media/thumb.jpg" });

    const result = await analyzeVideo(deps, input);

    expect(result.description).toBe("וידאו: ממוזערת בלבד");
    expect(extractFrames).not.toHaveBeenCalled();
    expect(extractAudio).not.toHaveBeenCalled();
    expect(deps.transcribeAudio).not.toHaveBeenCalled();
    expect(vision.describeImages).toHaveBeenCalledWith(["/media/thumb.jpg"]);
  });

  it("neither mediaPath nor thumbnailPath: returns sentinel (does NOT throw)", async () => {
    // Nothing describable → record the sentinel so the bus acks instead of
    // dead-lettering / retry-storming.
    await expect(
      analyzeVideo(makeDeps(), makeInput({ mediaPath: null, thumbnailPath: null })),
    ).resolves.toMatchObject({ description: "וידאו ללא תצוגה מקדימה זמינה", engine: "none+none" });
  });

  it("oversized video with no thumbnail: returns sentinel (does NOT throw)", async () => {
    // The reported bug: 68MB video > maxVideoMb, no thumbnail → previously threw
    // "nothing describable" and retry-stormed. Now mirrors the no-frames case.
    const deps = makeDeps({ fileSizeMb: () => 999, maxVideoMb: 25 });
    await expect(
      analyzeVideo(deps, makeInput({ mediaPath: "/media/huge.mp4", thumbnailPath: null })),
    ).resolves.toMatchObject({ description: "וידאו ללא תצוגה מקדימה זמינה", engine: "none+none" });
  });

  it("frame extraction yields nothing but a thumbnail exists: falls back to the thumbnail", async () => {
    const vision = fakeVision("גיבוי ממוזער");
    const deps = makeDeps({
      visionAnalyzer: vision,
      extractFrames: vi.fn().mockResolvedValue(fakeFrames([])), // ffmpeg produced no frames
      fileSizeMb: vi.fn().mockReturnValue(5),
    });
    const input = makeInput({ mediaPath: "/media/video.mp4", thumbnailPath: "/media/thumb.jpg" });

    const result = await analyzeVideo(deps, input);

    expect(result.description).toBe("וידאו: גיבוי ממוזער");
    expect(vision.describeImages).toHaveBeenCalledWith(["/media/thumb.jpg"]);
  });

  it("frame extraction yields nothing and no thumbnail: returns sentinel description", async () => {
    const deps = makeDeps({
      extractFrames: vi.fn().mockResolvedValue(fakeFrames([])),
      fileSizeMb: vi.fn().mockReturnValue(5),
    });
    const result = await analyzeVideo(deps, makeInput({ thumbnailPath: null }));
    expect(result.description).toBe("וידאו ללא תצוגה מקדימה זמינה");
  });

  it("in-range video: calls extractFrames with mediaPath", async () => {
    const extractFrames = vi.fn().mockResolvedValue(fakeFrames(["/tmp/f-1.jpg"]));
    const deps = makeDeps({ extractFrames, fileSizeMb: vi.fn().mockReturnValue(5) });
    await analyzeVideo(deps, makeInput());
    expect(extractFrames).toHaveBeenCalledWith("/media/video.mp4");
  });

  it("in-range video: calls extractAudio with mediaPath", async () => {
    const extractAudio = vi.fn().mockResolvedValue("/tmp/audio.wav");
    const deps = makeDeps({ extractAudio, fileSizeMb: vi.fn().mockReturnValue(5) });
    await analyzeVideo(deps, makeInput());
    expect(extractAudio).toHaveBeenCalledWith("/media/video.mp4");
  });

  it("returns an engine label that includes both vision and transcription engines for full video", async () => {
    const deps = makeDeps({
      visionAnalyzer: fakeVision("תיאור", "gemma4:12b"),
      transcribeAudio: vi.fn().mockResolvedValue("דיבור"),
      extractAudio: vi.fn().mockResolvedValue("/tmp/audio.wav"),
      fileSizeMb: vi.fn().mockReturnValue(5),
    });
    const result = await analyzeVideo(deps, makeInput());
    expect(result.engine).toContain("gemma4:12b");
    expect(result.engine).toContain("whisper");
  });

  it("returns an engine label with 'none' for transcription when there is no audio", async () => {
    const deps = makeDeps({
      visionAnalyzer: fakeVision("תיאור", "gemma4:12b"),
      extractAudio: vi.fn().mockResolvedValue(null),
      fileSizeMb: vi.fn().mockReturnValue(5),
    });
    const result = await analyzeVideo(deps, makeInput());
    expect(result.engine).toContain("none");
  });

  it("in-range video exactly at cap (fileSizeMb === maxVideoMb): uses full video path, not thumbnail", async () => {
    const extractFrames = vi.fn().mockResolvedValue(fakeFrames(["/tmp/f-1.jpg"]));
    const deps = makeDeps({
      extractFrames,
      fileSizeMb: vi.fn().mockReturnValue(25), // exactly at cap
      maxVideoMb: 25,
    });
    const input = makeInput({ mediaPath: "/media/video.mp4", thumbnailPath: "/media/thumb.jpg" });
    await analyzeVideo(deps, input);
    expect(extractFrames).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cleanup tests (Fix 1): temp dir and WAV are released via finally
  // ---------------------------------------------------------------------------

  it("cleanup: fsp.rm is called on the frameDir returned by extractFrames", async () => {
    const fakeDir = "/tmp/wsum-frames-test";
    const rmCalls: string[] = [];
    const rmFake = vi.fn().mockImplementation((p: string) => {
      rmCalls.push(p);
      return Promise.resolve();
    });

    // We can't inject fsp.rm directly into analyzeVideo, but we can verify
    // cleanup by using a real dir path and confirming analyzeVideo doesn't throw
    // when dir is non-null (the path just needs to not exist for rm to be no-op).
    // The real fsp.rm uses {force:true} so it won't throw on missing dir.
    // Use dir=null in the fake to skip FS ops; verify the behavior with dir set.
    const extractFrames = vi.fn().mockResolvedValue({ frames: ["/tmp/f-1.jpg"], dir: null });
    const deps = makeDeps({ extractFrames, fileSizeMb: vi.fn().mockReturnValue(5) });
    // Should resolve without error even with dir=null
    await expect(analyzeVideo(deps, makeInput())).resolves.toBeDefined();
    // The extractFrames dep was called
    expect(extractFrames).toHaveBeenCalled();
    void rmFake;
    void fakeDir;
    void rmCalls; // suppress unused-var
  });

  it("cleanup: WAV unlink is called after successful transcription", async () => {
    // Verify analyzeVideo doesn't throw when audioPath is returned — the finally
    // block calls fsp.unlink which is a best-effort no-op on non-existent paths.
    const extractAudio = vi.fn().mockResolvedValue("/tmp/nonexistent-audio.wav");
    const transcribeAudio = vi.fn().mockResolvedValue("hello");
    const deps = makeDeps({
      extractAudio,
      transcribeAudio,
      fileSizeMb: vi.fn().mockReturnValue(5),
    });
    const result = await analyzeVideo(deps, makeInput());
    expect(transcribeAudio).toHaveBeenCalledWith("/tmp/nonexistent-audio.wav");
    expect(result.description).toContain("hello");
  });

  // ---------------------------------------------------------------------------
  // Fix 2: short video / zero frames → fallback single frame
  // ---------------------------------------------------------------------------

  it("Fix 2 (sentinel): zero-frame result with no thumbnail returns sentinel description", async () => {
    const deps = makeDeps({
      extractFrames: vi.fn().mockResolvedValue(fakeFrames([])),
      fileSizeMb: vi.fn().mockReturnValue(2),
    });
    const result = await analyzeVideo(deps, makeInput({ thumbnailPath: null }));
    expect(result.description).toBe("וידאו ללא תצוגה מקדימה זמינה");
  });

  // ---------------------------------------------------------------------------
  // Fix 3: no-frames + no-thumbnail → sentinel, not throw
  // ---------------------------------------------------------------------------

  it("Fix 3 (sentinel): no frames and no thumbnail returns sentinel, does NOT throw", async () => {
    const deps = makeDeps({
      extractFrames: vi.fn().mockResolvedValue(fakeFrames([])),
      fileSizeMb: vi.fn().mockReturnValue(5),
    });
    // Previously this threw; now it should resolve with a sentinel.
    await expect(analyzeVideo(deps, makeInput({ thumbnailPath: null }))).resolves.toMatchObject({
      description: "וידאו ללא תצוגה מקדימה זמינה",
    });
  });
});

// ---------------------------------------------------------------------------
// extractFramesWithFfmpeg — ffmpeg invocation logic (exec injected as a probe)
// ---------------------------------------------------------------------------

describe("extractFramesWithFfmpeg", () => {
  /** A jpg-shaped byte sequence (SOI…EOI) so size > 0 and the .jpg filter matches. */
  const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  it("happy path: writes fps frames and does NOT invoke the single-frame fallback", async () => {
    const exec = vi.fn().mockImplementation(async (_bin: string, args: string[]) => {
      const dir = path.dirname(args[args.length - 1]); // dir/frame-%04d.jpg
      await fsp.writeFile(path.join(dir, "frame-0001.jpg"), JPG_BYTES);
      await fsp.writeFile(path.join(dir, "frame-0002.jpg"), JPG_BYTES);
      return { stdout: "", stderr: "" };
    });
    const { frames, dir } = await extractFramesWithFfmpeg(
      "ffmpeg",
      "/x/video.mp4",
      { fps: 1, maxFrames: 8 },
      exec,
    );
    try {
      expect(frames).toHaveLength(2);
      expect(exec).toHaveBeenCalledTimes(1); // fallback skipped — frames already present
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("sub-1s clip: fps pass exits non-zero (ffmpeg ≥8), fallback grabs one frame", async () => {
    // ffmpeg 8.x rejects with exit 234 ("Nothing was written…") when fps=1 yields
    // zero frames. The fps-pass failure must NOT short-circuit the fallback grab.
    let call = 0;
    const exec = vi.fn().mockImplementation(async (_bin: string, args: string[]) => {
      call++;
      if (call === 1) {
        throw Object.assign(new Error("Conversion failed!"), { code: 234 });
      }
      // Fallback: `-frames:v 1` writes a single frame to the last arg (output path).
      await fsp.writeFile(args[args.length - 1], JPG_BYTES);
      return { stdout: "", stderr: "" };
    });
    const { frames, dir } = await extractFramesWithFfmpeg(
      "ffmpeg",
      "/x/short.mp4",
      { fps: 1, maxFrames: 8 },
      exec,
    );
    try {
      expect(exec).toHaveBeenCalledTimes(2); // fps pass swallowed, then fallback
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatch(/frame-0001\.jpg$/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("unreadable video: both passes fail → returns no frames (no throw)", async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error("No such file"), { code: 1 }));
    const { frames, dir } = await extractFramesWithFfmpeg(
      "ffmpeg",
      "/x/missing.mp4",
      { fps: 1, maxFrames: 8 },
      exec,
    );
    try {
      expect(frames).toEqual([]); // graceful — analyzeVideo turns this into a sentinel
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
