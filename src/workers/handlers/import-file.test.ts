import { describe, expect, it, vi } from "vitest";
import { InMemoryJobBus } from "../../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../../jobs/job-run-recorder.js";
import type { Job } from "../../jobs/job-types.js";
import { makeImportFileHandler } from "./import-file.js";

function makeBus() {
  const recorder = new InMemoryJobRunRecorder();
  return new InMemoryJobBus(recorder);
}

function makeJob(filePath: string, name?: string): Job<"import.file"> {
  return {
    id: "test-job-1",
    type: "import.file",
    payload: { filePath, name },
    attempts: 1,
    maxAttempts: 3,
  };
}

describe("makeImportFileHandler", () => {
  it("calls runImport with job payload's filePath and name", async () => {
    const bus = makeBus();
    const runImport = vi
      .fn()
      .mockResolvedValue({ groupName: "Test", inserted: 5, skipped: 0, mediaFiles: 0 });
    const listUntranscribed = vi.fn().mockResolvedValue([]);

    const handler = makeImportFileHandler({ runImport, listUntranscribed, bus });
    await handler(makeJob("/path/to/chat.txt", "MyGroup"));

    expect(runImport).toHaveBeenCalledWith({ filePath: "/path/to/chat.txt", name: "MyGroup" });
  });

  it("enqueues one transcribe.voicenote job per untranscribed voice note", async () => {
    const bus = makeBus();
    const runImport = vi
      .fn()
      .mockResolvedValue({ groupName: "Test", inserted: 10, skipped: 0, mediaFiles: 3 });
    const messageIds = ["101", "102", "103"];
    const listUntranscribed = vi.fn().mockResolvedValue(messageIds);

    const handler = makeImportFileHandler({ runImport, listUntranscribed, bus });
    await handler(makeJob("/path/to/chat.zip", "MyGroup"));

    // After consuming, we check how many transcribe.voicenote jobs were enqueued
    expect(await bus.depth("transcribe.voicenote")).toBe(3);
  });

  it("enqueues jobs with the correct messageId payloads", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const runImport = vi
      .fn()
      .mockResolvedValue({ groupName: "Test", inserted: 2, skipped: 0, mediaFiles: 2 });
    const listUntranscribed = vi.fn().mockResolvedValue(["42", "99"]);

    const handler = makeImportFileHandler({ runImport, listUntranscribed, bus });
    await handler(makeJob("/path/to/chat.zip", "MyGroup"));

    // Collect all transcribe.voicenote jobs by consuming
    const enqueuedPayloads: Array<{ messageId: string }> = [];
    await bus.consume(
      "transcribe.voicenote",
      async (job) => {
        enqueuedPayloads.push(job.payload);
      },
      { prefetch: 10 },
    );

    expect(enqueuedPayloads).toHaveLength(2);
    expect(enqueuedPayloads.map((p) => p.messageId).sort()).toEqual(["42", "99"]);
  });

  it("enqueues zero jobs when there are no untranscribed voice notes", async () => {
    const bus = makeBus();
    const runImport = vi
      .fn()
      .mockResolvedValue({ groupName: "Test", inserted: 5, skipped: 0, mediaFiles: 0 });
    const listUntranscribed = vi.fn().mockResolvedValue([]);

    const handler = makeImportFileHandler({ runImport, listUntranscribed, bus });
    await handler(makeJob("/path/to/chat.txt", "NoVoiceNotes"));

    expect(await bus.depth("transcribe.voicenote")).toBe(0);
  });

  it("passes the runImport result to listUntranscribed (import result context)", async () => {
    const bus = makeBus();
    const importResult = { groupName: "Test", inserted: 5, skipped: 0, mediaFiles: 0 };
    const runImport = vi.fn().mockResolvedValue(importResult);
    const listUntranscribed = vi.fn().mockResolvedValue([]);

    const handler = makeImportFileHandler({ runImport, listUntranscribed, bus });
    await handler(makeJob("/path/to/chat.txt", "Test"));

    expect(listUntranscribed).toHaveBeenCalledWith(importResult);
  });

  it("throws when runImport throws (so the bus retries)", async () => {
    const bus = makeBus();
    const runImport = vi.fn().mockRejectedValue(new Error("import failed: corrupt file"));
    const listUntranscribed = vi.fn().mockResolvedValue([]);

    const handler = makeImportFileHandler({ runImport, listUntranscribed, bus });

    await expect(handler(makeJob("/path/to/bad.zip", "BadGroup"))).rejects.toThrow(
      "import failed: corrupt file",
    );
  });

  it("does not call listUntranscribed when runImport throws", async () => {
    const bus = makeBus();
    const runImport = vi.fn().mockRejectedValue(new Error("db error"));
    const listUntranscribed = vi.fn();

    const handler = makeImportFileHandler({ runImport, listUntranscribed, bus });
    await expect(handler(makeJob("/path/to/chat.txt", "Grp"))).rejects.toThrow();

    expect(listUntranscribed).not.toHaveBeenCalled();
  });
});
