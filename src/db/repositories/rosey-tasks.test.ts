import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import {
  insertTask,
  listTasks,
  liveTasksRaisedBetween,
  recordStatusEvent,
  resolveRaisedBy,
  selectSourceMessages,
} from "./rosey-tasks.js";

let pool: pg.Pool;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: await createTestDatabase() });
}, 120_000);
afterAll(async () => {
  await pool?.end();
}, 30_000);

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function group(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, source, whatsapp_id) VALUES ($1, 'live', $2) RETURNING id`,
    [`rosey-${randomUUID()}`, `${randomUUID()}@g.us`],
  );
  return Number(rows[0]!.id);
}

async function participant(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO participants (display_name) VALUES ($1) RETURNING id`,
    [`${name}`],
  );
  return Number(rows[0]!.id);
}

async function message(
  groupId: number,
  opts: {
    text?: string | null;
    participantId?: number | null;
    fromMe?: boolean;
    senderJid?: string | null;
    sentAt?: Date;
    createdAt?: Date;
    type?: "text" | "media" | "system";
    externalId?: string;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, participant_id, source, message_type, text_content, sent_at,
                           dedupe_key, from_me, sender_jid, external_id, created_at)
     VALUES ($1, $2, 'live', $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now())) RETURNING id`,
    [
      groupId,
      opts.participantId ?? null,
      opts.type ?? "text",
      opts.text === undefined ? "טקסט" : opts.text,
      opts.sentAt ?? new Date(),
      `dk-${randomUUID()}`,
      opts.fromMe ?? false,
      opts.senderJid ?? null,
      opts.externalId ?? `ext-${randomUUID()}`,
      opts.createdAt ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

const task = (
  groupId: number,
  sourceMessageId: number,
  over: Partial<Parameters<typeof insertTask>[1]> = {},
) =>
  insertTask(pool, {
    groupId,
    title: "לקנות חלב",
    titleKey: "לקנות חלב",
    origin: "suggested",
    raisedByParticipantId: null,
    sourceMessageId,
    sourceItemIndex: 0,
    raisedAt: new Date("2026-11-10T08:00:00Z"),
    ...over,
  });

async function events(taskId: number) {
  const { rows } = await pool.query(
    `SELECT status, source, applied FROM rosey_task_events WHERE task_id = $1 ORDER BY id`,
    [taskId],
  );
  return rows;
}

// ── Writes ───────────────────────────────────────────────────────────────────

describe("insertTask", () => {
  it("starts a suggestion as 'suggested' and a tagged item as 'open', each with a creation event", async () => {
    const g = await group();
    const m = await message(g);
    const s = await task(g, m);
    const t = await task(g, m, { origin: "tag", sourceItemIndex: 1 });
    const [rs, rt] = await Promise.all(
      [s, t].map((id) => listTasks(pool, g).then((l) => l.find((x) => x.id === id))),
    );
    expect(rs).toMatchObject({ status: "suggested", statusSource: "model", origin: "suggested" });
    expect(rt).toMatchObject({ status: "open", statusSource: "tag", origin: "tag" });
    expect(await events(s!)).toEqual([{ status: "suggested", source: "model", applied: true }]);
  });

  it("is idempotent per (message, item index)", async () => {
    const g = await group();
    const m = await message(g);
    expect(await task(g, m)).not.toBeNull();
    expect(await task(g, m, { title: "משהו אחר", titleKey: "משהו אחר" })).toBeNull();
  });

  it("goes when its source message is deleted", async () => {
    const g = await group();
    const m = await message(g);
    const id = await task(g, m);
    await pool.query(`DELETE FROM messages WHERE id = $1`, [m]);
    const { rowCount } = await pool.query(`SELECT 1 FROM rosey_task_events WHERE task_id = $1`, [
      id,
    ]);
    expect(rowCount).toBe(0);
    expect(await listTasks(pool, g, { includeClosed: true })).toEqual([]);
  });
});

describe("recordStatusEvent", () => {
  it("logs an inferred hint without applying it", async () => {
    const g = await group();
    const id = (await task(g, await message(g), { origin: "tag" }))!;
    const r = await recordStatusEvent(pool, { taskId: id, status: "done", source: "inferred" });
    expect(r).toEqual({ found: true, applied: false, previous: "open", current: "open" });
    expect((await events(id)).at(-1)).toEqual({
      status: "done",
      source: "inferred",
      applied: false,
    });
  });

  it("applies an explicit act and records who made it", async () => {
    const g = await group();
    const id = (await task(g, await message(g)))!;
    expect(
      await recordStatusEvent(pool, { taskId: id, status: "open", source: "manual" }),
    ).toMatchObject({
      applied: true,
      current: "open",
    });
    expect(
      await recordStatusEvent(pool, { taskId: id, status: "done", source: "tag" }),
    ).toMatchObject({
      applied: true,
      current: "done",
    });
    const [t] = await listTasks(pool, g, { includeClosed: true });
    expect(t).toMatchObject({ status: "done", statusSource: "tag" });
  });

  it("refuses a task from another group, and an unknown task", async () => {
    const g = await group();
    const other = await group();
    const id = (await task(g, await message(g)))!;
    expect(
      await recordStatusEvent(pool, { taskId: id, status: "done", source: "tag", groupId: other }),
    ).toEqual({
      found: false,
    });
    expect(await recordStatusEvent(pool, { taskId: -1, status: "done", source: "manual" })).toEqual(
      {
        found: false,
      },
    );
    expect(await events(id)).toHaveLength(1);
  });
});

// ── Reads ────────────────────────────────────────────────────────────────────

describe("liveTasksRaisedBetween", () => {
  it("returns only suggested/open tasks raised inside the window", async () => {
    const g = await group();
    const m = await message(g);
    const at = (d: number) => new Date(Date.UTC(2026, 10, d));
    const inWin = (await task(g, m, { sourceItemIndex: 0, raisedAt: at(10) }))!;
    await task(g, m, { sourceItemIndex: 1, raisedAt: at(1) }); // too old
    const done = (await task(g, m, { sourceItemIndex: 2, raisedAt: at(11), origin: "tag" }))!;
    await recordStatusEvent(pool, { taskId: done, status: "done", source: "manual" });
    const live = await liveTasksRaisedBetween(pool, g, at(5), at(12));
    expect(live.map((t) => t.id)).toEqual([inWin]);
  });
});

describe("resolveRaisedBy", () => {
  it("resolves named senders, raw @lid senders via identity links, and the owner", async () => {
    const g = await group();
    const dana = await participant(`דנה-${randomUUID()}`);
    const owner = await participant(`אייל-${randomUUID()}`);
    const rawLid = await participant(`${randomUUID()}@lid`);
    const groupJid = await participant(`${randomUUID()}@g.us`);
    const lid = `${randomUUID()}@lid`;
    const pn = `${randomUUID()}@s.whatsapp.net`;
    await pool.query(
      `INSERT INTO identity_links (lid_jid, pn_jid, source) VALUES ($1, $2, 'message_alt')`,
      [lid, pn],
    );
    // Dana is seen under her phone JID with a real name…
    await message(g, { participantId: dana, senderJid: pn });
    // …so a raw-@lid row for the same person resolves to her through the link.
    const viaLid = await message(g, { participantId: rawLid, senderJid: lid });
    const named = await message(g, { participantId: dana, senderJid: pn });
    await message(g, { participantId: owner, fromMe: true });
    const ownerFallback = await message(g, { participantId: groupJid, fromMe: true });
    const unknown = await message(g, { participantId: groupJid, fromMe: false });

    const r = await resolveRaisedBy(pool, g, [viaLid, named, ownerFallback, unknown]);
    expect(r.get(viaLid)).toBe(dana);
    expect(r.get(named)).toBe(dana);
    expect(r.get(ownerFallback)).toBe(owner);
    expect(r.get(unknown)).toBeNull();
  });

  it("ignores message ids from another group", async () => {
    const g = await group();
    const other = await group();
    const m = await message(other, { participantId: await participant(`x-${randomUUID()}`) });
    expect((await resolveRaisedBy(pool, g, [m])).has(m)).toBe(false);
  });
});

describe("selectSourceMessages", () => {
  const since = new Date("2026-01-01T00:00:00Z");

  it("reads voice notes through their transcript and skips bots, system and empty messages", async () => {
    const g = await group();
    const text = await message(g, { text: "צריך חלב" });
    const voice = await message(g, { text: null, type: "media" });
    await pool.query(
      `INSERT INTO transcripts (message_id, transcript, engine, status) VALUES ($1, 'לקנות לחם', 'test', 'completed')`,
      [voice],
    );
    await message(g, { text: null, type: "media" }); // no transcript, no caption
    await message(g, { text: "הצטרף", type: "system" });
    await message(g, { text: "תשובה של אידה", externalId: "AIDA-1" });
    await pool.query(`INSERT INTO aida_messages (group_id, external_id) VALUES ($1, 'AIDA-1')`, [
      g,
    ]);
    await message(g, { text: "פוסט של רוזי", externalId: "ROSEY-1" });
    await pool.query(
      `INSERT INTO rosey_messages (group_id, external_id, kind) VALUES ($1, 'ROSEY-1', 'reply')`,
      [g],
    );

    const rows = await selectSourceMessages(pool, g, { sentSince: since, changedSince: null });
    expect(rows.map((r) => [r.messageId, r.content, r.isVoice])).toEqual([
      [text, "צריך חלב", false],
      [voice, "לקנות לחם", true],
    ]);
  });

  it("the cursor is ingest time — a late-ingested old message and a late transcript are both re-read", async () => {
    const g = await group();
    const cursor = new Date();
    const old = new Date("2026-06-01T00:00:00Z");
    await message(g, {
      text: "ישן ומוכר",
      sentAt: old,
      createdAt: new Date(cursor.getTime() - 60_000),
    });
    const lateSync = await message(g, {
      text: "ישן אבל חדש",
      sentAt: old,
      createdAt: new Date(cursor.getTime() + 60_000),
    });
    const voice = await message(g, {
      text: null,
      type: "media",
      sentAt: old,
      createdAt: new Date(cursor.getTime() - 60_000),
    });
    await pool.query(
      `INSERT INTO transcripts (message_id, transcript, engine, status, created_at)
       VALUES ($1, 'תמלול מאוחר', 'test', 'completed', $2)`,
      [voice, new Date(cursor.getTime() + 60_000)],
    );
    const rows = await selectSourceMessages(pool, g, { sentSince: since, changedSince: cursor });
    expect(rows.map((r) => r.messageId).sort()).toEqual([lateSync, voice].sort());
  });
});
