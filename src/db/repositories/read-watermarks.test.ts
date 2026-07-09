import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import { insertMessages } from "./messages.js";
import { upsertParticipant } from "./participants.js";
import { getWatermark, upsertWatermark } from "./read-watermarks.js";

describe("read-watermarks repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  /** Insert a single message and return its id. */
  async function seedMessage(groupId: number, dedupeKey: string, sentAt: Date): Promise<number> {
    const participantId = await upsertParticipant(pool, "WM-Sender");
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: "WM-Sender",
      messageType: "text",
      textContent: "hello",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      sentAt,
      dedupeKey,
      participantId,
    };
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    return Number(rows[0]!.id);
  }

  it("getWatermark returns null for a group with no row", async () => {
    const groupId = await upsertGroup(pool, { name: "WM-absent", source: "import" });
    const result = await getWatermark(pool, groupId);
    expect(result).toBeNull();
  });

  it("upsertWatermark then getWatermark round-trips the cursor (preserves sentAt)", async () => {
    const groupId = await upsertGroup(pool, { name: "WM-roundtrip", source: "import" });
    const sentAt = new Date("2026-01-15T10:30:00.000Z");
    const messageId = await seedMessage(groupId, "wm-rt-001", sentAt);

    await upsertWatermark(pool, groupId, { sentAt, messageId });

    const wm = await getWatermark(pool, groupId);
    expect(wm).not.toBeNull();
    expect(wm!.groupId).toBe(groupId);
    expect(wm!.cursor.sentAt.getTime()).toBe(sentAt.getTime());
    expect(wm!.cursor.messageId).toBe(messageId);
    expect(wm!.updatedAt instanceof Date).toBe(true);
  });

  it("second upsert with a greater sentAt advances the watermark", async () => {
    const groupId = await upsertGroup(pool, { name: "WM-advance-sent", source: "import" });
    const sentAt1 = new Date("2026-02-01T10:00:00.000Z");
    const sentAt2 = new Date("2026-02-02T10:00:00.000Z");
    const msgId1 = await seedMessage(groupId, "wm-adv1-001", sentAt1);
    const msgId2 = await seedMessage(groupId, "wm-adv1-002", sentAt2);

    await upsertWatermark(pool, groupId, { sentAt: sentAt1, messageId: msgId1 });
    await upsertWatermark(pool, groupId, { sentAt: sentAt2, messageId: msgId2 });

    const wm = await getWatermark(pool, groupId);
    expect(wm!.cursor.sentAt.getTime()).toBe(sentAt2.getTime());
    expect(wm!.cursor.messageId).toBe(msgId2);
  });

  it("second upsert with a greater messageId (same sentAt) advances the watermark", async () => {
    const groupId = await upsertGroup(pool, { name: "WM-advance-id", source: "import" });
    const sentAt = new Date("2026-03-01T10:00:00.000Z");
    // Insert two messages with the same sentAt — DB assigns sequential ids
    const msgId1 = await seedMessage(groupId, "wm-adv2-001", sentAt);
    const msgId2 = await seedMessage(groupId, "wm-adv2-002", sentAt);

    // msgId2 > msgId1 (auto-increment)
    await upsertWatermark(pool, groupId, { sentAt, messageId: msgId1 });
    await upsertWatermark(pool, groupId, { sentAt, messageId: msgId2 });

    const wm = await getWatermark(pool, groupId);
    expect(wm!.cursor.messageId).toBe(msgId2);
  });

  it("upsert with an equal cursor does not move the watermark backward (idempotent)", async () => {
    const groupId = await upsertGroup(pool, { name: "WM-equal", source: "import" });
    const sentAt = new Date("2026-04-01T10:00:00.000Z");
    const msgId = await seedMessage(groupId, "wm-eq-001", sentAt);

    await upsertWatermark(pool, groupId, { sentAt, messageId: msgId });
    const wm1 = await getWatermark(pool, groupId);

    // Second upsert with same cursor — must not change anything
    await upsertWatermark(pool, groupId, { sentAt, messageId: msgId });
    const wm2 = await getWatermark(pool, groupId);

    expect(wm2!.cursor.sentAt.getTime()).toBe(wm1!.cursor.sentAt.getTime());
    expect(wm2!.cursor.messageId).toBe(wm1!.cursor.messageId);
  });

  it("upsert with a lesser cursor does not move the watermark backward (monotonic guard)", async () => {
    const groupId = await upsertGroup(pool, { name: "WM-monotonic", source: "import" });
    const sentAt1 = new Date("2026-05-01T10:00:00.000Z");
    const sentAt2 = new Date("2026-05-02T10:00:00.000Z");
    const msgId1 = await seedMessage(groupId, "wm-mono-001", sentAt1);
    const msgId2 = await seedMessage(groupId, "wm-mono-002", sentAt2);

    // Set watermark to the later position first
    await upsertWatermark(pool, groupId, { sentAt: sentAt2, messageId: msgId2 });

    // Attempt to move it backward — must be a no-op
    await upsertWatermark(pool, groupId, { sentAt: sentAt1, messageId: msgId1 });

    const wm = await getWatermark(pool, groupId);
    expect(wm!.cursor.sentAt.getTime()).toBe(sentAt2.getTime());
    expect(wm!.cursor.messageId).toBe(msgId2);
  });

  it("ON DELETE CASCADE: deleting the watermark's message removes the watermark row", async () => {
    const groupId = await upsertGroup(pool, { name: "WM-cascade", source: "import" });
    const sentAt = new Date("2026-06-01T10:00:00.000Z");
    const msgId = await seedMessage(groupId, "wm-casc-001", sentAt);

    await upsertWatermark(pool, groupId, { sentAt, messageId: msgId });

    // Confirm row exists
    expect(await getWatermark(pool, groupId)).not.toBeNull();

    // Deleting the referenced message cascades to read_watermarks
    // (watermark_message_id FK ON DELETE CASCADE). Note: deleting the GROUP
    // directly is blocked by messages_group_id_fkey (messages.group_id is
    // RESTRICT) while messages exist, so the message cascade is the reachable
    // cleanup path; the group_id cascade is belt-and-suspenders.
    await pool.query(`DELETE FROM messages WHERE id = $1`, [msgId]);

    // Watermark row must be gone (CASCADE)
    const { rows } = await pool.query(`SELECT 1 FROM read_watermarks WHERE group_id = $1`, [
      groupId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
