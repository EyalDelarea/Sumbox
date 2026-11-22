/**
 * Rosey's live path against a real database: the exact wiring the collector
 * uses (makeRoseyLive), driven with WhatsApp-shaped messages. The model is a
 * scripted fake; nothing here can send — makeRoseyLive is never given a session.
 */

import { randomUUID } from "node:crypto";
import type { WAMessage } from "@whiskeysockets/baileys";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordAidaMessage } from "../db/repositories/aida-messages.js";
import {
  ROSEY_COMMAND_KEY,
  upsertCommandPermission,
} from "../db/repositories/group-command-permissions.js";
import { listTasks } from "../db/repositories/rosey-tasks.js";
import { createTestDatabase } from "../test/db.js";
import { loadRoseyConfig } from "./config.js";
import { DEDUP_SYSTEM } from "./dedup.js";
import { makeRoseyLive, roseyLiveFromEnv } from "./live.js";

let pool: pg.Pool;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: await createTestDatabase() });
}, 120_000);
afterAll(async () => {
  await pool?.end();
}, 30_000);

const cfg = { ...loadRoseyConfig({ ROSEY_ENABLED: "true" }), suggestDebounceMs: 20 };

async function group(enabled: boolean): Promise<{ id: number; jid: string }> {
  const jid = `${randomUUID().replace(/-/g, "").slice(0, 18)}@g.us`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, source, whatsapp_id) VALUES ($1, 'live', $2) RETURNING id`,
    [`rosey-live-${randomUUID()}`, jid],
  );
  const id = Number(rows[0]!.id);
  if (enabled)
    await upsertCommandPermission(pool, { groupId: id, command: ROSEY_COMMAND_KEY, enabled });
  return { id, jid };
}

/** Ingest stand-in: the row the collector would have written before Rosey runs. */
async function ingest(
  groupId: number,
  externalId: string,
  text: string,
  sentAt: Date,
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, source, message_type, text_content, sent_at, dedupe_key, external_id)
     VALUES ($1, 'live', 'text', $2, $5, $3, $4) RETURNING id`,
    [groupId, text, `dk-${randomUUID()}`, externalId, sentAt],
  );
  return Number(rows[0]!.id);
}

function wa(
  jid: string,
  id: string,
  text: string,
  sentAt: Date,
  quotedId?: string,
  fromMe = false,
): WAMessage {
  return {
    key: { id, remoteJid: jid, participant: "972500000001@s.whatsapp.net", fromMe },
    messageTimestamp: sentAt.getTime() / 1000,
    message: quotedId
      ? { extendedTextMessage: { text, contextInfo: { stanzaId: quotedId } } }
      : { conversation: text },
  } as WAMessage;
}

/** Every batch line becomes one task titled after its text. */
const generate = vi.fn(async (system: string, user: string) => {
  if (system === DEDUP_SYSTEM) return '{"same_as": null}';
  const lines = [...user.matchAll(/^\[(\d+)\] \S+ \S+.*?: (.*)$/gmu)];
  return JSON.stringify({
    items: lines.map((m) => ({ m: Number(m[1]), kind: "task", text: m[2] })),
  });
});

async function deliver(
  live: ReturnType<typeof makeRoseyLive>,
  g: { id: number; jid: string },
  text: string,
  quotedId?: string,
) {
  const externalId = `WA-${randomUUID()}`;
  // Whole seconds, as WhatsApp timestamps are — ingest stores the same instant.
  const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const messageId = await ingest(g.id, externalId, text, sentAt);
  await live.onMessage(wa(g.jid, externalId, text, sentAt, quotedId));
  return { externalId, messageId };
}

describe("makeRoseyLive", () => {
  it("is off unless ROSEY_ENABLED=true", () => {
    expect(roseyLiveFromEnv(pool, undefined, {})).toBeUndefined();
    expect(roseyLiveFromEnv(pool, undefined, { ROSEY_ENABLED: "false" })).toBeUndefined();
    const on = roseyLiveFromEnv(pool, undefined, { ROSEY_ENABLED: "true" });
    expect(on).toBeDefined();
    on?.stop();
  });

  it("captures an explicit tag as open tasks citing the stored message, then closes one by text and one by quote", async () => {
    const live = makeRoseyLive({ pool, cfg, generate });
    const g = await group(true);

    const list = await deliver(live, g, "@Rosey לקנות חלב\nלתקן ברז");
    let tasks = await listTasks(pool, g.id, { includeClosed: true });
    tasks.sort((a, b) => a.sourceItemIndex - b.sourceItemIndex);
    expect(tasks.map((t) => [t.title, t.status, t.origin, t.sourceMessageId])).toEqual([
      ["לקנות חלב", "open", "tag", list.messageId],
      ["לתקן ברז", "open", "tag", list.messageId],
    ]);

    await deliver(live, g, "@רוזי בוצע לקנות חלב");
    tasks = await listTasks(pool, g.id, { includeClosed: true });
    expect(tasks.find((t) => t.title === "לקנות חלב")?.status).toBe("done");

    // Quote the list message: only one of its tasks is still live, so it resolves.
    await deliver(live, g, "@רוזי done", list.externalId);
    tasks = await listTasks(pool, g.id, { includeClosed: true });
    expect(tasks.every((t) => t.status === "done")).toBe(true);
    expect(tasks.every((t) => t.statusSource === "tag")).toBe(true);
    live.stop();
  });

  it("never acts on a message recorded in her own sent ledger", async () => {
    const live = makeRoseyLive({ pool, cfg, generate });
    const g = await group(true);
    const externalId = `WA-${randomUUID()}`;
    await pool.query(
      `INSERT INTO rosey_messages (group_id, external_id, kind) VALUES ($1, $2, 'reply')`,
      [g.id, externalId],
    );
    const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await ingest(g.id, externalId, "@Rosey לקנות חלב", sentAt);
    await live.onMessage(wa(g.jid, externalId, "@Rosey לקנות חלב", sentAt));
    expect(await listTasks(pool, g.id, { includeClosed: true })).toEqual([]);
    live.stop();
  });

  it("never applies @Aida's echo as a command, even when it arrives before her marker", async () => {
    const live = makeRoseyLive({ pool, cfg, generate, ownEchoGraceMs: 80 });
    const g = await group(true);
    const externalId = `WA-${randomUUID()}`;
    const text = "@Rosey הוסיפה: לקנות חלב"; // her reply naming Rosey
    const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await ingest(g.id, externalId, text, sentAt);
    // Her send resolves (and her marker is written) only after the echo landed.
    const marker = new Promise((r) => setTimeout(r, 20)).then(() =>
      recordAidaMessage(pool, { groupId: g.id, externalId }),
    );
    await live.onMessage(wa(g.jid, externalId, text, sentAt, undefined, true));
    await marker;
    expect(await listTasks(pool, g.id, { includeClosed: true })).toEqual([]);
    live.stop();
  });

  it("the owner's own command (from_me, never marked) still applies, after the grace", async () => {
    const live = makeRoseyLive({ pool, cfg, generate, ownEchoGraceMs: 10 });
    const g = await group(true);
    const externalId = `WA-${randomUUID()}`;
    const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await ingest(g.id, externalId, "@Rosey לקנות חלב", sentAt);
    await live.onMessage(wa(g.jid, externalId, "@Rosey לקנות חלב", sentAt, undefined, true));
    const tasks = await listTasks(pool, g.id, { includeClosed: true });
    expect(tasks.map((t) => [t.title, t.origin])).toEqual([["לקנות חלב", "tag"]]);
    live.stop();
  });

  it("a message that wakes @Aida is hers alone: Rosey applies nothing", async () => {
    const live = makeRoseyLive({ pool, cfg, generate });
    const g = await group(true);
    await deliver(live, g, "@Rosey לקנות חלב @Aida");
    await new Promise((r) => setTimeout(r, 60)); // past the debounce: no pass either
    expect(await listTasks(pool, g.id, { includeClosed: true })).toEqual([]);
    live.stop();
  });

  it("a command whose live apply threw is replayed by the next pass", async () => {
    let failTaskInsert = true;
    const flakyPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === "connect") {
          return async () => {
            const client = await target.connect();
            const query = client.query.bind(client) as (...a: unknown[]) => unknown;
            (client as { query: unknown }).query = (...args: unknown[]) => {
              if (failTaskInsert && String(args[0]).includes("INSERT INTO rosey_tasks")) {
                failTaskInsert = false;
                return Promise.reject(new Error("db blip"));
              }
              return query(...args);
            };
            return client;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const live = makeRoseyLive({ pool: flakyPool, cfg, generate });
    const g = await group(true);
    await expect(deliver(live, g, "@Rosey לתקן מזגן")).rejects.toThrow("db blip");
    expect(await listTasks(pool, g.id, { includeClosed: true })).toEqual([]);

    await deliver(live, g, "צריך לקנות מסנן"); // any chatter schedules the pass
    await vi.waitFor(async () => {
      const tags = (await listTasks(pool, g.id, { includeClosed: true })).filter(
        (t) => t.origin === "tag",
      );
      expect(tags.map((t) => t.title)).toEqual(["לתקן מזגן"]);
    });
    live.stop();
  });

  it("never replays a command the live path decided without effect", async () => {
    const live = makeRoseyLive({ pool, cfg, generate });
    const g = await group(true);
    await deliver(live, g, "@Rosey בוצע לתקן מזגן"); // nothing to close yet
    await deliver(live, g, "@Rosey לתקן מזגן"); // the task appears only now
    await deliver(live, g, "צריך לקנות מסנן"); // schedules the pass
    await vi.waitFor(async () => {
      expect(await listTasks(pool, g.id, { includeClosed: true })).toHaveLength(2);
    });
    // Replaying the earlier "done" would close a task created after it was sent.
    const tasks = await listTasks(pool, g.id, { includeClosed: true });
    expect(tasks.find((t) => t.title === "לתקן מזגן")?.status).toBe("open");
    live.stop();
  });

  it("applies commands in arrival order even when the first one's lookups are slower", async () => {
    const add = `WA-${randomUUID()}`;
    const done = `WA-${randomUUID()}`;
    // The first message's id lookup is slow, so without arrival ordering the
    // "done" would reach the store before the "add" it closes.
    const slowPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === "query") {
          return async (...args: Parameters<pg.Pool["query"]>) => {
            const params = args[1] as unknown[] | undefined;
            if (Array.isArray(params) && params.includes(add)) {
              await new Promise((r) => setTimeout(r, 150));
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const live = makeRoseyLive({ pool: slowPool, cfg, generate });
    const g = await group(true);
    const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await ingest(g.id, add, "@Rosey להזמין גז", sentAt);
    await ingest(g.id, done, "@Rosey done להזמין גז", sentAt);
    // Not awaited one by one: the collector fires each message as it lands.
    await Promise.all([
      live.onMessage(wa(g.jid, add, "@Rosey להזמין גז", sentAt)),
      live.onMessage(wa(g.jid, done, "@Rosey done להזמין גז", sentAt)),
    ]);
    const tasks = await listTasks(pool, g.id, { includeClosed: true });
    expect(tasks.map((t) => t.status)).toEqual(["done"]);
    live.stop();
  });

  it("a command queued behind a long suggestion pass is judged live by its arrival, not lost", async () => {
    let clockMs = Date.now();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let passStarted = false;
    const slowModel = async (system: string, user: string) => {
      if (system !== DEDUP_SYSTEM) {
        passStarted = true;
        await released;
      }
      return generate(system, user);
    };
    const live = makeRoseyLive({ pool, cfg, generate: slowModel, now: () => clockMs });
    const g = await group(true);

    await deliver(live, g, "צריך לסדר את הארון"); // starts the debounced pass
    await vi.waitFor(() => expect(passStarted).toBe(true));

    // Two commands land while the model is busy; neither may wait for it to be judged.
    const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const pending = ["@Rosey לקנות נורות", "@Rosey לקנות מברג"].map(async (text) => {
      const id = `WA-${randomUUID()}`;
      await ingest(g.id, id, text, sentAt);
      return live.onMessage(wa(g.jid, id, text, sentAt));
    });
    await new Promise((r) => setTimeout(r, 50));
    clockMs += 10 * 60_000; // the pass takes minutes
    release();
    await Promise.all(pending);

    const tags = (await listTasks(pool, g.id, { includeClosed: true }))
      .filter((t) => t.origin === "tag")
      .map((t) => t.title)
      .sort();
    expect(tags).toEqual(["לקנות מברג", "לקנות נורות"]);
    live.stop();
  });

  it("ignores a group that is not enabled for Rosey", async () => {
    const live = makeRoseyLive({ pool, cfg, generate });
    const g = await group(false);
    await deliver(live, g, "@Rosey לקנות חלב");
    expect(await listTasks(pool, g.id, { includeClosed: true })).toEqual([]);
    live.stop();
  });

  it("turns ordinary chat into suggestions only after the group goes quiet", async () => {
    generate.mockClear();
    const live = makeRoseyLive({ pool, cfg, generate });
    const g = await group(true);
    await deliver(live, g, "צריך להזמין טכנאי");
    await deliver(live, g, "וגם לשלם ארנונה");
    // Debounced: one pass for the burst, which reads both messages.
    await vi.waitFor(async () => {
      expect(await listTasks(pool, g.id, { includeClosed: true })).toHaveLength(2);
    });
    const suggestCalls = generate.mock.calls.filter(([system]) => system !== DEDUP_SYSTEM);
    expect(suggestCalls).toHaveLength(1);
    const tasks = await listTasks(pool, g.id, { includeClosed: true });
    expect(tasks.every((t) => t.status === "suggested" && t.origin === "suggested")).toBe(true);
    live.stop();
  });

  it("an explicit tag confirms a matching suggestion instead of duplicating it", async () => {
    const live = makeRoseyLive({ pool, cfg, generate });
    const g = await group(true);
    await deliver(live, g, "לקנות סוללות");
    await vi.waitFor(async () => {
      expect(await listTasks(pool, g.id, { includeClosed: true })).toHaveLength(1);
    });
    await deliver(live, g, "@Rosey לקנות סוללות");
    const tasks = await listTasks(pool, g.id, { includeClosed: true });
    expect(tasks.map((t) => [t.status, t.origin, t.statusSource])).toEqual([
      ["open", "suggested", "tag"],
    ]);
    live.stop();
  });

  it("stop() cancels a pending suggestion pass", async () => {
    generate.mockClear();
    const live = makeRoseyLive({ pool, cfg: { ...cfg, suggestDebounceMs: 50 }, generate });
    const g = await group(true);
    await deliver(live, g, "לנקות את המחסן");
    live.stop();
    await new Promise((r) => setTimeout(r, 120));
    expect(generate).not.toHaveBeenCalled();
    expect(await listTasks(pool, g.id, { includeClosed: true })).toEqual([]);
  });
});
