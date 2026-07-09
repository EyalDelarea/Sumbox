import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { runTranscription, transcribeOneNote } from "./run.js";
import type { Transcriber } from "./transcriber.js";

// Stub: returns text, except for paths containing "bad" which throw (FR-013).
class StubTranscriber implements Transcriber {
  opened = false;
  closed = false;
  async open() {
    this.opened = true;
  }
  async transcribe(wavPath: string) {
    if (wavPath.includes("bad")) throw new Error("decode failed");
    return { text: `text-for:${path.basename(wavPath)}` };
  }
  async close() {
    this.closed = true;
  }
}

async function seedMedia(
  pool: pg.Pool,
  groupId: number,
  filename: string,
  dedupeKey: string,
): Promise<void> {
  const row: NormalizedMessage & { participantId: number | null } = {
    groupId,
    importId: null,
    source: "import",
    senderName: null,
    messageType: "media",
    textContent: null,
    mediaFilename: filename,
    mediaPath: `/tmp/${filename}`,
    mediaStatus: "present",
    sentAt: new Date("2026-02-01T08:00:00.000Z"),
    dedupeKey,
    externalId: null,
    participantId: null,
  };
  await insertMessages(pool, [row]);
}

// ---------------------------------------------------------------------------
// transcribeOneNote — prune-after-caption tests
// ---------------------------------------------------------------------------

describe("transcribeOneNote prune-after-caption", () => {
  let pool: pg.Pool;
  let connectionString: string;

  beforeAll(async () => {
    connectionString = await createTestDatabase();
    pool = new pg.Pool({ connectionString });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seedVoiceNote(groupName: string, dedupeKey: string): Promise<number> {
    const groupId = await upsertGroup(pool, { name: groupName, source: "import" });
    const result = await insertMessages(pool, [
      {
        groupId,
        importId: null,
        source: "import",
        senderName: null,
        messageType: "media",
        textContent: null,
        mediaFilename: "voice.opus",
        mediaPath: `/tmp/voice-${dedupeKey}.opus`,
        mediaStatus: "present",
        sentAt: new Date("2026-01-01T10:00:00Z"),
        dedupeKey,
        externalId: null,
        participantId: null,
        fromMe: null,
      },
    ]);
    return result.ids[0]!;
  }

  const stubTranscriber: Transcriber = {
    async open() {},
    async transcribe() {
      return { text: "shalom" };
    },
    async close() {},
  };

  const failingTranscriber: Transcriber = {
    async open() {},
    async transcribe() {
      throw new Error("transcription failed");
    },
    async close() {},
  };

  it("calls pruneMediaFile after successful transcription when retainMedia=false", async () => {
    const messageId = await seedVoiceNote("prune-ok-group", `prune-ok-${Math.random()}`);
    const pruneMediaFile = vi.fn().mockResolvedValue(undefined);

    await transcribeOneNote(String(messageId), {
      databaseUrl: connectionString,
      transcriber: stubTranscriber,
      engine: "stub-engine",
      ffmpegPath: "ffmpeg",
      convert: false,
      retainMedia: false,
      pruneMediaFile,
    });

    expect(pruneMediaFile).toHaveBeenCalledWith(String(messageId));
  });

  it("does NOT call pruneMediaFile when retainMedia=true", async () => {
    const messageId = await seedVoiceNote("prune-retain-group", `prune-retain-${Math.random()}`);
    const pruneMediaFile = vi.fn().mockResolvedValue(undefined);

    await transcribeOneNote(String(messageId), {
      databaseUrl: connectionString,
      transcriber: stubTranscriber,
      engine: "stub-engine",
      ffmpegPath: "ffmpeg",
      convert: false,
      retainMedia: true,
      pruneMediaFile,
    });

    expect(pruneMediaFile).not.toHaveBeenCalled();
  });

  it("does NOT call pruneMediaFile when transcription fails", async () => {
    const messageId = await seedVoiceNote("prune-fail-group", `prune-fail-${Math.random()}`);
    const pruneMediaFile = vi.fn().mockResolvedValue(undefined);

    await expect(
      transcribeOneNote(String(messageId), {
        databaseUrl: connectionString,
        transcriber: failingTranscriber,
        engine: "stub-engine",
        ffmpegPath: "ffmpeg",
        convert: false,
        retainMedia: false,
        pruneMediaFile,
      }),
    ).rejects.toThrow("transcription failed");

    expect(pruneMediaFile).not.toHaveBeenCalled();
  });

  it("passes the chat's participant names as a hotword bias", async () => {
    const groupId = await upsertGroup(pool, {
      name: `bias-group-${Math.random()}`,
      source: "import",
    });
    const bar = await upsertParticipant(pool, `בר-${Math.random()}`);
    // A named text message gives the voice note's group a real roster to bias toward.
    await insertMessages(pool, [
      {
        groupId,
        importId: null,
        source: "import",
        senderName: null,
        messageType: "text",
        textContent: "hi",
        mediaFilename: null,
        mediaPath: null,
        mediaStatus: null,
        sentAt: new Date("2026-01-01T09:00:00Z"),
        dedupeKey: `bias-text-${Math.random()}`,
        externalId: null,
        participantId: bar,
        fromMe: null,
      },
    ]);
    const { ids } = await insertMessages(pool, [
      {
        groupId,
        importId: null,
        source: "import",
        senderName: null,
        messageType: "media",
        textContent: null,
        mediaFilename: "voice.opus",
        mediaPath: `/tmp/voice-bias-${Math.random()}.opus`,
        mediaStatus: "present",
        sentAt: new Date("2026-01-01T10:00:00Z"),
        dedupeKey: `bias-vn-${Math.random()}`,
        externalId: null,
        participantId: null,
        fromMe: null,
      },
    ]);

    let captured: string | undefined;
    const recordingTranscriber: Transcriber = {
      async open() {},
      async transcribe(_wavPath, hotwords) {
        captured = hotwords;
        return { text: "shalom" };
      },
      async close() {},
    };

    await transcribeOneNote(String(ids[0]!), {
      pool,
      databaseUrl: connectionString,
      transcriber: recordingTranscriber,
      engine: "stub-engine",
      ffmpegPath: "ffmpeg",
      convert: false,
      retainMedia: true,
      pruneMediaFile: async () => {},
    });

    expect(captured).toBeDefined();
    expect(captured).toContain("בר-");
  });
});

// ---------------------------------------------------------------------------

describe("runTranscription", () => {
  let pool: pg.Pool;
  let connectionString: string;

  beforeAll(async () => {
    connectionString = await createTestDatabase();
    pool = new pg.Pool({ connectionString });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("transcribes pending, records failures, and is resumable (FR-012, FR-013)", async () => {
    const groupId = await upsertGroup(pool, { name: "RT", source: "import" });
    await seedMedia(pool, groupId, "good-1.opus", "rt-good-1");
    await seedMedia(pool, groupId, "bad-2.opus", "rt-bad-2");

    const stub = new StubTranscriber();
    const first = await runTranscription(
      { groupName: "RT" },
      { databaseUrl: connectionString, transcriber: stub, engine: "stub-engine" },
    );

    expect(first.ok).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.skipped).toBe(0);
    expect(stub.opened).toBe(true);
    expect(stub.closed).toBe(true);

    const { rows } = await pool.query(
      `SELECT status, transcript, error_message FROM transcripts ORDER BY message_id`,
    );
    expect(rows.find((r) => r.status === "completed")?.transcript).toContain("text-for:");
    expect(rows.find((r) => r.status === "failed")?.error_message).toContain("decode failed");

    const second = await runTranscription(
      { groupName: "RT" },
      { databaseUrl: connectionString, transcriber: stub, engine: "stub-engine" },
    );
    expect(second.ok).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
