/**
 * makeAnalyzeMediaHandler — factory for the analyze.image / analyze.video job handler.
 *
 * Analog of makeTranscribeVoicenoteHandler.
 *
 * Behaviour:
 * 1. Check if analysis already exists → return early (idempotent on redelivery).
 * 2. Call analyzeOne(messageId, kind) to run analysis and persist result.
 * 3. On analyzeOne failure → rethrow so the bus retries.
 *
 * All heavy I/O (Ollama, ffmpeg, DB) is injected via deps for testability.
 */

import { makeIdempotentHandler } from "./idempotent-handler.js";

export type AnalyzeMediaHandlerDeps = {
  /**
   * Returns true if a media_analyses row already exists for this messageId.
   * Used for idempotency on redelivery.
   */
  hasAnalysis: (messageId: number) => Promise<boolean>;
  /**
   * Runs analysis for the given message and kind, persisting the result.
   * Throws on failure so the bus can retry.
   */
  analyzeOne: (messageId: number, kind: "image" | "video") => Promise<void>;
};

/**
 * Factory that returns an analyze.image / analyze.video job handler.
 * The returned function accepts the payload and the job type so a single
 * handler instance can serve both types.
 */
export function makeAnalyzeMediaHandler(deps: AnalyzeMediaHandlerDeps) {
  // Idempotency (skip if already analyzed) lives in the shared wrapper; the
  // analyzeOne core throws on failure → the bus retries.
  return makeIdempotentHandler<
    [{ payload: { messageId: string } }, "analyze.image" | "analyze.video"]
  >({
    isDone: (job) => deps.hasAnalysis(Number(job.payload.messageId)),
    work: (job, type) =>
      deps.analyzeOne(Number(job.payload.messageId), type === "analyze.video" ? "video" : "image"),
  });
}
