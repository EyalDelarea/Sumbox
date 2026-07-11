import type { Job } from "../../jobs/job-types.js";
import { makeIdempotentHandler } from "./idempotent-handler.js";

export type TranscribeVoicenoteHandlerDeps = {
  /**
   * Transcribes the voice note for the given messageId (string) and persists
   * the transcript. Throws on failure so the bus can retry.
   */
  transcribeOne: (messageId: string) => Promise<void>;
  /**
   * Returns true if a transcript already exists for this messageId (any status).
   * Used for idempotency / redelivery-safety (FR-012).
   */
  isAlreadyTranscribed: (messageId: string) => Promise<boolean>;
};

/**
 * Factory that returns a `transcribe.voicenote` job handler.
 *
 * Behaviour:
 * 1. Check if the note is already transcribed → return early (no-op, idempotent).
 * 2. Call transcribeOne to run the transcription and persist the result.
 * 3. On transcribeOne failure → rethrow so the bus retries.
 *
 * All heavy I/O (Python, ffmpeg, DB) is injected via deps for testability.
 */
export function makeTranscribeVoicenoteHandler(deps: TranscribeVoicenoteHandlerDeps) {
  // Idempotency (skip if already transcribed) lives in the shared wrapper; the
  // transcribeOne core throws on failure → the bus retries.
  return makeIdempotentHandler<[Job<"transcribe.voicenote">]>({
    isDone: (job) => deps.isAlreadyTranscribed(job.payload.messageId),
    work: (job) => deps.transcribeOne(job.payload.messageId),
  });
}
