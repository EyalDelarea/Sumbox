import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMediaAnalysis } from "../db/repositories/media-analyses.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import { insertTranscript } from "../db/repositories/transcripts.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import {
  firstPendingVisualMediaAfter,
  firstPendingVoiceNoteAfter,
  selectAfterCursor,
  selectMessages,
} from "./select.js";

describe("selectMessages", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seed(
    groupId: number,
    m: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date },
  ): Promise<number> {
    const senderName = m.senderName !== undefined ? m.senderName : "Dana";
    let participantId: number | null = null;
    if (senderName != null) {
      participantId = await upsertParticipant(pool, senderName);
    }
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName,
      messageType: "text",
      textContent: "hi",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId,
      ...m,
      // Re-apply participantId after spread so it reflects the resolved value
      // (unless caller explicitly overrides senderName to null above)
    };
    // Override participantId: if m.senderName was explicitly null, keep null
    if (m.senderName === null) {
      row.participantId = null;
    } else {
      row.participantId = participantId;
    }
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key=$1`,
      [row.dedupeKey],
    );
    return Number(rows[0].id);
  }

  it("returns content-bearing messages chronologically, transcript substituting for a voice note, excluding system/empty", async () => {
    const g = await upsertGroup(pool, { name: "SEL-1", source: "import" });
    await seed(g, {
      dedupeKey: "s1",
      sentAt: new Date("2026-01-01T10:00:00Z"),
      textContent: "first",
    });
    const voiceId = await seed(g, {
      dedupeKey: "s2",
      sentAt: new Date("2026-01-01T11:00:00Z"),
      messageType: "media",
      textContent: null,
      mediaFilename: "a.opus",
      mediaPath: "/tmp/a.opus",
      mediaStatus: "present",
    });
    await seed(g, {
      dedupeKey: "s3",
      sentAt: new Date("2026-01-01T12:00:00Z"),
      messageType: "system",
      senderName: null,
      textContent: "X added Y",
    });
    await seed(g, {
      dedupeKey: "s4",
      sentAt: new Date("2026-01-01T13:00:00Z"),
      messageType: "media",
      textContent: null,
      mediaFilename: "b.opus",
      mediaPath: "/tmp/b.opus",
      mediaStatus: "present",
    });
    await insertTranscript(pool, {
      messageId: voiceId,
      transcript: "שלום מהקול",
      engine: "t",
      status: "completed",
    });

    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs.map((x) => x.content)).toEqual(["first", "שלום מהקול"]);
    expect(msgs[0].sender).toBe("Dana");
    expect(msgs[0].sentAt instanceof Date).toBe(true);
  });

  it("--last N returns the newest N in chronological order", async () => {
    const g = await upsertGroup(pool, { name: "SEL-2", source: "import" });
    for (let i = 0; i < 5; i++) {
      await seed(g, {
        dedupeKey: `n${i}`,
        sentAt: new Date(`2026-02-0${i + 1}T10:00:00Z`),
        textContent: `m${i}`,
      });
    }
    const msgs = await selectMessages(pool, g, { last: 2 });
    expect(msgs.map((x) => x.content)).toEqual(["m3", "m4"]);
  });

  it("--since returns only messages on/after the date", async () => {
    const g = await upsertGroup(pool, { name: "SEL-3", source: "import" });
    await seed(g, {
      dedupeKey: "old",
      sentAt: new Date("2026-03-01T10:00:00Z"),
      textContent: "old",
    });
    await seed(g, {
      dedupeKey: "new",
      sentAt: new Date("2026-03-10T10:00:00Z"),
      textContent: "new",
    });
    const msgs = await selectMessages(pool, g, { since: new Date("2026-03-05T00:00:00Z") });
    expect(msgs.map((x) => x.content)).toEqual(["new"]);
  });

  it("returns [] when the selection is empty (FR-019)", async () => {
    const g = await upsertGroup(pool, { name: "SEL-4", source: "import" });
    expect(await selectMessages(pool, g, { last: 100 })).toEqual([]);
    expect(await selectMessages(pool, g, { since: new Date("2030-01-01T00:00:00Z") })).toEqual([]);
  });

  it("excludes the /סיכום bot-command trigger from summarized content", async () => {
    const g = await upsertGroup(pool, { name: "SEL-CMD", source: "import" });
    await seed(g, {
      dedupeKey: "cmd",
      sentAt: new Date("2026-01-01T10:00:00Z"),
      textContent: "  /סיכום  ", // trimmed by the query
    });
    await seed(g, {
      dedupeKey: "real",
      sentAt: new Date("2026-01-01T11:00:00Z"),
      textContent: "actual message",
    });
    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs.map((x) => x.content)).toEqual(["actual message"]);
  });

  it("excludes /סיכום WITH trailing text, but keeps a word that merely starts with it", async () => {
    // The collector now fires on "/סיכום <anything>", so excluding only the bare
    // literal would let every invocation with trailing text back in as content —
    // 5 landed in the corpus that way in the measured 24h window. The boundary
    // keeps "/סיכוםX" (a different word, not the command) as real conversation.
    const g = await upsertGroup(pool, { name: "SEL-CMD-ARGS", source: "import" });
    await seed(g, {
      dedupeKey: "cmd-args",
      sentAt: new Date("2026-01-01T10:00:00Z"),
      textContent: "/סיכום אוהבים אותך",
    });
    await seed(g, {
      dedupeKey: "cmd-sos",
      sentAt: new Date("2026-01-01T10:30:00Z"),
      textContent: "  /סיכום HELP SOS CALL 911  ",
    });
    await seed(g, {
      dedupeKey: "not-cmd",
      sentAt: new Date("2026-01-01T11:00:00Z"),
      textContent: "/סיכוםX משהו אחר",
    });
    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs.map((x) => x.content)).toEqual(["/סיכוםX משהו אחר"]);
  });
});

describe("selectAfterCursor", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seed(
    groupId: number,
    m: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date },
  ): Promise<number> {
    const senderName = m.senderName !== undefined ? m.senderName : "Dana";
    let participantId: number | null = null;
    if (senderName != null) {
      participantId = await upsertParticipant(pool, senderName);
    }
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName,
      messageType: "text",
      textContent: "hi",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId,
      ...m,
    };
    if (m.senderName === null) {
      row.participantId = null;
    } else {
      row.participantId = participantId;
    }
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key=$1`,
      [row.dedupeKey],
    );
    return Number(rows[0]!.id);
  }

  it("returns only messages strictly after the cursor, ascending by (sent_at, id)", async () => {
    const g = await upsertGroup(pool, { name: "SAC-1", source: "import" });
    const sentAt1 = new Date("2026-01-01T10:00:00Z");
    const sentAt2 = new Date("2026-01-01T11:00:00Z");
    const sentAt3 = new Date("2026-01-01T12:00:00Z");

    const id1 = await seed(g, { dedupeKey: "sac1-a", sentAt: sentAt1, textContent: "before" });
    await seed(g, { dedupeKey: "sac1-b", sentAt: sentAt2, textContent: "at cursor" });
    await seed(g, { dedupeKey: "sac1-c", sentAt: sentAt3, textContent: "after" });

    // Cursor at the first message
    const results = await selectAfterCursor(pool, g, { sentAt: sentAt1, messageId: id1 });
    expect(results.map((r) => r.content)).toEqual(["at cursor", "after"]);
    // Ascending order
    expect(results[0]!.sentAt.getTime()).toBeLessThan(results[1]!.sentAt.getTime());
  });

  it("excludes the cursor message itself (strictly after)", async () => {
    const g = await upsertGroup(pool, { name: "SAC-2", source: "import" });
    const sentAt = new Date("2026-02-01T10:00:00Z");
    const id = await seed(g, { dedupeKey: "sac2-a", sentAt, textContent: "only message" });

    // Cursor IS the only message — nothing should be returned
    const results = await selectAfterCursor(pool, g, { sentAt, messageId: id });
    expect(results).toHaveLength(0);
  });

  it("substitutes transcript for a completed voice note and excludes empty/system messages", async () => {
    const g = await upsertGroup(pool, { name: "SAC-3", source: "import" });
    const t0 = new Date("2026-03-01T09:00:00Z");
    const t1 = new Date("2026-03-01T10:00:00Z");
    const t2 = new Date("2026-03-01T11:00:00Z");
    const t3 = new Date("2026-03-01T12:00:00Z");
    const t4 = new Date("2026-03-01T13:00:00Z");

    // Cursor anchor message (before the range we test)
    const anchorId = await seed(g, { dedupeKey: "sac3-anchor", sentAt: t0, textContent: "anchor" });

    // After cursor: text message
    await seed(g, { dedupeKey: "sac3-text", sentAt: t1, textContent: "plain text" });

    // After cursor: voice note with completed transcript
    const voiceId = await seed(g, {
      dedupeKey: "sac3-voice",
      sentAt: t2,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-001.opus",
      mediaPath: "/tmp/PTT-001.opus",
      mediaStatus: "present",
    });
    await insertTranscript(pool, {
      messageId: voiceId,
      transcript: "transcript text",
      engine: "whisper",
      status: "completed",
    });

    // After cursor: system message (must be excluded)
    await seed(g, {
      dedupeKey: "sac3-sys",
      sentAt: t3,
      messageType: "system",
      senderName: null,
      textContent: "X added Y",
    });

    // After cursor: voice note without transcript (empty content, must be excluded)
    await seed(g, {
      dedupeKey: "sac3-novt",
      sentAt: t4,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-002.opus",
      mediaPath: "/tmp/PTT-002.opus",
      mediaStatus: "present",
    });

    const results = await selectAfterCursor(pool, g, { sentAt: t0, messageId: anchorId });
    expect(results.map((r) => r.content)).toEqual(["plain text", "transcript text"]);
  });

  it("each result carries messageId and sentAt cursor fields", async () => {
    const g = await upsertGroup(pool, { name: "SAC-4", source: "import" });
    const sentAt0 = new Date("2026-04-01T10:00:00Z");
    const sentAt1 = new Date("2026-04-01T11:00:00Z");

    const anchorId = await seed(g, {
      dedupeKey: "sac4-anchor",
      sentAt: sentAt0,
      textContent: "anchor",
    });
    const msgId = await seed(g, { dedupeKey: "sac4-msg", sentAt: sentAt1, textContent: "after" });

    const results = await selectAfterCursor(pool, g, { sentAt: sentAt0, messageId: anchorId });
    expect(results).toHaveLength(1);
    expect(results[0]!.messageId).toBe(msgId);
    expect(results[0]!.sentAt.getTime()).toBe(sentAt1.getTime());
  });

  it("returns [] when no messages exist after the cursor", async () => {
    const g = await upsertGroup(pool, { name: "SAC-5", source: "import" });
    const sentAt = new Date("2026-05-01T10:00:00Z");
    const id = await seed(g, { dedupeKey: "sac5-only", sentAt, textContent: "only" });

    const results = await selectAfterCursor(pool, g, { sentAt, messageId: id });
    expect(results).toHaveLength(0);
  });
});

describe("firstPendingVoiceNoteAfter", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seed(
    groupId: number,
    m: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date },
  ): Promise<number> {
    const senderName = m.senderName !== undefined ? m.senderName : "Dana";
    let participantId: number | null = null;
    if (senderName != null) {
      participantId = await upsertParticipant(pool, senderName);
    }
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName,
      messageType: "text",
      textContent: "hi",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId,
      ...m,
    };
    if (m.senderName === null) {
      row.participantId = null;
    } else {
      row.participantId = participantId;
    }
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key=$1`,
      [row.dedupeKey],
    );
    return Number(rows[0]!.id);
  }

  it("returns null when no pending voice notes exist after the cursor", async () => {
    const g = await upsertGroup(pool, { name: "FPV-1", source: "import" });
    const sentAt = new Date("2026-01-01T10:00:00Z");
    const anchorId = await seed(g, { dedupeKey: "fpv1-anchor", sentAt, textContent: "anchor" });

    // Text message after cursor — not a voice note
    await seed(g, {
      dedupeKey: "fpv1-text",
      sentAt: new Date("2026-01-01T11:00:00Z"),
      textContent: "just text",
    });

    const result = await firstPendingVoiceNoteAfter(pool, g, { sentAt, messageId: anchorId });
    expect(result).toBeNull();
  });

  it("returns the oldest pending voice note after the cursor (no transcript row)", async () => {
    const g = await upsertGroup(pool, { name: "FPV-2", source: "import" });
    const t0 = new Date("2026-02-01T10:00:00Z");
    const t1 = new Date("2026-02-01T11:00:00Z");
    const t2 = new Date("2026-02-01T12:00:00Z");

    const anchorId = await seed(g, { dedupeKey: "fpv2-anchor", sentAt: t0, textContent: "anchor" });

    // First pending voice note after cursor
    const v1Id = await seed(g, {
      dedupeKey: "fpv2-voice1",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-001.opus",
      mediaPath: "/tmp/PTT-001.opus",
      mediaStatus: "present",
    });

    // Second pending voice note (later) — should NOT be returned
    await seed(g, {
      dedupeKey: "fpv2-voice2",
      sentAt: t2,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-002.opus",
      mediaPath: "/tmp/PTT-002.opus",
      mediaStatus: "present",
    });

    const result = await firstPendingVoiceNoteAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(v1Id);
    expect(result!.sentAt.getTime()).toBe(t1.getTime());
  });

  it("ignores voice notes with a completed transcript (not pending)", async () => {
    const g = await upsertGroup(pool, { name: "FPV-3", source: "import" });
    const t0 = new Date("2026-03-01T10:00:00Z");
    const t1 = new Date("2026-03-01T11:00:00Z");
    const t2 = new Date("2026-03-01T12:00:00Z");

    const anchorId = await seed(g, { dedupeKey: "fpv3-anchor", sentAt: t0, textContent: "anchor" });

    // Completed voice note — must be excluded
    const completedId = await seed(g, {
      dedupeKey: "fpv3-done",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-done.opus",
      mediaPath: "/tmp/PTT-done.opus",
      mediaStatus: "present",
    });
    await insertTranscript(pool, {
      messageId: completedId,
      transcript: "done",
      engine: "whisper",
      status: "completed",
    });

    // Pending voice note later
    const pendingId = await seed(g, {
      dedupeKey: "fpv3-pending",
      sentAt: t2,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-pending.opus",
      mediaPath: "/tmp/PTT-pending.opus",
      mediaStatus: "present",
    });

    const result = await firstPendingVoiceNoteAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(pendingId);
  });

  it("treats a voice note with a failed transcript as pending (status <> 'completed')", async () => {
    const g = await upsertGroup(pool, { name: "FPV-4", source: "import" });
    const t0 = new Date("2026-04-01T10:00:00Z");
    const t1 = new Date("2026-04-01T11:00:00Z");

    const anchorId = await seed(g, { dedupeKey: "fpv4-anchor", sentAt: t0, textContent: "anchor" });

    // Voice note with failed transcript — still pending for our purposes
    const failedId = await seed(g, {
      dedupeKey: "fpv4-failed",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-failed.opus",
      mediaPath: "/tmp/PTT-failed.opus",
      mediaStatus: "present",
    });
    await insertTranscript(pool, {
      messageId: failedId,
      transcript: null,
      engine: "whisper",
      status: "failed",
    });

    const result = await firstPendingVoiceNoteAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(failedId);
  });

  it("returns null when the only voice note after the cursor has a completed transcript", async () => {
    const g = await upsertGroup(pool, { name: "FPV-5", source: "import" });
    const t0 = new Date("2026-05-01T10:00:00Z");
    const t1 = new Date("2026-05-01T11:00:00Z");

    const anchorId = await seed(g, { dedupeKey: "fpv5-anchor", sentAt: t0, textContent: "anchor" });

    const doneId = await seed(g, {
      dedupeKey: "fpv5-done",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-x.opus",
      mediaPath: "/tmp/PTT-x.opus",
      mediaStatus: "present",
    });
    await insertTranscript(pool, {
      messageId: doneId,
      transcript: "done",
      engine: "whisper",
      status: "completed",
    });

    const result = await firstPendingVoiceNoteAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T011 — selectMessages with media_analyses JOIN
// ---------------------------------------------------------------------------

describe("selectMessages with media_analyses", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seed(
    groupId: number,
    m: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date },
  ): Promise<number> {
    const senderName = m.senderName !== undefined ? m.senderName : "Dana";
    let participantId: number | null = null;
    if (senderName != null) {
      participantId = await upsertParticipant(pool, senderName);
    }
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName,
      messageType: "text",
      textContent: "hi",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId,
      ...m,
    };
    if (m.senderName === null) {
      row.participantId = null;
    } else {
      row.participantId = participantId;
    }
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key=$1`,
      [row.dedupeKey],
    );
    return Number(rows[0]!.id);
  }

  it("T011: captioned image — content is 'caption — description'", async () => {
    const g = await upsertGroup(pool, { name: "MA-1", source: "import" });
    const imgId = await seed(g, {
      dedupeKey: "ma1-img",
      sentAt: new Date("2026-06-01T10:00:00Z"),
      messageType: "media",
      textContent: "נוף יפה",
      mediaFilename: "photo.jpg",
      mediaPath: "/tmp/photo.jpg",
      mediaStatus: "present",
    });
    await insertMediaAnalysis(pool, {
      messageId: imgId,
      kind: "image",
      description: "נוף של הרים",
      engine: "llama3.2-vision",
      status: "completed",
    });

    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("נוף יפה — נוף של הרים");
  });

  it("T011: uncaptioned image with description — content is just description", async () => {
    const g = await upsertGroup(pool, { name: "MA-2", source: "import" });
    const imgId = await seed(g, {
      dedupeKey: "ma2-img",
      sentAt: new Date("2026-06-01T10:00:00Z"),
      messageType: "media",
      textContent: null,
      mediaFilename: "pic.jpg",
      mediaPath: "/tmp/pic.jpg",
      mediaStatus: "present",
    });
    await insertMediaAnalysis(pool, {
      messageId: imgId,
      kind: "image",
      description: "ילד משחק בחול",
      engine: "llama3.2-vision",
      status: "completed",
    });

    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("ילד משחק בחול");
  });

  it("T011: image with failed analysis — excluded from results (no content)", async () => {
    const g = await upsertGroup(pool, { name: "MA-3", source: "import" });
    const imgId = await seed(g, {
      dedupeKey: "ma3-img-failed",
      sentAt: new Date("2026-06-01T10:00:00Z"),
      messageType: "media",
      textContent: null,
      mediaFilename: "bad.jpg",
      mediaPath: "/tmp/bad.jpg",
      mediaStatus: "present",
    });
    await insertMediaAnalysis(pool, {
      messageId: imgId,
      kind: "image",
      description: null,
      engine: "llama3.2-vision",
      status: "failed",
      errorMessage: "model timeout",
    });

    const msgs = await selectMessages(pool, g, { last: 100 });
    // No content: no caption, analysis failed → excluded
    expect(msgs).toHaveLength(0);
  });

  it("T011: image with no analysis row — excluded from results", async () => {
    const g = await upsertGroup(pool, { name: "MA-4", source: "import" });
    await seed(g, {
      dedupeKey: "ma4-img-noanalysis",
      sentAt: new Date("2026-06-01T10:00:00Z"),
      messageType: "media",
      textContent: null,
      mediaFilename: "unanalyzed.jpg",
      mediaPath: "/tmp/unanalyzed.jpg",
      mediaStatus: "present",
    });

    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs).toHaveLength(0);
  });

  it("T011: text message content unchanged (no regression)", async () => {
    const g = await upsertGroup(pool, { name: "MA-5", source: "import" });
    await seed(g, {
      dedupeKey: "ma5-text",
      sentAt: new Date("2026-06-01T10:00:00Z"),
      textContent: "רק טקסט",
    });

    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("רק טקסט");
  });

  it("T011: voice note with completed transcript — content is transcript (no regression)", async () => {
    const g = await upsertGroup(pool, { name: "MA-6", source: "import" });
    const vnId = await seed(g, {
      dedupeKey: "ma6-vn",
      sentAt: new Date("2026-06-01T10:00:00Z"),
      messageType: "media",
      textContent: null,
      mediaFilename: "voice.opus",
      mediaPath: "/tmp/voice.opus",
      mediaStatus: "present",
    });
    await insertTranscript(pool, {
      messageId: vnId,
      transcript: "שמעתי קול",
      engine: "whisper",
      status: "completed",
    });

    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("שמעתי קול");
  });

  it("T011: all three parts present — content is 'caption — description — transcript'", async () => {
    const g = await upsertGroup(pool, { name: "MA-7", source: "import" });
    const msgId = await seed(g, {
      dedupeKey: "ma7-all",
      sentAt: new Date("2026-06-01T10:00:00Z"),
      messageType: "media",
      textContent: "כיתוב",
      mediaFilename: "video.jpg",
      mediaPath: "/tmp/video.jpg",
      mediaStatus: "present",
    });
    await insertMediaAnalysis(pool, {
      messageId: msgId,
      kind: "image",
      description: "תיאור חזותי",
      engine: "llama3.2-vision",
      status: "completed",
    });
    await insertTranscript(pool, {
      messageId: msgId,
      transcript: "תמליל",
      engine: "whisper",
      status: "completed",
    });

    const msgs = await selectMessages(pool, g, { last: 100 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("כיתוב — תיאור חזותי — תמליל");
  });
});

// ---------------------------------------------------------------------------
// T021 — firstPendingVisualMediaAfter
// ---------------------------------------------------------------------------

describe("firstPendingVisualMediaAfter", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seed(
    groupId: number,
    m: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date },
  ): Promise<number> {
    const senderName = m.senderName !== undefined ? m.senderName : "Dana";
    let participantId: number | null = null;
    if (senderName != null) {
      participantId = await upsertParticipant(pool, senderName);
    }
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName,
      messageType: "text",
      textContent: "hi",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId,
      ...m,
    };
    if (m.senderName === null) {
      row.participantId = null;
    } else {
      row.participantId = participantId;
    }
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key=$1`,
      [row.dedupeKey],
    );
    return Number(rows[0]!.id);
  }

  it("T021-1: present image with NO analysis row blocks — is returned as barrier", async () => {
    const g = await upsertGroup(pool, { name: "FPV-IMG-1", source: "import" });
    const t0 = new Date("2026-06-01T10:00:00Z");
    const t1 = new Date("2026-06-01T11:00:00Z");

    const anchorId = await seed(g, {
      dedupeKey: "fpvi1-anchor",
      sentAt: t0,
      textContent: "anchor",
    });
    const imgId = await seed(g, {
      dedupeKey: "fpvi1-img",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "photo.jpg",
      mediaPath: "/tmp/photo.jpg",
      mediaStatus: "present",
    });

    const result = await firstPendingVisualMediaAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(imgId);
    expect(result!.sentAt.getTime()).toBe(t1.getTime());
  });

  it("T021-2: present image with a completed analysis — not returned (not a barrier)", async () => {
    const g = await upsertGroup(pool, { name: "FPV-IMG-2", source: "import" });
    const t0 = new Date("2026-06-02T10:00:00Z");
    const t1 = new Date("2026-06-02T11:00:00Z");

    const anchorId = await seed(g, {
      dedupeKey: "fpvi2-anchor",
      sentAt: t0,
      textContent: "anchor",
    });
    const imgId = await seed(g, {
      dedupeKey: "fpvi2-img",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "done.jpg",
      mediaPath: "/tmp/done.jpg",
      mediaStatus: "present",
    });
    await insertMediaAnalysis(pool, {
      messageId: imgId,
      kind: "image",
      description: "a description",
      engine: "llama3.2-vision",
      status: "completed",
    });

    const result = await firstPendingVisualMediaAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).toBeNull();
  });

  it("T021-3: present image with a FAILED analysis — not returned (must not freeze)", async () => {
    const g = await upsertGroup(pool, { name: "FPV-IMG-3", source: "import" });
    const t0 = new Date("2026-06-03T10:00:00Z");
    const t1 = new Date("2026-06-03T11:00:00Z");

    const anchorId = await seed(g, {
      dedupeKey: "fpvi3-anchor",
      sentAt: t0,
      textContent: "anchor",
    });
    const imgId = await seed(g, {
      dedupeKey: "fpvi3-img",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "fail.jpg",
      mediaPath: "/tmp/fail.jpg",
      mediaStatus: "present",
    });
    await insertMediaAnalysis(pool, {
      messageId: imgId,
      kind: "image",
      description: null,
      engine: "llama3.2-vision",
      status: "failed",
      errorMessage: "model error",
    });

    // A failed analysis row exists → should NOT block catch-up (no freeze)
    const result = await firstPendingVisualMediaAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).toBeNull();
  });

  it("T021-4: missing (non-present) image — not returned (only present media blocks)", async () => {
    const g = await upsertGroup(pool, { name: "FPV-IMG-4", source: "import" });
    const t0 = new Date("2026-06-04T10:00:00Z");
    const t1 = new Date("2026-06-04T11:00:00Z");

    const anchorId = await seed(g, {
      dedupeKey: "fpvi4-anchor",
      sentAt: t0,
      textContent: "anchor",
    });
    await seed(g, {
      dedupeKey: "fpvi4-img",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "missing.jpg",
      mediaPath: null,
      mediaStatus: "missing",
    });

    const result = await firstPendingVisualMediaAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).toBeNull();
  });

  it("T021-5: sticker (STK-*.webp) — not returned (stickers are never analyzed, must not block)", async () => {
    const g = await upsertGroup(pool, { name: "FPV-IMG-5", source: "import" });
    const t0 = new Date("2026-06-05T10:00:00Z");
    const t1 = new Date("2026-06-05T11:00:00Z");

    const anchorId = await seed(g, {
      dedupeKey: "fpvi5-anchor",
      sentAt: t0,
      textContent: "anchor",
    });
    await seed(g, {
      dedupeKey: "fpvi5-sticker",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "STK-20240601-WA0001.webp",
      mediaPath: "/tmp/STK-20240601-WA0001.webp",
      mediaStatus: "present",
    });

    const result = await firstPendingVisualMediaAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).toBeNull();
  });

  it("T021-6: present video with no analysis blocks — is returned as barrier", async () => {
    const g = await upsertGroup(pool, { name: "FPV-IMG-6", source: "import" });
    const t0 = new Date("2026-06-06T10:00:00Z");
    const t1 = new Date("2026-06-06T11:00:00Z");

    const anchorId = await seed(g, {
      dedupeKey: "fpvi6-anchor",
      sentAt: t0,
      textContent: "anchor",
    });
    const videoId = await seed(g, {
      dedupeKey: "fpvi6-video",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "clip.mp4",
      mediaPath: "/tmp/clip.mp4",
      mediaStatus: "present",
    });

    const result = await firstPendingVisualMediaAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(videoId);
  });

  it("T021-7: respects the cursor — image at or before cursor is not returned", async () => {
    const g = await upsertGroup(pool, { name: "FPV-IMG-7", source: "import" });
    const t0 = new Date("2026-06-07T10:00:00Z");
    const t1 = new Date("2026-06-07T11:00:00Z");
    const t2 = new Date("2026-06-07T12:00:00Z");

    const anchorId = await seed(g, {
      dedupeKey: "fpvi7-anchor",
      sentAt: t0,
      textContent: "anchor",
    });
    // Image AT the cursor time/id — should not be returned (strictly after)
    const imgAtCursor = await seed(g, {
      dedupeKey: "fpvi7-at",
      sentAt: t1,
      messageType: "media",
      textContent: null,
      mediaFilename: "at-cursor.jpg",
      mediaPath: "/tmp/at-cursor.jpg",
      mediaStatus: "present",
    });
    // Image AFTER cursor — should be returned
    const imgAfter = await seed(g, {
      dedupeKey: "fpvi7-after",
      sentAt: t2,
      messageType: "media",
      textContent: null,
      mediaFilename: "after-cursor.jpg",
      mediaPath: "/tmp/after-cursor.jpg",
      mediaStatus: "present",
    });

    // Cursor at t1 / imgAtCursor — the image at cursor should NOT be included
    const result = await firstPendingVisualMediaAfter(pool, g, {
      sentAt: t1,
      messageId: imgAtCursor,
    });
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe(imgAfter);
  });

  it("T021-8: returns null when no pending visual media exists after cursor", async () => {
    const g = await upsertGroup(pool, { name: "FPV-IMG-8", source: "import" });
    const t0 = new Date("2026-06-08T10:00:00Z");
    const anchorId = await seed(g, {
      dedupeKey: "fpvi8-anchor",
      sentAt: t0,
      textContent: "anchor",
    });

    // Only text message after cursor
    await seed(g, {
      dedupeKey: "fpvi8-text",
      sentAt: new Date("2026-06-08T11:00:00Z"),
      textContent: "just text",
    });

    const result = await firstPendingVisualMediaAfter(pool, g, { sentAt: t0, messageId: anchorId });
    expect(result).toBeNull();
  });
});
