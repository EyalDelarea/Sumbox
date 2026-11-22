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
    const survivorJid = "972500000042-merge@s.whatsapp.net";
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

  it("carries Rosey's tasks, their events, and her sent ledger onto the survivor", async () => {
    const survivorId = await upsertGroupByWhatsappId(pool, {
      whatsappId: "972500000043-rosey@s.whatsapp.net",
      name: "972500000043-rosey@s.whatsapp.net",
      source: "live",
    });
    const dupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: "70390252580990-rosey@lid",
      name: "70390252580990-rosey@lid",
      source: "live",
    });
    const p = await upsertParticipant(pool, "Rosey Merge Sender");
    const id = async (groupId: number, key: string, ext: string) => {
      await insertMsg(groupId, p, key, ext);
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM messages WHERE group_id = $1 AND dedupe_key = $2`,
        [groupId, key],
      );
      return Number(rows[0]!.id);
    };
    const survA = await id(survivorId, "rm-a", "R-EXT-A");
    const survB = await id(survivorId, "rm-b", "R-EXT-B");
    const dupA = await id(dupId, "rm-a", "R-EXT-DUP-A"); // collides with survA
    const dupB = await id(dupId, "rm-b", "R-EXT-DUP-B"); // collides with survB
    const dupC = await id(dupId, "rm-c", "R-EXT-C"); // unique: moves

    const task = async (groupId: number, msg: number, status: string, source: string) => {
      const origin = status === "suggested" ? "suggested" : "tag";
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO rosey_tasks (group_id, title, title_key, origin, status, status_source,
                                  source_message_id, source_item_index, raised_at)
         VALUES ($1, 't', 't', $5, $3, $4, $2, 0, now()) RETURNING id`,
        [groupId, msg, status, source, origin],
      );
      return Number(rows[0]!.id);
    };
    // A task closed by hand on a colliding dup message, with no survivor twin.
    const closedByHand = await task(dupId, dupA, "done", "manual");
    await pool.query(
      `INSERT INTO rosey_task_events (task_id, status, source, applied, source_message_id)
       VALUES ($1, 'done', 'tag', true, $2)`,
      [closedByHand, dupB],
    );
    // A twin: both sides hold a task for message B; the dup's was closed by hand.
    const survTwin = await task(survivorId, survB, "open", "tag");
    await task(dupId, dupB, "dropped", "manual");
    // A task on a message that simply moves.
    const moving = await task(dupId, dupC, "open", "tag");
    await pool.query(
      `INSERT INTO rosey_messages (group_id, external_id, kind, task_id) VALUES ($1, 'R-SENT-1', 'reply', $2)`,
      [dupId, moving],
    );

    await mergeGroups(pool, { survivorId, dupId, name: "Rosey Merge Survivor" });

    const { rows: tasks } = await pool.query(
      `SELECT id::int, group_id::int, source_message_id::int, status, status_source
         FROM rosey_tasks WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[closedByHand, survTwin, moving]],
    );
    expect(tasks).toEqual([
      {
        id: closedByHand,
        group_id: survivorId,
        source_message_id: survA,
        status: "done",
        status_source: "manual",
      },
      // The survivor's twin keeps its row but inherits the hand-closed status.
      {
        id: survTwin,
        group_id: survivorId,
        source_message_id: survB,
        status: "dropped",
        status_source: "manual",
      },
      {
        id: moving,
        group_id: survivorId,
        source_message_id: dupC,
        status: "open",
        status_source: "tag",
      },
    ]);
    // Evidence is repointed, not nulled.
    const { rows: ev } = await pool.query(
      `SELECT source_message_id::int AS m FROM rosey_task_events WHERE task_id = $1 AND source = 'tag'`,
      [closedByHand],
    );
    expect(ev).toEqual([{ m: survB }]);
    // Her sent ledger follows the chat, so the own-post guard still holds.
    const { rows: sent } = await pool.query(
      `SELECT group_id::int, task_id::int FROM rosey_messages WHERE external_id = 'R-SENT-1'`,
    );
    expect(sent).toEqual([{ group_id: survivorId, task_id: moving }]);
  });

  it("rejects merging a group into itself", async () => {
    await expect(mergeGroups(pool, { survivorId: 1, dupId: 1, name: "x" })).rejects.toThrow();
  });
});
