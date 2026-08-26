import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { createMemory } from "./aida-memory.js";
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

  it("leaves no orphaned evidence when a merge discards the dup chat's memories", async () => {
    // The trap: step 1 MOVES the dup's messages with their ids preserved, so the
    // evidence ledger's cascade from `messages` never fires — while the group
    // delete cascades the memory rows away. Evidence has no FK to a memory (the
    // schema's one deliberate polymorphic reference), so nothing but this explicit
    // clear stops a dangling `memory_id` surviving an ordinary merge.
    const survivorId = await upsertGroupByWhatsappId(pool, {
      whatsappId: "972500000099-mem@s.whatsapp.net",
      name: "Mem Survivor",
      source: "live",
    });
    const dupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: "70390252580999-mem@lid",
      name: "Mem Dup",
      source: "live",
    });
    const p = await upsertParticipant(pool, "Mem Sender");
    // Unique key, so this message MOVES rather than being deleted — the case that
    // leaves the evidence row behind.
    await insertMsg(dupId, p, "mem-unique", "EXT-MEM-1");
    const { rows: msgRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE group_id = $1`,
      [dupId],
    );
    const messageId = Number(msgRows[0]?.id);
    // All four kinds, because the clear runs per-table and one of them passing
    // proves nothing about the other three.
    const drafts = [
      { memoryType: "episodic", content: "אירוע בצ'אט הכפול" },
      { memoryType: "semantic", content: "תכונה", subjectJid: "972500000081@s.whatsapp.net" },
      {
        memoryType: "relational",
        content: "יחס",
        subjectJids: ["972500000081@s.whatsapp.net", "972500000082@s.whatsapp.net"],
      },
      { memoryType: "self_state", content: "לענות בקצרה", facet: "behaviour" },
    ] as const;
    for (const draft of drafts) {
      const memory = await createMemory(pool, {
        ...draft,
        groupId: dupId,
        evidence: [{ messageId, stance: "supports" }],
      });
      expect(memory, `expected the ${draft.memoryType} memory to be written`).not.toBeNull();
    }

    const result = await mergeGroups(pool, { survivorId, dupId, name: "Mem Survivor" });

    expect(result.movedMessages, "the cited message moved, it was not deleted").toBe(1);
    expect(result.droppedMemories, "reported, so the loss is visible rather than silent").toBe(4);
    const { rows: orphans } = await pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM aida_memory_evidence`,
    );
    expect(Number(orphans[0]?.n), "no evidence row outlives the memory it belongs to").toBe(0);
  });

  it("rejects merging a group into itself", async () => {
    await expect(mergeGroups(pool, { survivorId: 1, dupId: 1, name: "x" })).rejects.toThrow();
  });
});
