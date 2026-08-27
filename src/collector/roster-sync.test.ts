import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { recordLink, siblingForJid } from "../db/repositories/identity-links.js";
import { createTestDatabase } from "../test/db.js";
import { groupsNeedingRoster, type RosterBridge, syncGroupRosters } from "./roster-sync.js";

const noSleep = async () => {};

describe("syncGroupRosters", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  /** A group chat with one message from `lid`, which is what makes it need a roster. */
  async function groupWith(lid: string, waJid = `${randomUUID().slice(0, 12)}@g.us`) {
    const id = await upsertGroup(pool, { name: `r-${randomUUID().slice(0, 8)}`, source: "live" });
    await pool.query(`UPDATE groups SET whatsapp_id = $2 WHERE id = $1`, [id, waJid]);
    await pool.query(
      `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key, sender_jid)
       VALUES ($1,'live','text','hi', now(), $2, $3)`,
      [id, `dk-${randomUUID()}`, lid],
    );
    return { id, waJid };
  }

  /**
   * A roster for ONE group. Every other group answers empty, because earlier
   * tests leave their own unlinked lids behind and a run visits every group that
   * still needs one — a bridge that answered the same members for all of them
   * would count this test's participants once per leftover.
   */
  const roster = (
    waJid: string,
    members: { id: string; phoneNumber?: string }[],
  ): RosterBridge => ({
    groupParticipants: async (jid) => (jid === waJid ? members : []),
  });

  it("links a member the bridge had never seen", async () => {
    const lid = `${randomUUID().slice(0, 10)}@lid`;
    const pn = `9725${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
    const g = await groupWith(lid);

    const stats = await syncGroupRosters(pool, roster(g.waJid, [{ id: lid, phoneNumber: pn }]), {
      limit: 50,
      sleep: noSleep,
    });

    expect(stats.linked).toBe(1);
    expect(await siblingForJid(pool, lid)).toBe(pn);
  });

  it("does nothing the second time, and stops visiting the group at all", async () => {
    const lid = `${randomUUID().slice(0, 10)}@lid`;
    const pn = `9725${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
    const g = await groupWith(lid);
    const bridge = roster(g.waJid, [{ id: lid, phoneNumber: pn }]);

    const first = await syncGroupRosters(pool, bridge, { limit: 50, sleep: noSleep });
    const second = await syncGroupRosters(pool, bridge, { limit: 50, sleep: noSleep });

    expect(first.linked).toBe(1);
    // Not "already: 1" — the group no longer HOLDS an unlinked lid, so it is not
    // visited at all. That is what makes this safe to run on every connect.
    expect(second.linked).toBe(0);
    expect(
      await groupsNeedingRoster(pool, 100).then((gs) => gs.map((x) => x.id)),
      "and it is gone from the work list",
    ).not.toContain(g.id);
  });

  it("never rewrites a link, and counts which side collided", async () => {
    // The mis-attribution this design calls unrecoverable: moving a link moves
    // every belief filed against that identity.
    const lidA = `${randomUUID().slice(0, 10)}@lid`;
    const lidB = `${randomUUID().slice(0, 10)}@lid`;
    const pnA = `9725${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
    const pnB = `9725${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
    await recordLink(pool, { lidJid: lidA, pnJid: pnA, source: "message_alt" });
    const g = await groupWith(lidB);

    // The roster claims lidA now belongs to pnB, and pnA now belongs to lidB.
    const stats = await syncGroupRosters(
      pool,
      roster(g.waJid, [
        { id: lidA, phoneNumber: pnB },
        { id: lidB, phoneNumber: pnA },
      ]),
      { limit: 50, sleep: noSleep },
    );

    expect(stats.lidTaken).toBe(1);
    expect(stats.pnTaken).toBe(1);
    expect(stats.linked).toBe(0);
    expect(await siblingForJid(pool, lidA), "the existing link is untouched").toBe(pnA);
  });

  it("counts a participant that is not an @lid, and one with no phone", async () => {
    const lid = `${randomUUID().slice(0, 10)}@lid`;
    const g = await groupWith(lid);

    const stats = await syncGroupRosters(
      pool,
      roster(g.waJid, [
        // If an id can ever be the phone form, writing it to lid_jid would slip
        // past both unique indexes.
        { id: "972500000042@s.whatsapp.net", phoneNumber: "972500000042@s.whatsapp.net" },
        { id: lid },
      ]),
      { limit: 50, sleep: noSleep },
    );

    expect(stats.notLid).toBe(1);
    expect(stats.noPhone).toBe(1);
    expect(stats.linked).toBe(0);
  });

  it("keeps going when one group's roster cannot be read", async () => {
    const lidBad = `${randomUUID().slice(0, 10)}@lid`;
    const lidGood = `${randomUUID().slice(0, 10)}@lid`;
    const pn = `9725${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
    const bad = await groupWith(lidBad);
    const good = await groupWith(lidGood);

    const stats = await syncGroupRosters(
      pool,
      {
        groupParticipants: async (waJid) =>
          waJid === bad.waJid || waJid !== good.waJid ? [] : [{ id: lidGood, phoneNumber: pn }],
      },
      { limit: 50, sleep: noSleep },
    );

    // At least one: earlier tests leave their own unlinked groups behind, and
    // this bridge answers empty for those too. What matters is that a failure
    // does not end the run.
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    expect(stats.linked, "the reachable group is still bridged").toBe(1);
  });

  it("ignores 1:1 chats and already-bridged senders when choosing groups", async () => {
    const linkedLid = `${randomUUID().slice(0, 10)}@lid`;
    const pn = `9725${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
    await recordLink(pool, { lidJid: linkedLid, pnJid: pn, source: "bridge" });
    const bridged = await groupWith(linkedLid);
    const dm = await groupWith(`${randomUUID().slice(0, 10)}@lid`, `9725550000@s.whatsapp.net`);

    const chosen = await groupsNeedingRoster(pool, 100);
    const ids = chosen.map((g) => g.id);

    expect(ids, "every lid already bridged").not.toContain(bridged.id);
    expect(ids, "not a group chat").not.toContain(dm.id);
  });
});
