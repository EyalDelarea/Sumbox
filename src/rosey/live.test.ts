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
import { listTasks } from "../db/repositories/rosey-tasks.js";
import { createTestDatabase } from "../test/db.js";
import { loadRoseyConfig } from "./config.js";
import { DEDUP_SYSTEM } from "./dedup.js";
import { makeRoseyLive, roseyLiveFromEnv } from "./live.js";
import { setRoseyEnabled } from "./run.js";

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
  if (enabled) await setRoseyEnabled(pool, id, true); // as `rosey enable` does
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

  it("one group's pass never forgets what the live path decided in another", async () => {
    const live = makeRoseyLive({ pool, cfg, generate });
    const a = await group(true);
    const b = await group(true);
    await deliver(live, a, "@Rosey בוצע לתקן מזגן"); // A: nothing to close yet
    await deliver(live, a, "@Rosey לתקן מזגן");
    await deliver(live, b, "צריך לקנות מסנן"); // B's pass runs and advances B's cursor
    await vi.waitFor(async () => {
      expect(await listTasks(pool, b.id, { includeClosed: true })).toHaveLength(1);
    });
    await deliver(live, a, "צריך לקנות נורה"); // now A's pass
    await vi.waitFor(async () => {
      expect(await listTasks(pool, a.id, { includeClosed: true })).toHaveLength(2);
    });
    const tasks = await listTasks(pool, a.id, { includeClosed: true });
    expect(tasks.find((t) => t.title === "לתקן מזגן")?.status).toBe("open");
    live.stop();
  });

  it("a quoted command that fails before its apply is never replayed without its quote", async () => {
    const boom = `WA-${randomUUID()}`;
    const flakyPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === "query") {
          return (...args: Parameters<pg.Pool["query"]>) => {
            const params = args[1] as unknown[] | undefined;
            if (Array.isArray(params) && params.includes(boom)) {
              return Promise.reject(new Error("db blip"));
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const live = makeRoseyLive({ pool: flakyPool, cfg, generate });
    const g = await group(true);
    await expect(deliver(live, g, "@Rosey לתקן מזגן", boom)).rejects.toThrow("db blip");
    await deliver(live, g, "צריך לקנות מסנן"); // schedules the pass
    await vi.waitFor(async () => {
      expect(await listTasks(pool, g.id, { includeClosed: true })).toHaveLength(1);
    });
    // The pass ran (its suggestion is stored) and did not replay the command:
    // without its quote it could act on a task the sender never pointed at.
    const tasks = await listTasks(pool, g.id, { includeClosed: true });
    expect(tasks.map((t) => t.origin)).toEqual(["suggested"]);
    live.stop();
  });

  it("a pass never replays a command the live path is still handling", async () => {
    const slowId = `WA-${randomUUID()}`;
    const slowPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === "query") {
          return async (...args: Parameters<pg.Pool["query"]>) => {
            const params = args[1] as unknown[] | undefined;
            if (Array.isArray(params) && params.includes(slowId)) {
              await new Promise((r) => setTimeout(r, 300));
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const passes: { commands: number }[] = [];
    const log = {
      info: (obj: unknown, msg?: string) => {
        if (msg?.startsWith("rosey: suggestion pass")) {
          passes.push((obj as { tagged: { commands: number } }).tagged);
        }
      },
      warn: () => {},
      error: () => {},
    };
    const live = makeRoseyLive({ pool: slowPool, cfg, generate, log });
    const g = await group(true);
    await deliver(live, g, "צריך לקנות מסנן"); // its pass fires in 20 ms
    const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await ingest(g.id, slowId, "@Rosey לתקן מזגן", sentAt);
    // In flight for 300 ms (slow lookups) while the pass reads it.
    await live.onMessage(wa(g.jid, slowId, "@Rosey לתקן מזגן", sentAt));
    await vi.waitFor(() => expect(passes.length).toBeGreaterThan(0));
    expect(passes[0]!.commands).toBe(0); // the live path applied it, once
    const tags = (await listTasks(pool, g.id, { includeClosed: true })).filter(
      (t) => t.origin === "tag",
    );
    expect(tags.map((t) => t.title)).toEqual(["לתקן מזגן"]);
    live.stop();
  });

  describe("a command that lands while a pass is running, already ingested, then fails", () => {
    /**
     * The pass is paused after it read the messages (and took its cursor), the
     * command arrives, and the pass skips it as still being handled. Then its
     * handling fails: after the pass, for an apply queued behind it; or while
     * the pass is still suggesting, for a slow lookup that throws, or a slow
     * allowlist read that fails (closed). Either way the cursor must not move
     * past it, or the catch-up never sees it.
     */
    async function run(failure: "apply" | "lookup" | "allowlist") {
      const cmdId = `WA-${randomUUID()}`;
      let failLookup = false;
      let failAllowlist = false;
      let pause: Promise<void> | null = null;
      let paused = false;
      let resume!: () => void;
      let failInsert = failure === "apply";
      let cmdRow = -1;
      const wrapQuery =
        (query: (...a: unknown[]) => unknown) =>
        async (...args: unknown[]) => {
          const sql = String(args[0]);
          const params = args[1] as unknown[] | undefined;
          if (pause && sql.includes("FROM rosey_task_events")) {
            const p = pause;
            pause = null;
            paused = true;
            await p;
          }
          const slowFail =
            (failLookup && Array.isArray(params) && params.includes(cmdId)) ||
            (failAllowlist && sql.includes("group_command_permissions"));
          if (slowFail) {
            failLookup = failAllowlist = false;
            await new Promise((r) => setTimeout(r, 100)); // outlives the command loop
            throw new Error("db blip");
          }
          // The command's own task insert, not the pass's suggestions.
          if (failInsert && sql.includes("INSERT INTO rosey_tasks") && params?.includes(cmdRow)) {
            failInsert = false;
            throw new Error("db blip");
          }
          return query(...args);
        };
      const flakyPool = new Proxy(pool, {
        get(target, prop) {
          if (prop === "query") return wrapQuery(target.query.bind(target) as never);
          if (prop === "connect") {
            return async () => {
              const client = await target.connect();
              (client as { query: unknown }).query = wrapQuery(client.query.bind(client) as never);
              return client;
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      // The pass's suggestion step waits until the command's handling settled.
      let settled: Promise<unknown> = Promise.resolve();
      const slowGenerate = async (system: string, user: string) => {
        if (system !== DEDUP_SYSTEM) await settled;
        return generate(system, user);
      };
      const live = makeRoseyLive({ pool: flakyPool, cfg, generate: slowGenerate });
      const g = await group(true);
      const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      cmdRow = await ingest(g.id, cmdId, "@Rosey לתקן מזגן", sentAt); // before the pass reads

      pause = new Promise((r) => (resume = r));
      await deliver(live, g, "צריך לקנות מסנן"); // its pass reads, then pauses
      await vi.waitFor(() => expect(paused).toBe(true));
      failLookup = failure === "lookup";
      failAllowlist = failure === "allowlist";
      const handled = live
        .onMessage(wa(g.jid, cmdId, "@Rosey לתקן מזגן", sentAt))
        .catch((e: unknown) => e);
      if (failure !== "apply") settled = handled;
      await new Promise((r) => setTimeout(r, 20));
      resume();
      // A failed allowlist read is caught (fail closed); the others throw.
      const outcome = await handled;
      if (failure === "allowlist") expect(outcome).toBeUndefined();
      else expect(outcome).toBeInstanceOf(Error);

      await deliver(live, g, "צריך לקנות נורה"); // the next pass
      await vi.waitFor(async () => {
        const tags = (await listTasks(pool, g.id, { includeClosed: true })).filter(
          (t) => t.origin === "tag",
        );
        expect(tags.map((t) => t.title)).toEqual(["לתקן מזגן"]);
      });
      live.stop();
    }

    it("its apply, queued behind the pass, throws: the next pass replays it", () => run("apply"));
    it("its lookup throws during the pass: the next pass replays it", () => run("lookup"));
    it("its allowlist read fails during the pass: the next pass replays it", () =>
      run("allowlist"));
  });

  it("a second delivery of the same WhatsApp message is handled once", async () => {
    const applied: unknown[] = [];
    const log = {
      info: (obj: unknown, msg?: string) => {
        if (msg === "rosey: command applied") applied.push(obj);
      },
      warn: () => {},
      error: () => {},
    };
    const live = makeRoseyLive({ pool, cfg, generate, log });
    const g = await group(true);
    const externalId = `WA-${randomUUID()}`;
    const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await ingest(g.id, externalId, "@Rosey לקנות חלב", sentAt);
    const msg = wa(g.jid, externalId, "@Rosey לקנות חלב", sentAt);
    await Promise.all([live.onMessage(msg), live.onMessage(msg)]);
    await live.onMessage(msg);
    expect(applied).toHaveLength(1);
    live.stop();
  });

  it("a command that arrives well after a pass began does not hold its cursor", async () => {
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
    const passes: boolean[] = [];
    const log = {
      info: (obj: unknown, msg?: string) => {
        if (msg?.startsWith("rosey: suggestion pass")) {
          passes.push((obj as { cursorAdvanced: boolean }).cursorAdvanced);
        }
      },
      warn: () => {},
      error: () => {},
    };
    const live = makeRoseyLive({
      pool,
      cfg,
      generate: slowModel,
      log,
      registrationSlackMs: 0,
    });
    const g = await group(true);
    await deliver(live, g, "צריך לסדר את הארון");
    await vi.waitFor(() => expect(passStarted).toBe(true));
    // Ingested after the pass took its cursor: the cursor can never pass it.
    const pending = deliver(live, g, "@Rosey לקנות נורות"); // queued behind the pass
    await new Promise((r) => setTimeout(r, 30));
    release();
    await pending;
    await vi.waitFor(() => expect(passes).toEqual([true]));
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
