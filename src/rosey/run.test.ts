import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTasks } from "../db/repositories/rosey-tasks.js";
import { getLastRun } from "../db/repositories/scheduler-state.js";
import { createTestDatabase } from "../test/db.js";
import { loadRoseyConfig } from "./config.js";
import { DEDUP_SYSTEM } from "./dedup.js";
import { cursorKey, runAggregation } from "./run.js";

let pool: pg.Pool;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: await createTestDatabase() });
}, 120_000);
afterAll(async () => {
  await pool?.end();
}, 30_000);

const cfg = loadRoseyConfig({});

async function group(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, source) VALUES ($1, 'live') RETURNING id`,
    [`rosey-run-${randomUUID()}`],
  );
  return Number(rows[0]!.id);
}

async function message(groupId: number, text: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key)
     VALUES ($1, 'live', 'text', $2, now(), $3) RETURNING id`,
    [groupId, text, `dk-${randomUUID()}`],
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
    await message(g, "@Rosey לקנות לחם");
    await tick();

    const m1 = model();
    const first = await runAggregation(pool, g, { cfg, generate: m1.generate, days: 30 });
    // The tagged message is not shown to the model; it is applied as a command.
    expect(first).toMatchObject({
      cursorAdvanced: true,
      report: { created: 1, taggedSkipped: 1 },
      tagged: { commands: 1, created: 1 },
    });
    expect(m1.seen.join("\n")).not.toContain("לקנות לחם");
    expect(await getLastRun(pool, cursorKey(g))).not.toBeNull();

    await message(g, "להתקשר לאינסטלטור");
    const m2 = model();
    const second = await runAggregation(pool, g, { cfg, generate: m2.generate, days: 30 });
    expect(second.report.messagesRead).toBe(1);
    expect(m2.seen.join("\n")).not.toContain("להחליף נורה");

    const tasks = (await listTasks(pool, g)).map((t) => [t.title, t.origin]).sort();
    expect(tasks).toEqual(
      [
        ["להתקשר לאינסטלטור", "suggested"],
        ["להחליף נורה", "suggested"],
        ["לקנות לחם", "tag"],
      ].sort(),
    );
  });

  it("catches up on commands the live path missed, and applying one twice is harmless", async () => {
    const g = await group();
    await message(g, "@Rosey לתקן מזגן\nלקנות מסנן");
    await message(g, "@Rosey בוצע מזגן");
    const run = await runAggregation(pool, g, { cfg, generate: model().generate, days: 30 });
    expect(run.tagged).toEqual({ commands: 2, created: 2, confirmed: 0, done: 1 });

    const again = await runAggregation(pool, g, {
      cfg,
      generate: model().generate,
      days: 30,
      fromScratch: true,
    });
    expect(again.tagged).toEqual({ commands: 2, created: 0, confirmed: 0, done: 0 });
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

  it("does not advance the cursor when a batch fails, so the messages are read again", async () => {
    const g = await group();
    await message(g, "לקנות חלב");
    const failed = await runAggregation(pool, g, {
      cfg,
      generate: model({ fail: true }).generate,
      days: 30,
    });
    expect(failed.cursorAdvanced).toBe(false);
    expect(await getLastRun(pool, cursorKey(g))).toBeNull();

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
