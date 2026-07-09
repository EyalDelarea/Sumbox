import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../jobs/job-types.js";
import { makeTranscribeVoicenoteHandler } from "./transcribe-voicenote.js";

function makeJob(messageId: string): Job<"transcribe.voicenote"> {
  return {
    id: "test-job-tv-1",
    type: "transcribe.voicenote",
    payload: { messageId },
    attempts: 1,
    maxAttempts: 3,
  };
}

describe("makeTranscribeVoicenoteHandler", () => {
  it("skips transcription when the note is already transcribed (idempotent)", async () => {
    const transcribeOne = vi.fn();
    const isAlreadyTranscribed = vi.fn().mockResolvedValue(true);

    const handler = makeTranscribeVoicenoteHandler({ transcribeOne, isAlreadyTranscribed });
    await handler(makeJob("42"));

    expect(isAlreadyTranscribed).toHaveBeenCalledWith("42");
    expect(transcribeOne).not.toHaveBeenCalled();
  });

  it("calls transcribeOne once with the messageId when not already transcribed", async () => {
    const transcribeOne = vi.fn().mockResolvedValue(undefined);
    const isAlreadyTranscribed = vi.fn().mockResolvedValue(false);

    const handler = makeTranscribeVoicenoteHandler({ transcribeOne, isAlreadyTranscribed });
    await handler(makeJob("99"));

    expect(isAlreadyTranscribed).toHaveBeenCalledWith("99");
    expect(transcribeOne).toHaveBeenCalledOnce();
    expect(transcribeOne).toHaveBeenCalledWith("99");
  });

  it("resolves without error after a successful transcription", async () => {
    const transcribeOne = vi.fn().mockResolvedValue(undefined);
    const isAlreadyTranscribed = vi.fn().mockResolvedValue(false);

    const handler = makeTranscribeVoicenoteHandler({ transcribeOne, isAlreadyTranscribed });
    await expect(handler(makeJob("7"))).resolves.toBeUndefined();
  });

  it("throws when transcribeOne throws (so the bus retries)", async () => {
    const transcribeOne = vi.fn().mockRejectedValue(new Error("Python crashed"));
    const isAlreadyTranscribed = vi.fn().mockResolvedValue(false);

    const handler = makeTranscribeVoicenoteHandler({ transcribeOne, isAlreadyTranscribed });
    await expect(handler(makeJob("5"))).rejects.toThrow("Python crashed");
  });

  it("does not call transcribeOne when isAlreadyTranscribed throws", async () => {
    // If the DB check itself fails, we should propagate that error (not silently skip)
    const transcribeOne = vi.fn();
    const isAlreadyTranscribed = vi.fn().mockRejectedValue(new Error("db unreachable"));

    const handler = makeTranscribeVoicenoteHandler({ transcribeOne, isAlreadyTranscribed });
    await expect(handler(makeJob("3"))).rejects.toThrow("db unreachable");
    expect(transcribeOne).not.toHaveBeenCalled();
  });
});
