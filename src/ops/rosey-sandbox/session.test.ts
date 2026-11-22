import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEDUP_SYSTEM } from "../../rosey/dedup.js";
import { setRoseyEnabled } from "../../rosey/run.js";
import { createTestDatabase } from "../../test/db.js";
import { RoseySandbox } from "./session.js";

let pool: pg.Pool;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: await createTestDatabase() });
}, 120_000);
afterAll(async () => {
  await pool?.end();
}, 30_000);

/** A synthetic group with an owner and one other member, as a scratch copy holds it. */
async function seed(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, source, whatsapp_id) VALUES ($1, 'live', $2) RETURNING id`,
    [`sbx-${randomUUID()}`, `${randomUUID().replace(/-/g, "").slice(0, 18)}@g.us`],
  );
  const groupId = Number(rows[0]!.id);
  for (const [name, fromMe] of [
    [`אייל-${randomUUID().slice(0, 4)}`, true],
    [`דנה-${randomUUID().slice(0, 4)}`, false],
  ] as const) {
    const { rows: p } = await pool.query<{ id: string }>(
      `INSERT INTO participants (display_name) VALUES ($1) RETURNING id`,
      [name],
    );
    await pool.query(
      `INSERT INTO messages (group_id, participant_id, source, message_type, text_content, sent_at,
                             dedupe_key, from_me, sender_jid, created_at)
       VALUES ($1, $2, 'live', 'text', 'שלום', now() - interval '1 day', $3, $4, $5, now() - interval '1 day')`,
      [groupId, p[0]!.id, `dk-${randomUUID()}`, fromMe, `${randomUUID().slice(0, 8)}@lid`],
    );
  }
  await setRoseyEnabled(pool, groupId, true);
  return groupId;
}

/** Every batch line becomes one suggested task (the model stand-in). */
const generate = async (system: string, user: string) => {
  if (system === DEDUP_SYSTEM) return '{"same_as": null}';
  const lines = [...user.matchAll(/^\[(\d+)\] \S+ \S+.*?: (.*)$/gmu)];
  return JSON.stringify({
    items: lines.map((m) => ({ m: Number(m[1]), kind: "task", text: m[2] })),
  });
};

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function sandbox(env: NodeJS.ProcessEnv = {}) {
  const groupId = await seed();
  const s = new RoseySandbox({ scratch: pool, groupId, generate, env, ownEchoGraceMs: 0 });
  await s.start();
  const st = await s.state();
  const member = st.members.findIndex((m) => !m.owner);
  return { s, member, owner: st.members.findIndex((m) => m.owner) };
}

describe("RoseySandbox", () => {
  it("lists the group's members, owner first, and its recent history", async () => {
    const { s } = await sandbox();
    const st = await s.state();
    expect(st.members.map((m) => m.owner)).toEqual([true, false]);
    expect(st.history).toHaveLength(2);
    s.stop();
  });

  it("a posted command goes through her real capture path into the task list", async () => {
    const { s, member } = await sandbox();
    await s.post({ member, text: "@Rosey לתקן ברז" });
    const st = await until(
      () => s.state(),
      (v) => v.tasks.length === 1,
    );
    expect(st.tasks.map((t) => [t.title, t.status])).toEqual([["לתקן ברז", "open"]]);
    expect(st.events.some((e) => /command →/.test(e.line))).toBe(true);
    s.stop();
  });

  it("answers a list request with polls whatever ROSEY_SEND_MODE says; a vote ticks the task done and back", async () => {
    const { s, member, owner } = await sandbox({ ROSEY_SEND_MODE: "off" });
    await s.post({ member, text: "@Rosey לתקן ברז" });
    await until(
      () => s.state(),
      (v) => v.tasks.length === 1,
    );
    await s.post({ member, text: "@רוזי מה המשימות?" });
    const st = await until(
      () => s.state(),
      (v) => v.polls.length === 1,
    );
    const poll = st.polls[0]!;
    expect([poll.name, poll.options]).toEqual(["📋 המשימות שלנו", ["לתקן ברז"]]);

    await s.vote({ pollId: poll.id, member: owner, option: 0 });
    expect((await s.state()).tasks[0]).toMatchObject({ status: "done", statusSource: "poll" });
    await s.vote({ pollId: poll.id, member: owner, option: 0 });
    expect((await s.state()).tasks[0]).toMatchObject({ status: "open", statusSource: "poll" });
    s.stop();
  });

  it("text style: her reply echoes back as her own post and her echo guard ignores it", async () => {
    const { s, member } = await sandbox();
    s.listStyle = "text";
    await s.post({ member, text: "@Rosey לתקן ברז" });
    await until(
      () => s.state(),
      (v) => v.tasks.length === 1,
    );
    await s.post({ member, text: "@רוזי רשימה" });
    const st = await until(
      () => s.state(),
      (v) => v.history.some((h) => h.rosey) && v.events.some((e) => /own-echo/.test(e.line)),
    );
    const reply = st.history.find((h) => h.rosey)!;
    expect(reply.text?.startsWith("🤖 רוזי")).toBe(true);
    expect(reply.text).toContain("\n"); // shown as sent, not as storage collapses it
    expect(reply.quotedId).not.toBeNull();
    expect(st.polls).toEqual([]);
    s.stop();
  });

  it("a manual set locks the item: a poll vote cannot move it", async () => {
    const { s, member, owner } = await sandbox();
    await s.post({ member, text: "@Rosey לתקן ברז" });
    const { tasks } = await until(
      () => s.state(),
      (v) => v.tasks.length === 1,
    );
    await s.post({ member, text: "@רוזי רשימה" });
    const { polls } = await until(
      () => s.state(),
      (v) => v.polls.length === 1,
    );
    await s.setStatus(tasks[0]!.id, "dropped");
    await s.vote({ pollId: polls[0]!.id, member: owner, option: 0 });
    expect((await s.state()).tasks[0]).toMatchObject({ status: "dropped", statusSource: "manual" });
    s.stop();
  });

  it("runs the suggestion pass on demand", async () => {
    const { s, member } = await sandbox();
    await s.post({ member, text: "צריך להזמין אינסטלטור" });
    await until(
      () => s.state(),
      (v) => v.events.some((e) => /chatter/.test(e.line)),
    );
    s.suggestNow();
    const st = await until(
      () => s.state(),
      (v) => !v.passRunning && v.tasks.length > 0,
    );
    expect(st.tasks.map((t) => [t.title, t.status])).toEqual([
      ["צריך להזמין אינסטלטור", "suggested"],
    ]);
    s.stop();
  });
});
