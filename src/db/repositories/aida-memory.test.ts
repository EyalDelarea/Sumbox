/**
 * aida-memory.test.ts — the write side of @Aida's memory.
 *
 * These tests exist to pin the SAFETY properties, not the CRUD. Each one maps to
 * a real failure the design is defending against, so a future change that
 * loosens the write path fails here loudly rather than quietly widening what she
 * can come to believe.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { listObservations, recordObservation, revokeObservation } from "./aida-memory.js";
import { upsertGroup } from "./groups.js";
import { insertMessages } from "./messages.js";
import { upsertParticipant } from "./participants.js";

function msg(
  groupId: number,
  participantId: number,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage & { participantId: number } {
  return {
    groupId,
    importId: null,
    source: "import",
    senderName: "x",
    messageType: "text",
    textContent: "hi",
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    sentAt: new Date("2026-05-01T10:00:00.000Z"),
    dedupeKey: `pk-${Math.random()}`,
    externalId: null,
    fromMe: null,
    participantId,
    ...overrides,
  };
}

/** Insert one message and return its id. */
async function seedMessage(pool: pg.Pool, groupId: number, participantId: number) {
  await insertMessages(pool, [msg(groupId, participantId)]);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM messages WHERE group_id=$1 AND participant_id=$2 ORDER BY id DESC LIMIT 1`,
    [groupId, participantId],
  );
  return Number(rows[0]!.id);
}

describe("aida memory (shadow write)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("derives speaker, group and timestamp from the cited message", async () => {
    const g = await upsertGroup(pool, { name: `m-${Math.random()}`, source: "import" });
    const royi = await upsertParticipant(pool, `Royi-${Math.random()}`);
    const mid = await seedMessage(pool, g, royi);

    expect(
      await recordObservation(pool, { groupId: g, sourceMessageId: mid, content: "X" }),
    ).toBeTypeOf("number");
    const [obs] = await listObservations(pool, g);
    // The caller never supplies the speaker, so it cannot misattribute a
    // statement to someone who did not say it.
    expect(obs?.speaker.startsWith("Royi-")).toBe(true);
    expect(obs?.observedAt.toISOString()).toBe("2026-05-01T10:00:00.000Z");
  });

  // The 2026-08-19 incident: she asserted a confrontation between two people
  // under a leading question, with zero messages supporting it. With a required
  // citation there is nothing to cite, so the claim cannot be stored at all.
  it("cannot store a memory with no citation", async () => {
    const g = await upsertGroup(pool, { name: `m2-${Math.random()}`, source: "import" });
    await expect(
      pool.query(
        `INSERT INTO aida_observations (group_id, speaker_participant_id, content, content_hash, observed_at)
         VALUES ($1, 1, 'invented', 'h', now())`,
        [g],
      ),
    ).rejects.toThrow(/source_message_id/);
  });

  // A hallucinated message id is the extractor's most likely failure, and the one
  // that would breach the per-group boundary if it were trusted.
  it("writes nothing when the cited message belongs to another group", async () => {
    const a = await upsertGroup(pool, { name: `ga-${Math.random()}`, source: "import" });
    const b = await upsertGroup(pool, { name: `gb-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `P-${Math.random()}`);
    const midInB = await seedMessage(pool, b, p);

    // Claim the memory belongs to group A while citing a message from group B.
    expect(
      await recordObservation(pool, { groupId: a, sourceMessageId: midInB, content: "leak" }),
    ).toBeNull();
    expect(await listObservations(pool, a)).toHaveLength(0);
  });

  it("is idempotent across re-extraction of the same window", async () => {
    const g = await upsertGroup(pool, { name: `m3-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `P3-${Math.random()}`);
    const mid = await seedMessage(pool, g, p);
    const first = await recordObservation(pool, {
      groupId: g,
      sourceMessageId: mid,
      content: "same",
    });
    // Whitespace-normalized, so a re-run that rephrases spacing still dedupes.
    const second = await recordObservation(pool, {
      groupId: g,
      sourceMessageId: mid,
      content: "  same  ",
    });
    expect(first).toBeTypeOf("number");
    expect(second).toBeNull();
    expect(await listObservations(pool, g)).toHaveLength(1);
  });

  it("revokes by tombstone, keeping the row and its citation", async () => {
    const g = await upsertGroup(pool, { name: `m4-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `P4-${Math.random()}`);
    const mid = await seedMessage(pool, g, p);
    const id = (await recordObservation(pool, { groupId: g, sourceMessageId: mid, content: "z" }))!;

    expect(await revokeObservation(pool, id, { groupId: g, byParticipantId: p })).toBe(true);
    expect(await listObservations(pool, g)).toHaveLength(0);
    // Still there, with who revoked it — a revocation is auditable.
    const { rows } = await pool.query(
      `SELECT revoked_at, revoked_by_participant_id FROM aida_observations WHERE id=$1`,
      [id],
    );
    expect(rows[0].revoked_at).not.toBeNull();
    expect(Number(rows[0].revoked_by_participant_id)).toBe(p);
    // Revoking twice is a no-op, so a repeated chat command can't rewrite history.
    expect(await revokeObservation(pool, id)).toBe(false);
  });

  it("will not revoke an observation belonging to another group", async () => {
    // Every other query in this module carries the group boundary; a revoke that
    // did not would be the one place an id from another chat could take effect.
    const a = await upsertGroup(pool, { name: `rv1-${Math.random()}`, source: "import" });
    const b = await upsertGroup(pool, { name: `rv2-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `P7-${Math.random()}`);
    const id = (await recordObservation(pool, {
      groupId: a,
      sourceMessageId: await seedMessage(pool, a, p),
      content: "in A",
    }))!;
    expect(await revokeObservation(pool, id, { groupId: b })).toBe(false);
    expect(await listObservations(pool, a)).toHaveLength(1);
    expect(await revokeObservation(pool, id, { groupId: a })).toBe(true);
  });

  it("keeps memory group-scoped on read", async () => {
    const a = await upsertGroup(pool, { name: `r1-${Math.random()}`, source: "import" });
    const b = await upsertGroup(pool, { name: `r2-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `P5-${Math.random()}`);
    await recordObservation(pool, {
      groupId: a,
      sourceMessageId: await seedMessage(pool, a, p),
      content: "belongs to A",
    });
    expect(await listObservations(pool, b)).toHaveLength(0);
  });

  it("rejects a directive verb outside the closed set", async () => {
    const g = await upsertGroup(pool, { name: `d-${Math.random()}`, source: "import" });
    const p = await upsertParticipant(pool, `P6-${Math.random()}`);
    const mid = await seedMessage(pool, g, p);
    // Privilege escalation has no representation in the schema, so a planted
    // instruction cannot become a durable directive however the extractor is fooled.
    await expect(
      pool.query(
        `INSERT INTO aida_directives (group_id, verb, value, source_message_id) VALUES ($1,'ignore_rules','all',$2)`,
        [g, mid],
      ),
    ).rejects.toThrow(/verb_closed_set/);
    await expect(
      pool.query(
        `INSERT INTO aida_directives (group_id, verb, value, source_message_id) VALUES ($1,'avoid_word','x',$2)`,
        [g, mid],
      ),
    ).resolves.toBeTruthy();
  });
});
