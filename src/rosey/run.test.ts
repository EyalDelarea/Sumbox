import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTasks } from "../db/repositories/rosey-tasks.js";
import { getLastRun, recordRun } from "../db/repositories/scheduler-state.js";
import { createTestDatabase } from "../test/db.js";
import { loadRoseyConfig } from "./config.js";
import { DEDUP_SYSTEM } from "./dedup.js";
import { cursorKey, runAggregation, setRoseyEnabled } from "./run.js";

let pool: pg.Pool;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: await createTestDatabase() });
}, 120_000);
afterAll(async () => {
  await pool?.end();
}, 30_000);

const cfg = loadRoseyConfig({});

/** Before any test message: Rosey has listened since long ago (a cursor at epoch). */
const ENABLED_LONG_AGO = new Date(0);

async function group(opts: { cursor?: Date | null } = {}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, source) VALUES ($1, 'live') RETURNING id`,
    [`rosey-run-${randomUUID()}`],
  );
  const id = Number(rows[0]!.id);
  const cursor = opts.cursor === undefined ? ENABLED_LONG_AGO : opts.cursor;
  if (cursor) await recordRun(pool, cursorKey(id), cursor);
  return id;
}

/** `lateMs`: how long after sending it was ingested (a reconnect replay is late). */
async function message(groupId: number, text: string, lateMs = 0): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key)
     VALUES ($1, 'live', 'text', $2, now() - make_interval(secs => $4::float / 1000), $3)
     RETURNING id`,
    [groupId, text, `dk-${randomUUID()}`, lateMs],
  );
  return Number(rows[0]!.id);
}

/**
 * The cursor is a JS Date (millisecond resolution) and created_at has
 * microseconds, so a message stored in the same millisecond a run starts is
 * read again next run. That direction is safe (re-reads are idempotent); a
 * test that counts reads lets the clock move on first.
 */
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A scripted local model: every message becomes one task titled after its text. */
function model(opts: { fail?: boolean } = {}) {
  const seen: string[] = [];
  const generate = async (system: string, user: string) => {
    if (system === DEDUP_SYSTEM) return '{"same_as": null}';
    if (opts.fail) throw new Error("ollama down");
    seen.push(user);
    const ids = [...user.matchAll(/^\[(\d+)\] \S+ \S+.*?: (.*)$/gmu)];
    return JSON.stringify({
      items: ids.map((m) => ({ m: Number(m[1]), kind: "task", text: m[2] })),
    });
  };
  return { generate, seen };
}

describe("runAggregation", () => {
  it("stores suggestions, advances the cursor, and reads only new messages next time", async () => {
    const g = await group();
    await message(g, "להחליף נורה");
    const tag = await message(g, "@Rosey לקנות לחם");
    await tick();

    const m1 = model();
    const first = await runAggregation(pool, g, {
      cfg,
      generate: m1.generate,
      days: 30,
      skipCommand: (m) => m.messageId === tag, // the live path decided it
    });
    // The tagged message is never shown to the model, and the live path decided
    // it, so the pass does not replay it.
    expect(first).toMatchObject({
      cursorAdvanced: true,
      report: { created: 1, taggedSkipped: 1 },
      tagged: { commands: 0 },
    });
    expect(m1.seen.join("\n")).not.toContain("לקנות לחם");
    expect(await getLastRun(pool, cursorKey(g))).not.toBeNull();

    await message(g, "להתקשר לאינסטלטור");
    const m2 = model();
    const second = await runAggregation(pool, g, { cfg, generate: m2.generate, days: 30 });
    expect(second.report.messagesRead).toBe(1);
    expect(m2.seen.join("\n")).not.toContain("להחליף נורה");

    const titles = (await listTasks(pool, g)).map((t) => t.title).sort();
    expect(titles).toEqual(["להתקשר לאינסטלטור", "להחליף נורה"].sort());
  });

  it("catches up on late commands the live path never saw, exactly once", async () => {
    const g = await group();
    const TEN_MIN = 10 * 60_000;
    await message(g, "@Rosey לתקן מזגן\nלקנות מסנן", TEN_MIN);
    await message(g, "@Rosey בוצע מזגן", TEN_MIN);
    await message(g, "@Rosey בוצע", TEN_MIN); // a quote-only done, its quote lost
    await tick();
    const run = await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    expect(run.tagged).toEqual({
      commands: 3,
      created: 2,
      confirmed: 0,
      done: 1,
      noMatch: 1,
      ambiguous: 0,
      refused: 0,
      failures: 0,
    });

    const again = await runAggregation(pool, g, {
      cfg,
      generate: model().generate,
      days: 30,
      fromScratch: true,
    });
    // Commands are replayed only past the cursor, even from scratch: the no-op
    // "done" wrote no event, yet a re-read must not try it again — by now a task
    // it names could exist, and closing that would be acting on a stale command.
    expect(again.tagged).toMatchObject({ commands: 0 });
    const tasks = (await listTasks(pool, g, { includeClosed: true }))
      .map((t) => [t.title, t.status])
      .sort();
    expect(tasks).toEqual(
      [
        ["לתקן מזגן", "done"],
        ["לקנות מסנן", "open"],
      ].sort(),
    );
  });

  it("keeps the cursor on the database clock, so a host clock running ahead skips nothing", async () => {
    const g = await group();
    await message(g, "להחליף נורה");
    await tick();
    // The host clock is a minute ahead of the database that stamps created_at.
    const ahead = () => new Date(Date.now() + 60_000);
    await runAggregation(pool, g, { cfg, generate: model().generate, days: 30, now: ahead });
    await message(g, "להתקשר לאינסטלטור");
    const m2 = model();
    const second = await runAggregation(pool, g, {
      cfg,
      generate: m2.generate,
      days: 30,
      now: ahead,
    });
    expect(second.report.messagesRead).toBe(1);
    expect(m2.seen.join("\n")).toContain("להתקשר לאינסטלטור");
  });

  it("replays an on-time command no live path decided (its live apply threw)", async () => {
    const g = await group();
    await message(g, "@Rosey לתקן מזגן"); // on time: the live path owned it, and failed
    const run = await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    expect(run.tagged).toMatchObject({ commands: 1, created: 1 });
    expect((await listTasks(pool, g)).map((t) => t.title)).toEqual(["לתקן מזגן"]);
  });

  it("never replays a command the live path decided, or one it is still handling", async () => {
    const g = await group();
    const decided = await message(g, "@Rosey בוצע חלב"); // live: no match then
    await runAggregation(pool, g, {
      cfg,
      generate: model().generate,
      days: 30,
      skipCommand: (m) => m.messageId === decided,
    }).then((r) => expect(r.tagged).toMatchObject({ commands: 0 }));
  });

  it("holds the cursor while the live path still owes an apply", async () => {
    const g = await group();
    await message(g, "להחליף נורה");
    const run = await runAggregation(pool, g, {
      cfg,
      generate: model().generate,
      days: 30,
      holdCursor: () => true,
    });
    expect(run.cursorAdvanced).toBe(false);
    expect(await getLastRun(pool, cursorKey(g))).toEqual(ENABLED_LONG_AGO);
  });

  it("a group with no cursor replays no command on its first pass, and suggests", async () => {
    const g = await group({ cursor: null });
    await message(g, "@Rosey לתקן מזגן", 10 * 60_000);
    await message(g, "צריך להחליף נורה");
    const run = await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    expect(run.tagged).toMatchObject({ commands: 0 });
    expect(run.report.created).toBe(1);
    expect((await listTasks(pool, g)).map((t) => t.origin)).toEqual(["suggested"]);
    expect(run.cursorAdvanced).toBe(true);
  });

  it("first enabling Rosey starts the cursor: older commands are never replayed, newer ones are", async () => {
    const g = await group({ cursor: null });
    await message(g, "@Rosey לתקן מזגן", 10 * 60_000); // before she listened
    await tick();
    await setRoseyEnabled(pool, g, true);
    const start = await getLastRun(pool, cursorKey(g));
    expect(start).not.toBeNull();
    await tick();
    await message(g, "@Rosey לקנות מסנן", 10 * 60_000); // a late replay after enabling
    const run = await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    expect(run.tagged).toMatchObject({ commands: 1, created: 1 });
    expect((await listTasks(pool, g)).map((t) => t.title)).toEqual(["לקנות מסנן"]);

    // Enabling a group that is already enabled leaves its cursor alone.
    const before = await getLastRun(pool, cursorKey(g));
    await tick();
    await setRoseyEnabled(pool, g, true);
    expect(await getLastRun(pool, cursorKey(g))).toEqual(before);
  });

  it("re-enabling after a disable restarts the cursor: commands sent while off are never replayed", async () => {
    const g = await group({ cursor: null });
    await setRoseyEnabled(pool, g, true);
    await tick();
    await setRoseyEnabled(pool, g, false);
    await message(g, "@Rosey לתקן מזגן", 10 * 60_000); // sent while she was off
    await tick();
    await setRoseyEnabled(pool, g, true);
    await tick();
    await message(g, "@Rosey לקנות מסנן", 10 * 60_000); // a late replay after re-enabling
    const run = await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    expect(run.tagged).toMatchObject({ commands: 1, created: 1 });
    expect((await listTasks(pool, g)).map((t) => t.title)).toEqual(["לקנות מסנן"]);
  });

  it("a backfill after enabling reads the history for suggestions, never its commands", async () => {
    const g = await group({ cursor: null });
    await message(g, "@Rosey לתקן מזגן", 10 * 60_000); // before she listened
    await message(g, "צריך להחליף נורה");
    await tick();
    await setRoseyEnabled(pool, g, true);
    const run = await runAggregation(pool, g, {
      cfg,
      generate: model().generate,
      days: 30,
      fromScratch: true,
    });
    expect(run.report.messagesRead).toBe(2);
    expect(run.tagged).toMatchObject({ commands: 0 });
    expect((await listTasks(pool, g)).map((t) => t.origin)).toEqual(["suggested"]);
  });

  it("never replays a message addressed to @Aida as a command", async () => {
    const g = await group();
    await message(g, "@Aida מה @Rosey הוסיפה?", 10 * 60_000);
    const run = await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    expect(run.tagged).toMatchObject({ commands: 0 });
    expect(await listTasks(pool, g, { includeClosed: true })).toEqual([]);
  });

  it("does not advance the cursor when a batch fails, so the messages are read again", async () => {
    const g = await group();
    await message(g, "לקנות חלב");
    const failed = await runAggregation(pool, g, {
      cfg,
      generate: model({ fail: true }).generate,
      days: 30,
    });
    expect(failed.cursorAdvanced).toBe(false);
    expect(await getLastRun(pool, cursorKey(g))).toEqual(ENABLED_LONG_AGO);

    const retry = await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    expect(retry.report).toMatchObject({ messagesRead: 1, created: 1 });
  });

  it("fromScratch re-reads the window without duplicating stored items", async () => {
    const g = await group();
    await message(g, "לקנות חלב");
    await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    const again = await runAggregation(pool, g, {
      cfg,
      generate: model().generate,
      days: 30,
      fromScratch: true,
    });
    expect(again.report.messagesRead).toBe(1);
    expect(again.report.created).toBe(0);
    expect(await listTasks(pool, g)).toHaveLength(1);
  });

  it("a rerun where the model answers differently loses no task", async () => {
    const g = await group();
    const m = await message(g, "רשימה לסופר");
    // The model's reply for one message, scripted per run.
    const scripted = (texts: string[]) => async (system: string) =>
      system === DEDUP_SYSTEM
        ? '{"same_as": null}'
        : JSON.stringify({ items: texts.map((text) => ({ m, kind: "task", text })) });

    await runAggregation(pool, g, {
      cfg,
      generate: scripted(["לקנות חלב", "לקנות לחם"]),
      days: 30,
    });
    // Run 2 drops the first item and finds a new one: the new item lands on the
    // position another stored task already holds.
    const again = await runAggregation(pool, g, {
      cfg,
      generate: scripted(["לקנות לחם", "לקנות ביצים"]),
      days: 30,
      fromScratch: true,
    });
    expect(again.report).toMatchObject({ created: 1, alreadyStored: 0 });
    const titles = (await listTasks(pool, g)).map((t) => t.title).sort();
    expect(titles).toEqual(["לקנות ביצים", "לקנות חלב", "לקנות לחם"].sort());
  });

  it("a rerun that repeats a stored item, even after it was closed, does not fork it", async () => {
    const g = await group();
    const m = await message(g, "רשימה לסופר");
    const scripted = (texts: string[]) => async (system: string) =>
      system === DEDUP_SYSTEM
        ? '{"same_as": null}'
        : JSON.stringify({ items: texts.map((text) => ({ m, kind: "task", text })) });
    await runAggregation(pool, g, {
      cfg,
      generate: scripted(["לקנות חלב", "לקנות לחם"]),
      days: 30,
    });
    // Closed tasks are not dedup candidates, so only the store's identity stops a fork.
    await pool.query(`UPDATE rosey_tasks SET status = 'done' WHERE group_id = $1`, [g]);
    const again = await runAggregation(pool, g, {
      cfg,
      generate: scripted(["לקנות לחם", "לקנות חלב"]),
      days: 30,
      fromScratch: true,
    });
    expect(again.report).toMatchObject({ created: 0, alreadyStored: 2 });
    expect(await listTasks(pool, g, { includeClosed: true })).toHaveLength(2);
  });
});
