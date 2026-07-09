/**
 * Integration tests for name-resolver.ts (test-first, TDD).
 *
 * Uses Testcontainers PostgreSQL.
 * Scenarios:
 * - A quiet @g.us group (no new message) gets named from groupSubject.
 * - A @lid group with stored messages gets named from the representative pushName.
 * - A @g.us group whose groupSubject throws stays the JID.
 * - An already-resolved group (name != jid) is skipped.
 * - A subject that collides with an existing UNIQUE name is caught and skipped (others still resolve).
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroupByWhatsappId } from "../db/repositories/groups.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import { createTestDatabase } from "../test/db.js";
import {
  isUsableName,
  pickContactName,
  resolveAllGroupNames,
  resolveChatNames,
  resolveContactNames,
} from "./name-resolver.js";

describe("isUsableName / pickContactName", () => {
  it("rejects empty, JID-like, and bare-phone-number names", () => {
    expect(isUsableName("")).toBe(false);
    expect(isUsableName("  ")).toBe(false);
    expect(isUsableName("972502028299@s.whatsapp.net")).toBe(false);
    expect(isUsableName("+972 50 202 8299")).toBe(false);
    expect(isUsableName("0525551234")).toBe(false);
  });

  it("accepts real human names", () => {
    expect(isUsableName("Dana Cohen")).toBe(true);
    expect(isUsableName("משפחת דלריאה")).toBe(true);
  });

  it("prefers saved name, then verifiedName, then notify — skipping unusable ones", () => {
    expect(pickContactName({ name: "Saved Name", notify: "Push Name" })).toBe("Saved Name");
    expect(pickContactName({ name: "+97250", notify: "Push Name" })).toBe("Push Name");
    expect(pickContactName({ verifiedName: "Acme Ltd", notify: "x" })).toBe("Acme Ltd");
    expect(pickContactName({ name: "12345", notify: "67890" })).toBeNull();
  });
});

describe("resolveAllGroupNames", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("resolves a quiet @g.us group name from groupSubject (no new message required)", async () => {
    // Seed: a @g.us group with name == whatsapp_id (unresolved, quiet — no messages ever arrived)
    const jid = "nr-quiet-group@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const groupSubject = async (j: string) => {
      if (j === jid) return "Quiet Group Subject";
      throw new Error(`unexpected jid: ${j}`);
    };

    const result = await resolveAllGroupNames(pool, { groupSubject });
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0]?.name).toBe("Quiet Group Subject");
  });

  it("resolves a @lid group name from the most-recent stored participant display_name", async () => {
    // Seed: a @lid group (no groupSubject call expected) with a stored message
    const jid = "70390252580989@lid";
    const groupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: jid,
      name: jid,
      source: "live",
    });

    // Insert a participant and a message referencing it
    const participantId = await upsertParticipant(pool, "Lid Person");
    await pool.query(
      `INSERT INTO messages (group_id, participant_id, import_id, source, external_id, message_type, text_content, media_filename, media_path, media_status, sent_at, dedupe_key, from_me)
       VALUES ($1, $2, NULL, 'live', 'lid-msg-001', 'text', 'hi from lid', NULL, NULL, NULL, NOW(), 'lid-dedupe-001', false)`,
      [groupId, participantId],
    );

    // groupSubject should NOT be called for @lid groups
    let groupSubjectCalled = false;
    const groupSubject = async (_j: string) => {
      groupSubjectCalled = true;
      throw new Error("should not be called for @lid");
    };

    const result = await resolveAllGroupNames(pool, { groupSubject });
    expect(groupSubjectCalled).toBe(false);
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0]?.name).toBe("Lid Person");
  });

  it("leaves @g.us group name as raw JID when groupSubject throws", async () => {
    const jid = "nr-failing-group@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const groupSubject = async (_j: string) => {
      throw new Error("groupSubject boom");
    };

    // Should not throw — failure is non-fatal
    const result = await resolveAllGroupNames(pool, { groupSubject });
    // resolved count may be 0 or refer to other groups; just confirm no throw

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0]?.name).toBe(jid); // still the raw JID
  });

  it("skips an already-resolved group (name != jid)", async () => {
    const jid = "nr-already-resolved@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });
    // Manually resolve the name before calling
    await pool.query(`UPDATE groups SET name = 'Already Resolved' WHERE whatsapp_id = $1`, [jid]);

    let groupSubjectCalled = false;
    const groupSubject = async (_j: string) => {
      groupSubjectCalled = true;
      return "Should Not Be Used";
    };

    await resolveAllGroupNames(pool, { groupSubject });
    // groupSubject might be called for other groups, but this group's name must NOT change
    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0]?.name).toBe("Already Resolved");
  });

  it("does NOT throw and still resolves other groups when one subject collides with a UNIQUE name", async () => {
    // Seed: group A is unresolved; group B is already named "Collision Name" (will cause UNIQUE violation for A)
    const jidA = "nr-collision-a@g.us";
    const jidB = "nr-collision-b@g.us";

    await upsertGroupByWhatsappId(pool, { whatsappId: jidA, name: jidA, source: "live" });
    // jidB already has the name we'll try to give jidA
    await pool.query(
      `INSERT INTO groups (whatsapp_id, name, source) VALUES ($1, $2, 'live') ON CONFLICT (tenant_id, name) DO NOTHING`,
      [jidB, "Collision Name"],
    );

    // Seed a third unrelated group that should succeed
    const jidC = "nr-collision-c@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jidC, name: jidC, source: "live" });

    const groupSubject = async (j: string) => {
      if (j === jidA) return "Collision Name"; // will collide with jidB's name
      if (j === jidC) return "Clean Group Name"; // should succeed
      throw new Error(`unexpected: ${j}`);
    };

    // Should not throw
    const result = await resolveAllGroupNames(pool, { groupSubject });
    expect(result.resolved).toBeGreaterThanOrEqual(1); // at least jidC should succeed

    // jidA should stay as its JID (collision skipped)
    const { rows: rowsA } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [
      jidA,
    ]);
    expect(rowsA[0]?.name).toBe(jidA);

    // jidC should be resolved
    const { rows: rowsC } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [
      jidC,
    ]);
    expect(rowsC[0]?.name).toBe("Clean Group Name");
  });

  it("resolveContactNames names a 1:1 chat from a saved contact name", async () => {
    const jid = "972502028299@s.whatsapp.net";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const result = await resolveContactNames(pool, [{ id: jid, name: "Dana Cohen", notify: "dc" }]);
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0]?.name).toBe("Dana Cohen");
  });

  it("resolveContactNames matches by phoneNumber when the chat is keyed by the PN JID", async () => {
    const pnJid = "972500000001@s.whatsapp.net";
    await upsertGroupByWhatsappId(pool, { whatsappId: pnJid, name: pnJid, source: "live" });

    // Contact keyed by @lid, but exposes the PN jid via phoneNumber.
    const result = await resolveContactNames(pool, [
      { id: "111@lid", phoneNumber: pnJid, notify: "Yossi" },
    ]);
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [pnJid]);
    expect(rows[0]?.name).toBe("Yossi");
  });

  it("resolveContactNames does NOT overwrite an already-resolved name", async () => {
    const jid = "972511111111@s.whatsapp.net";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: "Already Named", source: "live" });

    await resolveContactNames(pool, [{ id: jid, name: "New Name" }]);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0]?.name).toBe("Already Named");
  });

  it("resolveChatNames names a group we can't fetch a subject for (from history chats)", async () => {
    const jid = "120363400000000001@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const result = await resolveChatNames(pool, [
      { id: jid, name: "Forbidden Group From History" },
    ]);
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0]?.name).toBe("Forbidden Group From History");
  });

  it("resolveContactNames bridges an @lid contact name to its @s.whatsapp.net chat", async () => {
    const lid = "177223302647848-bridge@lid";
    const pn = "972549288606-bridge@s.whatsapp.net";
    await upsertGroupByWhatsappId(pool, { whatsappId: pn, name: pn, source: "live" });

    const result = await resolveContactNames(pool, [{ id: lid, notify: "מסי" }], {
      pnForLid: async (l) => (l === lid ? pn : null),
    });
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [pn]);
    expect(rows[0]?.name).toBe("מסי");
  });
});
