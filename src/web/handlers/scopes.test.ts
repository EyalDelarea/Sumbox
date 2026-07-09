/**
 * Tests for the PUT /api/scopes handler — specifically the "analyze-on-include" path
 * added in PR 2: when a chat is flipped to `included`, the handler must enqueue analysis
 * jobs for already-downloaded-but-unanalyzed media in that group.
 *
 * Strategy: real DB (Testcontainers), fake enqueue probe. No global mocks.
 */

import type http from "node:http";
import { PassThrough } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../../db/repositories/groups.js";
import { insertMediaAnalysis } from "../../db/repositories/media-analyses.js";
import { upsertMessageMedia } from "../../db/repositories/message-media.js";
import { insertMessages } from "../../db/repositories/messages.js";
import { insertTranscript } from "../../db/repositories/transcripts.js";
import type { NormalizedMessage } from "../../importer/types.js";
import type { JobPayloads, JobType } from "../../jobs/job-types.js";
import { createTestDatabase } from "../../test/db.js";
import type { ServerDeps } from "./context.js";
import { handleScopes } from "./scopes.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

type EnqueueCall = { type: JobType; payload: JobPayloads[JobType] };

/** Thin fake ServerDeps — only the fields handleScopes actually touches. */
function makeDeps(
  pool: pg.Pool,
  enqueue: (type: JobType, payload: JobPayloads[JobType]) => Promise<void>,
): ServerDeps {
  return {
    pool,
    summarizer: null as unknown as ServerDeps["summarizer"],
    tokenBudget: 0,
    model: "fake",
    enqueue,
  };
}

/** Build a minimal NormalizedMessage for a media message. */
function mediaMsg(
  groupId: number,
  dedupeKey: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage & { participantId: null } {
  return {
    groupId,
    importId: null,
    source: "import" as const,
    senderName: null,
    messageType: "media" as const,
    textContent: null,
    mediaFilename: "IMG-001.jpg",
    mediaPath: "/tmp/IMG-001.jpg",
    mediaStatus: "present" as const,
    sentAt: new Date("2026-01-01T08:00:00.000Z"),
    dedupeKey,
    externalId: null,
    participantId: null,
    ...overrides,
  };
}

/** Seed a media message and return its id. */
async function seedMediaMessage(
  pool: pg.Pool,
  groupId: number,
  dedupeKey: string,
  overrides: Partial<NormalizedMessage> = {},
): Promise<number> {
  const row = mediaMsg(groupId, dedupeKey, overrides);
  await insertMessages(pool, [row]);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM messages WHERE dedupe_key = $1`,
    [dedupeKey],
  );
  return Number(rows[0].id);
}

/** Upsert a message_media row with download_state='present'. */
async function seedPresentMedia(
  pool: pg.Pool,
  messageId: number,
  mediaKind: "image" | "video" | "audio",
): Promise<void> {
  await upsertMessageMedia(pool, {
    messageId,
    mediaKind,
    mimeType: null,
    mediaKey: null,
    directPath: null,
    url: null,
    fileEncSha256: null,
    fileSha256: null,
    mediaKeyTs: null,
    fileLength: null,
    waMessage: null,
    downloadState: "present",
  });
}

/** Build a minimal PUT /api/scopes request body. */
function makePutRequest(body: unknown): http.IncomingMessage {
  const json = JSON.stringify(body);
  // Use PassThrough so the async-iterator in readJsonBody receives the data correctly.
  // IncomingMessage with manual emit races: the stream is already paused when the
  // iterator starts and emitting via nextTick misses the data event.
  const stream = new PassThrough();
  stream.push(Buffer.from(json));
  stream.push(null);
  const req = Object.assign(stream, {
    method: "PUT",
    headers: { "content-length": String(Buffer.byteLength(json)) },
  }) as unknown as http.IncomingMessage;
  return req;
}

/** Collect the response body as a string. */
function collectResponse(): { res: http.ServerResponse; bodyPromise: Promise<string> } {
  const chunks: Buffer[] = [];
  let resolve: (v: string) => void;
  const bodyPromise = new Promise<string>((r) => {
    resolve = r;
  });
  // Minimal writable response mock
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => {},
    writeHead(code: number, _headers?: unknown) {
      this.statusCode = code;
    },
    write(chunk: Buffer | string) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      resolve(Buffer.concat(chunks).toString("utf8"));
    },
  } as unknown as http.ServerResponse;
  return { res, bodyPromise };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PUT /api/scopes — analyze-on-include", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("enqueues analyze.image for a present unanalyzed image when group is flipped to included", async () => {
    const groupId = await upsertGroup(pool, {
      name: `scope-img-${Math.random()}`,
      source: "import",
    });
    const msgId = await seedMediaMessage(pool, groupId, `sc-img-${Math.random()}`);
    await seedPresentMedia(pool, msgId, "image");

    const calls: EnqueueCall[] = [];
    const enqueue = async (type: JobType, payload: JobPayloads[JobType]) => {
      calls.push({ type, payload });
    };
    const deps = makeDeps(pool, enqueue);

    // Get the group name to use in the request
    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM groups WHERE id=$1`, [
      groupId,
    ]);
    const groupName = rows[0].name;

    const req = makePutRequest({ updates: [{ group: groupName, included: true }] });
    const { res, bodyPromise } = collectResponse();
    const url = new URL("http://localhost/api/scopes");
    await handleScopes(url, req, res, deps);
    await bodyPromise;

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("analyze.image");
    expect((calls[0].payload as { messageId: string }).messageId).toBe(String(msgId));
  });

  it("enqueues transcribe.voicenote for a present unanalyzed audio message", async () => {
    const groupId = await upsertGroup(pool, {
      name: `scope-audio-${Math.random()}`,
      source: "import",
    });
    const msgId = await seedMediaMessage(pool, groupId, `sc-audio-${Math.random()}`, {
      mediaFilename: "PTT-001.opus",
    });
    await seedPresentMedia(pool, msgId, "audio");

    const calls: EnqueueCall[] = [];
    const enqueue = async (type: JobType, payload: JobPayloads[JobType]) => {
      calls.push({ type, payload });
    };
    const deps = makeDeps(pool, enqueue);

    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM groups WHERE id=$1`, [
      groupId,
    ]);
    const groupName = rows[0].name;

    const req = makePutRequest({ updates: [{ group: groupName, included: true }] });
    const { res, bodyPromise } = collectResponse();
    await handleScopes(new URL("http://localhost/api/scopes"), req, res, deps);
    await bodyPromise;

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("transcribe.voicenote");
    expect((calls[0].payload as { messageId: string }).messageId).toBe(String(msgId));
  });

  it("does NOT enqueue for media that already has a completed analysis", async () => {
    const groupId = await upsertGroup(pool, {
      name: `scope-analyzed-${Math.random()}`,
      source: "import",
    });
    const msgId = await seedMediaMessage(pool, groupId, `sc-analyzed-${Math.random()}`);
    await seedPresentMedia(pool, msgId, "image");
    // Seed a completed analysis
    await insertMediaAnalysis(pool, {
      messageId: msgId,
      kind: "image",
      description: "a photo",
      engine: "llava",
      status: "completed",
    });

    const calls: EnqueueCall[] = [];
    const deps = makeDeps(pool, async (type, payload) => {
      calls.push({ type, payload });
    });

    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM groups WHERE id=$1`, [
      groupId,
    ]);
    const req = makePutRequest({ updates: [{ group: rows[0].name, included: true }] });
    const { res, bodyPromise } = collectResponse();
    await handleScopes(new URL("http://localhost/api/scopes"), req, res, deps);
    await bodyPromise;

    expect(calls).toHaveLength(0);
  });

  it("does NOT enqueue for audio that already has a transcript", async () => {
    const groupId = await upsertGroup(pool, {
      name: `scope-transcribed-${Math.random()}`,
      source: "import",
    });
    const msgId = await seedMediaMessage(pool, groupId, `sc-transcribed-${Math.random()}`, {
      mediaFilename: "PTT-002.opus",
    });
    await seedPresentMedia(pool, msgId, "audio");
    // Seed a transcript (any status)
    await insertTranscript(pool, {
      messageId: msgId,
      transcript: "שלום",
      engine: "whisper",
      status: "completed",
    });

    const calls: EnqueueCall[] = [];
    const deps = makeDeps(pool, async (type, payload) => {
      calls.push({ type, payload });
    });

    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM groups WHERE id=$1`, [
      groupId,
    ]);
    const req = makePutRequest({ updates: [{ group: rows[0].name, included: true }] });
    const { res, bodyPromise } = collectResponse();
    await handleScopes(new URL("http://localhost/api/scopes"), req, res, deps);
    await bodyPromise;

    expect(calls).toHaveLength(0);
  });

  it("does NOT enqueue for media in a group that stays excluded", async () => {
    const groupId = await upsertGroup(pool, {
      name: `scope-excl-${Math.random()}`,
      source: "import",
    });
    const msgId = await seedMediaMessage(pool, groupId, `sc-excl-${Math.random()}`);
    await seedPresentMedia(pool, msgId, "image");

    const calls: EnqueueCall[] = [];
    const deps = makeDeps(pool, async (type, payload) => {
      calls.push({ type, payload });
    });

    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM groups WHERE id=$1`, [
      groupId,
    ]);
    // Set included: false (explicitly excluded)
    const req = makePutRequest({ updates: [{ group: rows[0].name, included: false }] });
    const { res, bodyPromise } = collectResponse();
    await handleScopes(new URL("http://localhost/api/scopes"), req, res, deps);
    await bodyPromise;

    expect(calls).toHaveLength(0);
  });

  it("does NOT enqueue for pending media (only present media is eligible)", async () => {
    const groupId = await upsertGroup(pool, {
      name: `scope-pending-${Math.random()}`,
      source: "import",
    });
    const msgId = await seedMediaMessage(pool, groupId, `sc-pending-${Math.random()}`);
    // pending, not present
    await upsertMessageMedia(pool, {
      messageId: msgId,
      mediaKind: "image",
      mimeType: null,
      mediaKey: null,
      directPath: null,
      url: null,
      fileEncSha256: null,
      fileSha256: null,
      mediaKeyTs: null,
      fileLength: null,
      waMessage: null,
      downloadState: "pending",
    });

    const calls: EnqueueCall[] = [];
    const deps = makeDeps(pool, async (type, payload) => {
      calls.push({ type, payload });
    });

    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM groups WHERE id=$1`, [
      groupId,
    ]);
    const req = makePutRequest({ updates: [{ group: rows[0].name, included: true }] });
    const { res, bodyPromise } = collectResponse();
    await handleScopes(new URL("http://localhost/api/scopes"), req, res, deps);
    await bodyPromise;

    expect(calls).toHaveLength(0);
  });

  it("skips enqueue gracefully when deps.enqueue is absent", async () => {
    const groupId = await upsertGroup(pool, {
      name: `scope-noenq-${Math.random()}`,
      source: "import",
    });
    const msgId = await seedMediaMessage(pool, groupId, `sc-noenq-${Math.random()}`);
    await seedPresentMedia(pool, msgId, "image");

    // No enqueue provided — should not throw
    const deps: ServerDeps = {
      pool,
      summarizer: null as unknown as ServerDeps["summarizer"],
      tokenBudget: 0,
      model: "fake",
      // enqueue intentionally absent
    };

    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM groups WHERE id=$1`, [
      groupId,
    ]);
    const req = makePutRequest({ updates: [{ group: rows[0].name, included: true }] });
    const { res, bodyPromise } = collectResponse();
    await handleScopes(new URL("http://localhost/api/scopes"), req, res, deps);
    const body = await bodyPromise;
    // Should return 200 successfully
    expect(JSON.parse(body)).toMatchObject({ updated: 1 });
  });
});
