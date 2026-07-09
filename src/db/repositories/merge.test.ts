import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroupByWhatsappId } from "./groups.js";
import { mergeGroups } from "./merge.js";
import { upsertParticipant } from "./participants.js";

describe("mergeGroups", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function insertMsg(
    groupId: number,
    participantId: number,
    dedupeKey: string,
    externalId: string | null,
  ) {
    await pool.query(
      `INSERT INTO messages
         (group_id, participant_id, import_id, source, external_id, message_type,
          text_content, media_filename, media_path, media_status, sent_at, dedupe_key, from_me)
       VALUES ($1,$2,NULL,'live',$3,'text','hi',NULL,NULL,NULL,NOW(),$4,false)`,
      [groupId, participantId, externalId, dedupeKey],
    );
  }

  it("moves non-colliding messages, drops collisions, deletes dup, names survivor", async () => {
    const survivorJid = "972502028299-merge@s.whatsapp.net";
    const dupJid = "70390252580989-merge@lid";
    const survivorId = await upsertGroupByWhatsappId(pool, {
      whatsappId: survivorJid,
      name: survivorJid, // unnamed phone chat
      source: "live",
    });
    const dupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: dupJid,
      name: dupJid,
      source: "live",
    });
    await pool.query(`UPDATE groups SET name = 'Bar Hevr Merge' WHERE id = $1`, [dupId]);

    const p = await upsertParticipant(pool, "Merge Sender");

    // survivor has a1, a2
    await insertMsg(survivorId, p, "merge-a1", "EXT-A1");
    await insertMsg(survivorId, p, "merge-a2", "EXT-A2");
    // dup has a1 (collision by dedupe_key) and b1 (unique)
    await insertMsg(dupId, p, "merge-a1", "EXT-DUP-A1");
    await insertMsg(dupId, p, "merge-b1", "EXT-B1");

    const result = await mergeGroups(pool, { survivorId, dupId, name: "Bar Hevr Merge" });

    expect(result.movedMessages).toBe(1); // only b1 moved
    expect(result.deletedDuplicateMessages).toBe(1); // a1 collision dropped

    // survivor now has a1, a2, b1
    const { rows: survRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE group_id = $1`,
      [survivorId],
    );
    expect(survRows[0].n).toBe(3);

    // dup group is gone
    const { rows: dupRows } = await pool.query(`SELECT 1 FROM groups WHERE id = $1`, [dupId]);
    expect(dupRows.length).toBe(0);

    // survivor is named
    const { rows: nameRows } = await pool.query(`SELECT name FROM groups WHERE id = $1`, [
      survivorId,
    ]);
    expect(nameRows[0].name).toBe("Bar Hevr Merge");
  });

  it("rejects merging a group into itself", async () => {
    await expect(mergeGroups(pool, { survivorId: 1, dupId: 1, name: "x" })).rejects.toThrow();
  });
});
