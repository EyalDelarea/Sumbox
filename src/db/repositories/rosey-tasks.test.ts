import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import {
  countRoseyMessagesSince,
  insertTask,
  isRoseyPost,
  listTasks,
  liveTasksRaisedBetween,
  pollTaskIds,
  reconcileRoseyMessageId,
  recordRoseyMessage,
  recordRoseyPoll,
  recordStatusEvent,
  resolveRaisedBy,
  selectSourceMessages,
  setTaskKind,
  tasksDoneSince,
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
    kind: "task",
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
    const t = await task(g, m, { origin: "tag", title: "לקנות לחם", titleKey: "לקנות לחם" });
    const [rs, rt] = await Promise.all(
      [s, t].map((id) => listTasks(pool, g).then((l) => l.find((x) => x.id === id))),
    );
    expect(rs).toMatchObject({ status: "suggested", statusSource: "model", origin: "suggested" });
    expect(rt).toMatchObject({ status: "open", statusSource: "tag", origin: "tag" });
    expect(await events(s!)).toEqual([{ status: "suggested", source: "model", applied: true }]);
  });

  it("is idempotent per (message, title key), not per item position", async () => {
    const g = await group();
    const m = await message(g);
    expect(await task(g, m)).not.toBeNull();
    // The same item again, at another position: already stored.
    expect(await task(g, m, { sourceItemIndex: 3 })).toBeNull();
    // A different item at the same position: its own task (position is not identity).
    expect(await task(g, m, { title: "משהו אחר", titleKey: "משהו אחר" })).not.toBeNull();
    expect((await listTasks(pool, g)).map((t) => t.titleKey).sort()).toEqual([
      "לקנות חלב",
      "משהו אחר",
    ]);
  });

  it("the database itself refuses a second copy of an item on one message", async () => {
    const g = await group();
    const m = await message(g);
    await task(g, m);
    const raw = (index: number) =>
      pool.query(
        `INSERT INTO rosey_tasks (group_id, title, title_key, origin, status, status_source,
                                  source_message_id, source_item_index, raised_at)
         VALUES ($1, 'x', 'לקנות חלב', 'suggested', 'suggested', 'model', $2, $3, now())`,
        [g, m, index],
      );
    await expect(raw(7)).rejects.toThrow(/rosey_tasks_source_title_unique/);
  });

  it("concurrent inserts of one item on one message store it once", async () => {
    const g = await group();
    const m = await message(g);
    const ids = await Promise.all([0, 1, 2, 3].map((i) => task(g, m, { sourceItemIndex: i })));
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(await listTasks(pool, g)).toHaveLength(1);
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

  it("applies a chat act and records who made it", async () => {
    const g = await group();
    const id = (await task(g, await message(g)))!;
    expect(
      await recordStatusEvent(pool, { taskId: id, status: "open", source: "tag" }),
    ).toMatchObject({
      applied: true,
      current: "open",
    });
    expect(
      await recordStatusEvent(pool, { taskId: id, status: "done", source: "react" }),
    ).toMatchObject({
      applied: true,
      current: "done",
    });
    const [t] = await listTasks(pool, g, { includeClosed: true });
    expect(t).toMatchObject({ status: "done", statusSource: "react" });
  });

  it("D4: setting by hand the status a tag already set still locks it as manual", async () => {
    const g = await group();
    const id = (await task(g, await message(g), { origin: "tag" }))!; // open, by tag
    expect(await recordStatusEvent(pool, { taskId: id, status: "open", source: "manual" })).toEqual(
      { found: true, applied: true, previous: "open", current: "open" },
    );
    expect(
      await recordStatusEvent(pool, { taskId: id, status: "done", source: "tag" }),
    ).toMatchObject({ applied: false, current: "open" });
    const [t] = await listTasks(pool, g, { includeClosed: true });
    expect(t).toMatchObject({ status: "open", statusSource: "manual" });
  });

  it("D4: a task closed by hand is never reopened by a later @Rosey tag", async () => {
    const g = await group();
    const id = (await task(g, await message(g), { origin: "tag" }))!;
    expect(
      await recordStatusEvent(pool, { taskId: id, status: "done", source: "manual" }),
    ).toMatchObject({ applied: true, current: "done" });
    expect(await recordStatusEvent(pool, { taskId: id, status: "open", source: "tag" })).toEqual({
      found: true,
      applied: false,
      previous: "done",
      current: "done",
    });
    // The refused act is still on the record.
    expect((await events(id)).at(-1)).toEqual({ status: "open", source: "tag", applied: false });
    // Only another manual change moves it.
    expect(
      await recordStatusEvent(pool, { taskId: id, status: "open", source: "manual" }),
    ).toMatchObject({ applied: true, current: "open" });
    const [t] = await listTasks(pool, g, { includeClosed: true });
    expect(t).toMatchObject({ status: "open", statusSource: "manual" });
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

  it("reads one kind only when asked: dedup is per kind", async () => {
    const g = await group();
    const m = await message(g);
    const at = new Date(Date.UTC(2026, 10, 10));
    const t = (await task(g, m, { title: "לתקן ברז", titleKey: "לתקן ברז", raisedAt: at }))!;
    const gr = (await task(g, m, {
      title: "חלב",
      titleKey: "חלב",
      kind: "grocery",
      raisedAt: at,
    }))!;
    const since = new Date(Date.UTC(2026, 10, 1));
    const until = new Date(Date.UTC(2026, 10, 20));
    const ids = async (kind?: "task" | "grocery") =>
      (await liveTasksRaisedBetween(pool, g, since, until, 60, { kind })).map((x) => x.id).sort();
    expect(await ids("grocery")).toEqual([gr]);
    expect(await ids("task")).toEqual([t]);
    expect(await ids()).toEqual([t, gr].sort());
  });
});

describe("kind", () => {
  it("is stored on insert and read back by both list views", async () => {
    const g = await group();
    const m = await message(g);
    const gr = (await task(g, m, { title: "חלב", titleKey: "חלב", kind: "grocery" }))!;
    const t = (await task(g, m, { title: "לתקן ברז", titleKey: "לתקן ברז" }))!;
    const listed = await listTasks(pool, g);
    expect(listed.find((x) => x.id === gr)?.kind).toBe("grocery");
    expect(listed.find((x) => x.id === t)?.kind).toBe("task");
    const live = await liveTasksRaisedBetween(pool, g, new Date(0), new Date("2030-01-01"));
    expect(live.find((x) => x.id === gr)?.kind).toBe("grocery");
  });

  it("a row written without a kind is a task (the column default)", async () => {
    const g = await group();
    const m = await message(g);
    await pool.query(
      `INSERT INTO rosey_tasks (group_id, title, title_key, origin, status, status_source,
                                source_message_id, raised_at)
       VALUES ($1, 'x', 'x', 'tag', 'open', 'tag', $2, now())`,
      [g, m],
    );
    expect((await listTasks(pool, g))[0]?.kind).toBe("task");
  });

  it("setTaskKind changes the kind by hand and leaves the status alone", async () => {
    const g = await group();
    const m = await message(g);
    const id = (await task(g, m, { title: "חלב", titleKey: "חלב" }))!;
    expect(await setTaskKind(pool, id, "grocery")).toEqual({
      found: true,
      previous: "task",
      current: "grocery",
    });
    const row = (await listTasks(pool, g)).find((x) => x.id === id)!;
    expect(row).toMatchObject({ kind: "grocery", status: "suggested", statusSource: "model" });
    expect(await setTaskKind(pool, id, "task")).toMatchObject({
      previous: "grocery",
      current: "task",
    });
    expect(await setTaskKind(pool, 987_654_321, "task")).toEqual({ found: false });
  });

  it("a re-read never rewrites the kind of a stored item", async () => {
    const g = await group();
    const m = await message(g);
    const id = (await task(g, m, { title: "חלב", titleKey: "חלב" }))!;
    await setTaskKind(pool, id, "grocery");
    // The model labels the same item of the same message the other way on a rerun.
    expect(await task(g, m, { title: "חלב", titleKey: "חלב", kind: "task" })).toBeNull();
    expect((await listTasks(pool, g)).find((x) => x.id === id)?.kind).toBe("grocery");
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

describe("Rosey's sent-message ledger", () => {
  it("records a reply once, marks it as her own post, and counts replies in a window", async () => {
    const g = await group();
    const other = await group();
    const t0 = new Date("2026-11-22T10:00:00Z");
    await recordRoseyMessage(pool, { groupId: g, externalId: "R1", kind: "reply", sentAt: t0 });
    await recordRoseyMessage(pool, { groupId: g, externalId: "R1", kind: "reply", sentAt: t0 });
    await recordRoseyMessage(pool, {
      groupId: g,
      externalId: "R2",
      kind: "reply",
      sentAt: new Date("2026-11-22T08:00:00Z"),
    });
    await recordRoseyMessage(pool, { groupId: other, externalId: "R3", kind: "reply", sentAt: t0 });
    expect(await isRoseyPost(pool, g, "R1")).toBe(true);
    expect(await countRoseyMessagesSince(pool, g, "reply", new Date("2026-11-22T09:00:00Z"))).toBe(
      1,
    );
    expect(await countRoseyMessagesSince(pool, g, "reply", new Date("2026-11-22T00:00:00Z"))).toBe(
      2,
    );
  });
});

describe("her list polls in the ledger", () => {
  it("maps each option back to its task, counts the poll once, and is hers only in its group", async () => {
    const g = await group();
    const other = await group();
    const m = await message(g);
    const a = (await task(g, m, { title: "א", titleKey: "א" }))!;
    const b = (await task(g, m, { title: "ב", titleKey: "ב" }))!;
    const secret = new Uint8Array(32).fill(7);
    await recordRoseyPoll(pool, { groupId: g, externalId: "POLL1", secret, taskIds: [b, a] });

    expect(await pollTaskIds(pool, g, "POLL1")).toEqual([b, a]);
    expect(await pollTaskIds(pool, other, "POLL1")).toBeNull();
    expect(await pollTaskIds(pool, g, "POLL")).toBeNull(); // a prefix is not the poll
    expect(await isRoseyPost(pool, g, "POLL1")).toBe(true); // her own-echo guard
    expect(await countRoseyMessagesSince(pool, g, "poll", new Date(0))).toBe(1);
    const { rows } = await pool.query<{ message_secret: Buffer }>(
      `SELECT message_secret FROM rosey_messages WHERE group_id = $1 AND external_id = 'POLL1'`,
      [g],
    );
    expect(new Uint8Array(rows[0]!.message_secret)).toEqual(secret);
  });

  it("an option whose task was deleted maps to null; a poll vote never moves a manual status", async () => {
    const g = await group();
    const m = await message(g);
    const a = (await task(g, m, { title: "א", titleKey: "א" }))!;
    const b = (await task(g, m, { title: "ב", titleKey: "ב" }))!;
    await recordRoseyPoll(pool, {
      groupId: g,
      externalId: "POLL2",
      secret: new Uint8Array(32),
      taskIds: [a, b],
    });
    await pool.query(`DELETE FROM rosey_tasks WHERE id = $1`, [a]);
    expect(await pollTaskIds(pool, g, "POLL2")).toEqual([null, b]);

    await recordStatusEvent(pool, { taskId: b, status: "open", source: "manual" });
    const r = await recordStatusEvent(pool, { taskId: b, status: "done", source: "poll" });
    expect(r).toMatchObject({ found: true, applied: false, current: "open" });
  });
});

describe("reconcileRoseyMessageId", () => {
  it("re-keys a recorded post to the id WhatsApp reported, without counting it twice", async () => {
    const g = await group();
    const t0 = new Date("2026-11-22T10:00:00Z");
    await recordRoseyMessage(pool, { groupId: g, externalId: "CHOSEN", kind: "reply", sentAt: t0 });
    await reconcileRoseyMessageId(pool, g, "CHOSEN", "REPORTED");
    expect(await isRoseyPost(pool, g, "REPORTED")).toBe(true);
    expect(await isRoseyPost(pool, g, "CHOSEN")).toBe(false);
    expect(await countRoseyMessagesSince(pool, g, "reply", new Date(0))).toBe(1);
  });

  it("is a no-op when the reported id is already recorded (no duplicate, no error)", async () => {
    const g = await group();
    await recordRoseyMessage(pool, { groupId: g, externalId: "A", kind: "reply" });
    await recordRoseyMessage(pool, { groupId: g, externalId: "B", kind: "reply" });
    await reconcileRoseyMessageId(pool, g, "A", "B");
    expect(await isRoseyPost(pool, g, "B")).toBe(true);
    expect(await countRoseyMessagesSince(pool, g, "reply", new Date(0))).toBe(2);
  });
});

describe("tasksDoneSince", () => {
  it("returns the items whose applied done event falls in the window, of both kinds", async () => {
    const g = await group();
    const m = await message(g);
    const recent = (await task(g, m, { title: "ברז", titleKey: "ברז", sourceItemIndex: 0 }))!;
    const grocery = (await task(g, m, {
      title: "חלב",
      titleKey: "חלב",
      kind: "grocery",
      sourceItemIndex: 1,
    }))!;
    const old = (await task(g, m, { title: "ישן", titleKey: "ישן", sourceItemIndex: 2 }))!;
    const reopened = (await task(g, m, { title: "שוב", titleKey: "שוב", sourceItemIndex: 3 }))!;
    for (const id of [recent, grocery, old, reopened]) {
      await recordStatusEvent(pool, { taskId: id, status: "done", source: "manual" });
    }
    await pool.query(
      `UPDATE rosey_task_events SET created_at = now() - interval '30 days' WHERE task_id = $1`,
      [old],
    );
    await recordStatusEvent(pool, { taskId: reopened, status: "open", source: "manual" });
    const since = new Date(Date.now() - 7 * 86_400_000);
    expect((await tasksDoneSince(pool, g, since)).map((t) => t.id).sort()).toEqual(
      [recent, grocery].sort(),
    );
  });
});
