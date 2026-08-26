import { describe, expect, it, vi } from "vitest";
import type { CandidateMessage } from "../../ask/memory-extract.js";
import type { Job } from "../../jobs/job-types.js";
import { makeMemoryExtractHandler } from "./memory-extract.js";

const job = (): Job<"memory.extract"> => ({
  id: "j1",
  type: "memory.extract",
  payload: { groupId: "70", since: "2026-05-01T00:00:00Z", until: "2026-05-02T00:00:00Z" },
  attempts: 1,
  maxAttempts: 3,
});

const shown: CandidateMessage[] = [
  {
    messageId: 10,
    sender: "Royi",
    senderJid: "972501111111@s.whatsapp.net",
    content: "אני עובד בסייבר",
    sentAt: new Date(),
  },
  // A real person the ingest path never captured a jid for. Must stay readable.
  { messageId: 11, sender: "Alex", senderJid: null, content: "אני גר בחיפה", sentAt: new Date() },
];

const deps = (over: Partial<Parameters<typeof makeMemoryExtractHandler>[0]> = {}) => ({
  selectCandidates: async () => shown,
  generate: async () => "[]",
  recordObservation: async () => 1,
  ...over,
});

describe("memory.extract handler (shadow)", () => {
  it("writes only candidates that cite a message it was shown", async () => {
    const recordObservation = vi.fn(async () => 1);
    const handle = makeMemoryExtractHandler(
      deps({
        generate: async () =>
          JSON.stringify([
            { sourceMessageId: 10, content: "works in cyber" },
            // Invented id — the extractor's likeliest failure, and the one that
            // could otherwise point at another group's message.
            { sourceMessageId: 999, content: "made this up" },
          ]),
        recordObservation,
      }),
    );
    const out = await handle(job());
    expect(out).toMatchObject({ considered: 2, proposed: 2, accepted: 1 });
    expect(out.rejected["invented-id"]).toBe(1);
    expect(recordObservation).toHaveBeenCalledOnce();
    expect(recordObservation).toHaveBeenCalledWith({
      groupId: 70,
      sourceMessageId: 10,
      content: "works in cyber",
    });
  });

  it("counts a DB-layer rejection separately from the model's own mistakes", async () => {
    // recordObservation returns null when the row is deduped or refused. Folding
    // that into the model's error counts would hide which half is misbehaving.
    const handle = makeMemoryExtractHandler(
      deps({
        generate: async () => JSON.stringify([{ sourceMessageId: 11, content: "lives in Haifa" }]),
        recordObservation: async () => null,
      }),
    );
    const out = await handle(job());
    expect(out.accepted).toBe(0);
    expect(out.rejected["deduped-or-rejected"]).toBe(1);
  });

  it("treats an empty window as success, not failure", async () => {
    // Quiet windows are the common case; throwing would dead-letter half the runs.
    const generate = vi.fn(async () => "[]");
    const handle = makeMemoryExtractHandler(deps({ selectCandidates: async () => [], generate }));
    const out = await handle(job());
    expect(out).toMatchObject({ considered: 0, proposed: 0, accepted: 0 });
    // And it must not spend a GPU call to discover there was nothing to read.
    expect(generate).not.toHaveBeenCalled();
  });

  it("writes nothing when the model's reply cannot be parsed", async () => {
    const recordObservation = vi.fn(async () => 1);
    const handle = makeMemoryExtractHandler(
      deps({ generate: async () => "I could not find anything", recordObservation }),
    );
    const out = await handle(job());
    expect(out.proposed).toBe(0);
    expect(recordObservation).not.toHaveBeenCalled();
  });
});
