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
  return async function analyzeMediaHandler(
    job: { payload: { messageId: string } },
    type: "analyze.image" | "analyze.video",
  ): Promise<void> {
    const messageId = Number(job.payload.messageId);
    const kind: "image" | "video" = type === "analyze.video" ? "video" : "image";

    // Idempotency: skip if already analyzed (handles redelivery safely)
    const alreadyDone = await deps.hasAnalysis(messageId);
    if (alreadyDone) {
      return;
    }

    // Analyze and persist (throws on failure → bus retries)
    await deps.analyzeOne(messageId, kind);
  };
}
