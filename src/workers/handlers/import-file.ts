import { currentTenantId } from "../../db/tenant-context.js";
import type { RunImportInput, RunImportResult } from "../../importer/run-import.js";
import type { JobBus } from "../../jobs/job-bus.js";
import type { Job } from "../../jobs/job-types.js";

export type ImportFileHandlerDeps = {
  /** Calls the full import pipeline. */
  runImport: (input: RunImportInput) => Promise<RunImportResult>;
  /**
   * Returns message IDs (as strings) for voice notes that belong to the just-
   * imported scope and have not yet been transcribed.
   * Receives the full RunImportResult so the implementation can scope by
   * groupName (or import id if available).
   */
  listUntranscribed: (result: RunImportResult) => Promise<string[]>;
  /** Job bus used to enqueue transcribe.voicenote jobs. */
  bus: JobBus;
};

/**
 * Factory that returns an `import.file` job handler.
 *
 * Behaviour:
 * 1. Run runImport for the given file.
 * 2. Ask listUntranscribed for message IDs belonging to this import scope.
 * 3. Enqueue one `transcribe.voicenote` job per message ID.
 * Idempotent: import dedupe + ON CONFLICT on transcripts table handles re-runs.
 * On runImport failure: rethrow so the bus can retry.
 */
export function makeImportFileHandler(deps: ImportFileHandlerDeps) {
  return async function importFileHandler(job: Job<"import.file">): Promise<void> {
    const { filePath, name } = job.payload;

    // Step 1: run the import (throws on failure → bus retries)
    const result = await deps.runImport({ filePath, name: name ?? "" });

    // Step 2: find untranscribed voice notes for the just-imported scope
    const messageIds = await deps.listUntranscribed(result);

    // Step 3: enqueue one transcribe job per voice note
    for (const messageId of messageIds) {
      await deps.bus.enqueue("transcribe.voicenote", { messageId, tenantId: currentTenantId() });
    }
  };
}
