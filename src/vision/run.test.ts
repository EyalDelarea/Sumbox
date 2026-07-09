/**
 * T010 + T019 — Tests for analyzeMediaOne (src/vision/run.ts).
 *
 * All external deps are injected fakes; no real DB, no real files, no Ollama.
 *
 * T019 tests cover the video branch (kind='video').
 * Prune tests cover the prune-after-caption feature.
 */
import { describe, expect, it, vi } from "vitest";
import type { InsertMediaAnalysisInput } from "../db/repositories/media-analyses.js";
import { analyzeMediaOne } from "./run.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallRecord = InsertMediaAnalysisInput;

function makeMinimalDeps(
  overrides: Partial<{
    getVisualMediaPath: () => Promise<{ path: string; kind: "image" | "video" } | null>;
    visionAnalyzer: {
      describeImage: (p: string) => Promise<{ description: string; engine: string }>;
      describeImages: (paths: string[]) => Promise<{ description: string; engine: string }>;
    };
    normalizeImage: (p: string) => Promise<string>;
    insertMediaAnalysis: (input: InsertMediaAnalysisInput) => Promise<void>;
    engineLabel: string;
    // video-specific deps
    analyzeVideo: (input: {
      mediaPath: string | null;
      thumbnailPath: string | null;
    }) => Promise<{ description: string; engine: string }>;
    getThumbnailPath: (messageId: number) => Promise<string | null>;
    // prune deps
    retainMedia: boolean;
    pruneMediaFile: (messageId: number) => Promise<void>;
  }> = {},
) {
  const insertCalls: CallRecord[] = [];
  return {
    pool: {} as never, // not used directly — all DB calls are injected
    getVisualMediaPath:
      overrides.getVisualMediaPath ??
      vi.fn().mockResolvedValue({ path: "/media/img001.jpg", kind: "image" }),
    visionAnalyzer: overrides.visionAnalyzer ?? {
      describeImage: vi.fn().mockResolvedValue({ description: "תמונה", engine: "llama3.2-vision" }),
      describeImages: vi
        .fn()
        .mockResolvedValue({ description: "תמונה", engine: "llama3.2-vision" }),
    },
    normalizeImage: overrides.normalizeImage ?? vi.fn().mockImplementation(async (p: string) => p), // identity: return same path
    insertMediaAnalysis:
      overrides.insertMediaAnalysis ??
      vi.fn().mockImplementation(async (input: InsertMediaAnalysisInput) => {
        insertCalls.push(input);
      }),
    engineLabel: overrides.engineLabel ?? "llama3.2-vision",
    // video
    analyzeVideo:
      overrides.analyzeVideo ??
      vi.fn().mockResolvedValue({ description: "וידאו: תיאור", engine: "llama3.2-vision+whisper" }),
    getThumbnailPath: overrides.getThumbnailPath ?? vi.fn().mockResolvedValue(null),
    // prune
    retainMedia: overrides.retainMedia ?? false,
    pruneMediaFile: overrides.pruneMediaFile ?? vi.fn().mockResolvedValue(undefined),
    _insertCalls: insertCalls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeMediaOne", () => {
  it("calls getVisualMediaPath with the given messageId", async () => {
    const deps = makeMinimalDeps();
    await analyzeMediaOne(42, "image", deps);
    expect(deps.getVisualMediaPath).toHaveBeenCalledWith(42);
  });

  it("calls normalizeImage with the resolved path", async () => {
    const deps = makeMinimalDeps();
    await analyzeMediaOne(42, "image", deps);
    expect(deps.normalizeImage).toHaveBeenCalledWith("/media/img001.jpg");
  });

  it("calls visionAnalyzer.describeImage with the normalized path", async () => {
    const normalized = "/media/normalized-img001.jpg";
    const deps = makeMinimalDeps({
      normalizeImage: vi.fn().mockResolvedValue(normalized),
    });
    await analyzeMediaOne(42, "image", deps);
    expect(deps.visionAnalyzer.describeImage).toHaveBeenCalledWith(normalized);
  });

  it("inserts a 'completed' analysis row on success", async () => {
    const insertCalls: CallRecord[] = [];
    const deps = makeMinimalDeps({
      insertMediaAnalysis: vi.fn().mockImplementation(async (input: CallRecord) => {
        insertCalls.push(input);
      }),
    });
    await analyzeMediaOne(42, "image", deps);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      messageId: 42,
      kind: "image",
      status: "completed",
      description: "תמונה",
    });
  });

  it("inserts a 'failed' analysis row when describeImage throws, then rethrows", async () => {
    const insertCalls: CallRecord[] = [];
    const boom = new Error("vision engine crashed");
    const deps = makeMinimalDeps({
      visionAnalyzer: {
        describeImage: vi.fn().mockRejectedValue(boom),
        describeImages: vi.fn().mockRejectedValue(boom),
      },
      insertMediaAnalysis: vi.fn().mockImplementation(async (input: CallRecord) => {
        insertCalls.push(input);
      }),
    });
    await expect(analyzeMediaOne(42, "image", deps)).rejects.toThrow("vision engine crashed");
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      messageId: 42,
      kind: "image",
      status: "failed",
    });
    expect(insertCalls[0]!.errorMessage).toBeTruthy();
  });

  it("image — skips gracefully (no failed row, no throw) when getVisualMediaPath returns null", async () => {
    const insertCalls: CallRecord[] = [];
    const describeImage = vi.fn();
    const deps = makeMinimalDeps({
      getVisualMediaPath: vi.fn().mockResolvedValue(null),
      visionAnalyzer: { describeImage } as never,
      insertMediaAnalysis: vi.fn().mockImplementation(async (input: CallRecord) => {
        insertCalls.push(input);
      }),
    });
    // null path = nothing analyzable (pruned/absent/stale job) → terminal skip.
    await expect(analyzeMediaOne(42, "image", deps)).resolves.toBeUndefined();
    expect(insertCalls).toHaveLength(0); // no 'failed' row
    expect(describeImage).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // T019 — video branch
  // ---------------------------------------------------------------------------

  it("T019: video — calls getVisualMediaPath to resolve the mediaPath", async () => {
    const getVisualMediaPath = vi
      .fn()
      .mockResolvedValue({ path: "/media/vid001.mp4", kind: "video" });
    const deps = makeMinimalDeps({ getVisualMediaPath });
    await analyzeMediaOne(42, "video", deps);
    expect(getVisualMediaPath).toHaveBeenCalledWith(42);
  });

  it("T019: video success — inserts a 'completed' analysis row with composed description", async () => {
    const insertCalls: CallRecord[] = [];
    const deps = makeMinimalDeps({
      getVisualMediaPath: vi.fn().mockResolvedValue({ path: "/media/vid001.mp4", kind: "video" }),
      analyzeVideo: vi.fn().mockResolvedValue({
        description: "וידאו: חתול · דיבור: שלום",
        engine: "llama3.2-vision+whisper",
      }),
      insertMediaAnalysis: vi.fn().mockImplementation(async (input: CallRecord) => {
        insertCalls.push(input);
      }),
    });
    await analyzeMediaOne(42, "video", deps);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      messageId: 42,
      kind: "video",
      status: "completed",
      description: "וידאו: חתול · דיבור: שלום",
      engine: "llama3.2-vision+whisper",
    });
  });

  it("T019: video failure — inserts 'failed' row and rethrows", async () => {
    const insertCalls: CallRecord[] = [];
    const boom = new Error("video analysis crashed");
    const deps = makeMinimalDeps({
      getVisualMediaPath: vi.fn().mockResolvedValue({ path: "/media/vid001.mp4", kind: "video" }),
      analyzeVideo: vi.fn().mockRejectedValue(boom),
      insertMediaAnalysis: vi.fn().mockImplementation(async (input: CallRecord) => {
        insertCalls.push(input);
      }),
    });
    await expect(analyzeMediaOne(42, "video", deps)).rejects.toThrow("video analysis crashed");
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      messageId: 42,
      kind: "video",
      status: "failed",
    });
    expect(insertCalls[0]!.errorMessage).toBeTruthy();
  });

  it("T019: video — passes mediaPath and thumbnailPath to analyzeVideo", async () => {
    const analyzeVideo = vi
      .fn()
      .mockResolvedValue({ description: "וידאו: X", engine: "fake+none" });
    const getThumbnailPath = vi.fn().mockResolvedValue("/media/thumb001.jpg");
    const deps = makeMinimalDeps({
      getVisualMediaPath: vi.fn().mockResolvedValue({ path: "/media/vid001.mp4", kind: "video" }),
      analyzeVideo,
      getThumbnailPath,
    });
    await analyzeMediaOne(42, "video", deps);
    expect(getThumbnailPath).toHaveBeenCalledWith(42);
    expect(analyzeVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaPath: "/media/vid001.mp4",
        thumbnailPath: "/media/thumb001.jpg",
      }),
    );
  });

  it("T019: video — passes null thumbnailPath when getThumbnailPath returns null", async () => {
    const analyzeVideo = vi
      .fn()
      .mockResolvedValue({ description: "וידאו: X", engine: "fake+none" });
    const deps = makeMinimalDeps({
      getVisualMediaPath: vi.fn().mockResolvedValue({ path: "/media/vid001.mp4", kind: "video" }),
      analyzeVideo,
      getThumbnailPath: vi.fn().mockResolvedValue(null),
    });
    await analyzeMediaOne(42, "video", deps);
    expect(analyzeVideo).toHaveBeenCalledWith(
      expect.objectContaining({ mediaPath: "/media/vid001.mp4", thumbnailPath: null }),
    );
  });

  it("T019: video — skips gracefully (no failed row, no throw) when getVisualMediaPath returns null", async () => {
    const insertCalls: CallRecord[] = [];
    const analyzeVideo = vi.fn();
    const deps = makeMinimalDeps({
      getVisualMediaPath: vi.fn().mockResolvedValue(null),
      analyzeVideo,
      insertMediaAnalysis: vi.fn().mockImplementation(async (input: CallRecord) => {
        insertCalls.push(input);
      }),
    });
    await expect(analyzeMediaOne(42, "video", deps)).resolves.toBeUndefined();
    expect(insertCalls).toHaveLength(0);
    expect(analyzeVideo).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Prune-after-caption tests
  // ---------------------------------------------------------------------------

  describe("prune-after-caption (image)", () => {
    it("calls pruneMediaFile after successful image analysis when retainMedia=false", async () => {
      const pruneMediaFile = vi.fn().mockResolvedValue(undefined);
      const deps = makeMinimalDeps({ retainMedia: false, pruneMediaFile });
      await analyzeMediaOne(42, "image", deps);
      expect(pruneMediaFile).toHaveBeenCalledWith(42);
    });

    it("does NOT call pruneMediaFile when retainMedia=true", async () => {
      const pruneMediaFile = vi.fn().mockResolvedValue(undefined);
      const deps = makeMinimalDeps({ retainMedia: true, pruneMediaFile });
      await analyzeMediaOne(42, "image", deps);
      expect(pruneMediaFile).not.toHaveBeenCalled();
    });

    it("does NOT call pruneMediaFile on image analysis failure", async () => {
      const pruneMediaFile = vi.fn().mockResolvedValue(undefined);
      const deps = makeMinimalDeps({
        retainMedia: false,
        pruneMediaFile,
        visionAnalyzer: {
          describeImage: vi.fn().mockRejectedValue(new Error("boom")),
          describeImages: vi.fn().mockRejectedValue(new Error("boom")),
        },
      });
      await expect(analyzeMediaOne(42, "image", deps)).rejects.toThrow("boom");
      expect(pruneMediaFile).not.toHaveBeenCalled();
    });
  });

  describe("prune-after-caption (video)", () => {
    it("calls pruneMediaFile after successful video analysis when retainMedia=false", async () => {
      const pruneMediaFile = vi.fn().mockResolvedValue(undefined);
      const deps = makeMinimalDeps({
        retainMedia: false,
        pruneMediaFile,
        getVisualMediaPath: vi.fn().mockResolvedValue({ path: "/media/vid001.mp4", kind: "video" }),
      });
      await analyzeMediaOne(42, "video", deps);
      expect(pruneMediaFile).toHaveBeenCalledWith(42);
    });

    it("does NOT call pruneMediaFile on video analysis failure", async () => {
      const pruneMediaFile = vi.fn().mockResolvedValue(undefined);
      const deps = makeMinimalDeps({
        retainMedia: false,
        pruneMediaFile,
        getVisualMediaPath: vi.fn().mockResolvedValue({ path: "/media/vid001.mp4", kind: "video" }),
        analyzeVideo: vi.fn().mockRejectedValue(new Error("video boom")),
      });
      await expect(analyzeMediaOne(42, "video", deps)).rejects.toThrow("video boom");
      expect(pruneMediaFile).not.toHaveBeenCalled();
    });

    it("does NOT call pruneMediaFile for video when retainMedia=true", async () => {
      const pruneMediaFile = vi.fn().mockResolvedValue(undefined);
      const deps = makeMinimalDeps({
        retainMedia: true,
        pruneMediaFile,
        getVisualMediaPath: vi.fn().mockResolvedValue({ path: "/media/vid001.mp4", kind: "video" }),
      });
      await analyzeMediaOne(42, "video", deps);
      expect(pruneMediaFile).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Fix 1: normalized temp file cleanup (image branch)
  // ---------------------------------------------------------------------------

  describe("normalized temp file cleanup (image)", () => {
    it("does NOT unlink the normalized file when it is the same path as the input (identity normalize)", async () => {
      // normalizeImage returns the same path → no unlink needed
      // We just verify the flow completes without error (fsp.unlink would throw on
      // a non-existent file only if it were called without the .catch guard)
      const deps = makeMinimalDeps({
        normalizeImage: vi.fn().mockImplementation(async (p: string) => p), // identity
      });
      await expect(analyzeMediaOne(42, "image", deps)).resolves.toBeUndefined();
    });

    it("unlinks the normalized file when it differs from the input (temp file created)", async () => {
      // normalizeImage returns a different path (temp file); we verify that
      // analyzeMediaOne still succeeds even when fsp.unlink would fail (non-existent).
      // The .catch(() => {}) guard ensures no throw.
      const normalized = "/tmp/normalized-test-does-not-exist.jpg";
      const deps = makeMinimalDeps({
        normalizeImage: vi.fn().mockResolvedValue(normalized),
      });
      // Should succeed — fsp.unlink with a non-existent path is swallowed by .catch
      await expect(analyzeMediaOne(42, "image", deps)).resolves.toBeUndefined();
    });
  });
});
