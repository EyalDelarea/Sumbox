import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrationsUp } from "../../db/migrate.js";
import { insertTask, recordRoseyPoll } from "../../db/repositories/rosey-tasks.js";
import { createTestDatabase } from "../../test/db.js";
import {
  assertScratchName,
  cloneGroup,
  createScratch,
  dropScratch,
  readOnlyPool,
  type ScratchTarget,
  scratchTarget,
  wipeScratch,
} from "./clone.js";

// ── Guards (no database) ──────────────────────────────────────────────────────

describe("the scratch database's name", () => {
  it("is the live name plus _rosey_sandbox, on the same server", () => {
    const t = scratchTarget("postgres://u:p@localhost:5432/whatsapp_sum");
    expect(t.name).toBe("whatsapp_sum_rosey_sandbox");
    expect(t.url).toBe("postgres://u:p@localhost:5432/whatsapp_sum_rosey_sandbox");
    expect(t.adminUrl).toBe("postgres://u:p@localhost:5432/postgres");
  });

  it("refuses the live database, or any name without the suffix", () => {
    expect(() => assertScratchName("whatsapp_sum", "whatsapp_sum")).toThrow(/refusing/);
    expect(() => assertScratchName("x_rosey_sandbox", "x_rosey_sandbox")).toThrow(/refusing/);
    expect(() => assertScratchName("postgres", "whatsapp_sum")).toThrow(/refusing/);
    expect(() => assertScratchName('a_rosey_sandbox"; DROP', "x")).toThrow(/refusing/);
    expect(() => assertScratchName("whatsapp_sum_rosey_sandbox", "whatsapp_sum")).not.toThrow();
  });
});

// ── The copy (synthetic data on a test server) ────────────────────────────────

let liveUrl: string;
let live: pg.Pool;
let ro: pg.Pool;
let target: ScratchTarget;
let scratch: pg.Pool;

beforeAll(async () => {
  liveUrl = await createTestDatabase();
  live = new pg.Pool({ connectionString: liveUrl });
  ro = readOnlyPool(liveUrl);
  target = scratchTarget(liveUrl);
  await createScratch(target);
  await runMigrationsUp(target.url);
  scratch = new pg.Pool({ connectionString: target.url });
}, 180_000);

afterAll(async () => {
  await scratch?.end();
  await ro?.end();
  await live?.end();
  if (target) await dropScratch(target);
}, 60_000);

async function seedGroup(name: string) {
  const { rows: g } = await live.query<{ id: string }>(
    `INSERT INTO groups (name, source, whatsapp_id) VALUES ($1, 'live', $2) RETURNING id`,
    [`${name}-${randomUUID()}`, `${randomUUID().slice(0, 12)}@g.us`],
  );
  const groupId = Number(g[0]!.id);
  const { rows: p } = await live.query<{ id: string }>(
    `INSERT INTO participants (display_name) VALUES ($1) RETURNING id`,
    [`דנה-${randomUUID()}`],
  );
  const participantId = Number(p[0]!.id);
  const jid = `${randomUUID().slice(0, 10)}@lid`;
  await live.query(
    `INSERT INTO identity_links (lid_jid, pn_jid, source) VALUES ($1, $2, 'message_alt')`,
    [jid, `${randomUUID().slice(0, 10)}@s.whatsapp.net`],
  );
  const { rows: m } = await live.query<{ id: string }>(
    `INSERT INTO messages (group_id, participant_id, source, message_type, text_content, sent_at,
                           dedupe_key, external_id, sender_jid)
     VALUES ($1, $2, 'live', 'text', 'לקנות חלב', now(), $3, $4, $5),
            ($1, $2, 'live', 'media', NULL, now(), $6, $7, $5)
     RETURNING id`,
    [
      groupId,
      participantId,
      `dk-${randomUUID()}`,
      `E-${randomUUID()}`,
      jid,
      `dk-${randomUUID()}`,
      `E-${randomUUID()}`,
    ],
  );
  const [textId, voiceId] = m.map((r) => Number(r.id));
  await live.query(
    `INSERT INTO transcripts (message_id, transcript, status, engine) VALUES ($1, 'לתקן ברז', 'completed', 'test')`,
    [voiceId],
  );
  const taskId = (await insertTask(live, {
    groupId,
    title: "לקנות חלב",
    titleKey: "לקנות חלב",
    origin: "tag",
    kind: "grocery",
    raisedByParticipantId: participantId,
    sourceMessageId: textId!,
    sourceItemIndex: 0,
    raisedAt: new Date(),
  }))!;
  await recordRoseyPoll(live, {
    groupId,
    externalId: `P-${randomUUID()}`,
    secret: new Uint8Array(32).fill(9),
    taskIds: [taskId],
  });
  return { groupId, taskId, textId: textId! };
}

describe("cloneGroup", () => {
  it("reads live through a pool Postgres keeps read-only", async () => {
    await expect(
      ro.query(`INSERT INTO groups (name, source) VALUES ('x', 'live')`),
    ).rejects.toThrow(/read-only transaction/);
  });

  it("copies one group's rows with their ids, and nothing of any other group", async () => {
    const a = await seedGroup("a");
    await seedGroup("b"); // must not travel
    const liveCounts = await live.query(`SELECT count(*)::int AS n FROM messages`);

    const report = await cloneGroup(ro, scratch, a.groupId, target.liveName);
    expect(report).toMatchObject({
      groups: 1,
      participants: 1,
      identity_links: 1,
      messages: 2,
      transcripts: 1,
      rosey_tasks: 1,
      rosey_task_events: 1,
      rosey_messages: 2, // the poll and its one option
    });
    const ids = await scratch.query(`SELECT DISTINCT group_id FROM messages`);
    expect(ids.rows.map((r) => Number(r.group_id))).toEqual([a.groupId]);
    const t = await scratch.query(`SELECT id, status, kind FROM rosey_tasks`);
    expect(t.rows).toEqual([{ id: String(a.taskId), status: "open", kind: "grocery" }]);
    const secret = await scratch.query(
      `SELECT message_secret FROM rosey_messages WHERE message_secret IS NOT NULL`,
    );
    expect(new Uint8Array(secret.rows[0]!.message_secret)).toEqual(new Uint8Array(32).fill(9));
    // Rosey is on for it in the scratch copy, through her real enable path.
    const on = await scratch.query(
      `SELECT enabled FROM group_command_permissions WHERE group_id = $1 AND command = 'rosey'`,
      [a.groupId],
    );
    expect(on.rows).toEqual([{ enabled: true }]);
    // Sequences moved past the copied ids: a new row does not collide.
    const fresh = await scratch.query<{ id: string }>(
      `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key)
       VALUES ($1, 'live', 'text', 'x', now(), 'dk-new') RETURNING id`,
      [a.groupId],
    );
    expect(Number(fresh.rows[0]!.id)).toBeGreaterThan(a.textId);
    // Live is untouched.
    expect((await live.query(`SELECT count(*)::int AS n FROM messages`)).rows).toEqual(
      liveCounts.rows,
    );
  });

  it("re-clones after a wipe, back to exactly the live rows", async () => {
    const c = await seedGroup("c");
    await wipeScratch(scratch, target.liveName);
    await cloneGroup(ro, scratch, c.groupId, target.liveName);
    await scratch.query(`UPDATE rosey_tasks SET status = 'done'`); // the sandbox's own change
    await wipeScratch(scratch, target.liveName);
    await cloneGroup(ro, scratch, c.groupId, target.liveName);
    const t = await scratch.query(`SELECT status FROM rosey_tasks`);
    expect(t.rows).toEqual([{ status: "open" }]);
  });

  it("never writes to a database that is not a scratch one", async () => {
    const c = await seedGroup("d");
    await expect(cloneGroup(ro, live, c.groupId, target.liveName)).rejects.toThrow(/refusing/);
    await expect(wipeScratch(live, target.liveName)).rejects.toThrow(/refusing/);
  });
});
