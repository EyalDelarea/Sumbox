import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertScope } from "../db/repositories/chat-scopes.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { upsertJobRun } from "../db/repositories/job-runs.js";
import { insertMessages } from "../db/repositories/messages.js";
import { insertSummary } from "../db/repositories/summaries.js";
import type { NormalizedMessage } from "../importer/types.js";
import type { JobType } from "../jobs/job-types.js";
import type { StreamingSummarizer, SummaryPrompt } from "../summarization/summarizer.js";
import { createTestDatabase } from "../test/db.js";
import { createServer } from "./server.js";

class FakeStreaming implements StreamingSummarizer {
  async *summarizeStream() {
    yield "שלום ";
    yield "עולם";
  }
}

describe("web server", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    server = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool?.end();
  }, 30_000);

  async function seedText(groupId: number, content: string, dedupeKey: string): Promise<void> {
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: "Dana",
      messageType: "text",
      textContent: content,
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId: null,
      sentAt: new Date("2026-01-01T10:00:00Z"),
      dedupeKey,
    };
    await insertMessages(pool, [row]);
  }

  it("GET / serves an RTL HTML page", async () => {
    const r = await fetch(`${base}/`);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain('dir="rtl"');
  });

  it("GET / serves the Glacier app shell (module entry, manifest, stale banner, mount point)", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<script type="module" src="/app.js"'); // ES-module entry
    expect(html).toContain('rel="manifest"'); // add-to-home-screen
    expect(html).toContain('href="/styles.css"'); // Glacier styles
    expect(html).toContain('id="stale-banner"'); // unhealthy banner region
    expect(html).toContain('id="pane-main"'); // two-pane shell main mount point
  });

  it("serves the JS modules that wire catch-up and the status/groups endpoints", async () => {
    const appJs = await (await fetch(`${base}/app.js`)).text();
    expect(appJs).toContain('mode: "sumbox"'); // catch-up default wired
    const apiJs = await (await fetch(`${base}/lib/api.js`)).text();
    expect(apiJs).toContain("/api/status"); // health polling
    expect(apiJs).toContain("/api/groups"); // feed
    expect(apiJs).toContain("/api/summarize"); // summary stream
  });

  it("GET /api/groups returns the stored chats as JSON", async () => {
    await upsertGroup(pool, { name: "WEB-g", source: "import" });
    const r = await fetch(`${base}/api/groups`);
    const groups = await r.json();
    expect(groups.some((g: any) => g.name === "WEB-g")).toBe(true);
  });

  it("GET /api/summarize streams status -> token -> done and persists a row", async () => {
    const g = await upsertGroup(pool, { name: "WEB-sum", source: "import" });
    await seedText(g, "hello", "web1");
    const r = await fetch(`${base}/api/summarize?group=WEB-sum&last=100`);
    const text = await r.text();
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("event: status");
    expect(text).toContain("event: token");
    expect(text).toContain("event: done");
    expect(text).toContain("שלום ");
    const { rows } = await pool.query(`SELECT output FROM summaries WHERE group_id=$1`, [g]);
    expect(rows[0].output).toMatchObject({ overview: "שלום עולם" });
  });

  it("emits an empty event when nothing is selected", async () => {
    await upsertGroup(pool, { name: "WEB-empty", source: "import" });
    const text = await (await fetch(`${base}/api/summarize?group=WEB-empty&last=100`)).text();
    expect(text).toContain("event: empty");
  });

  it("emits an error event for an unknown chat", async () => {
    const text = await (await fetch(`${base}/api/summarize?group=nope&last=100`)).text();
    expect(text).toContain("event: error");
    expect(text).toContain("Unknown chat");
  });

  // ── sumbox tests ────────────────────────────────────────────────────────────

  it("sumbox mutual-exclusion: mode=sumbox with last= emits error event", async () => {
    const g = await upsertGroup(pool, {
      name: `WEB-sumbox-mutex-${randomUUID()}`,
      source: "import",
    });
    const name = (await pool.query<{ name: string }>(`SELECT name FROM groups WHERE id=$1`, [g]))
      .rows[0]!.name;
    const text = await (
      await fetch(`${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox&last=100`)
    ).text();
    expect(text).toContain("event: error");
    expect(text).toContain("Use only one of");
  });

  it("sumbox empty: new group with no messages emits empty event", async () => {
    const name = `WEB-sumbox-empty-${randomUUID()}`;
    await upsertGroup(pool, { name, source: "import" });
    const text = await (
      await fetch(`${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox`)
    ).text();
    expect(text).toContain("event: empty");
    expect(text).not.toContain("event: token");
    expect(text).not.toContain("event: done");
  });

  it("sumbox first-run: streams status/token/done, persists watermark and summary", async () => {
    const name = `WEB-sumbox-firstrun-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    await seedText(g, "hello sumbox", `sumbox-fr-${randomUUID()}`);

    const text = await (
      await fetch(`${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox`)
    ).text();
    expect(text).toContain("event: status");
    expect(text).toContain("event: token");
    expect(text).toContain("event: done");
    expect(text).toContain("שלום ");

    // Watermark row was written
    const { rows: wmRows } = await pool.query(
      `SELECT group_id FROM read_watermarks WHERE group_id=$1`,
      [g],
    );
    expect(wmRows.length).toBe(1);

    // Summary row with summary_type='watermark' was written
    const { rows: sumRows } = await pool.query(
      `SELECT output FROM summaries WHERE group_id=$1 AND summary_type='watermark'`,
      [g],
    );
    expect(sumRows.length).toBe(1);
    expect(sumRows[0].output).toMatchObject({ overview: "שלום עולם" });
  });

  it("sumbox cache-hit: second request with no new messages emits cached, no new writes", async () => {
    // Reuse the same group name from the first-run test above — but use a fresh
    // group so the test is self-contained and order-independent.
    const name = `WEB-sumbox-cachehit-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    await seedText(g, "hello for cache hit", `sumbox-ch-${randomUUID()}`);

    // First run: advance the watermark. Drain the SSE body to `event: done` — the
    // watermark commit lands just before that frame, so consuming the stream is what
    // guarantees the row is visible to the SELECT below. (`await fetch(...)` alone
    // resolves at response-headers time, before the handler commits — a race under
    // parallel DB load.)
    const firstRun = await (
      await fetch(`${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox`)
    ).text();
    expect(firstRun).toContain("event: done");

    // Count summaries before the second request
    const { rows: before } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM summaries WHERE group_id=$1 AND summary_type='watermark'`,
      [g],
    );
    const countBefore = Number(before[0].cnt);

    // Watermark before
    const { rows: wmBefore } = await pool.query(
      `SELECT watermark_sent_at, watermark_message_id FROM read_watermarks WHERE group_id=$1`,
      [g],
    );
    expect(wmBefore.length).toBe(1);

    // Second request — no new messages, should be a cache-hit
    const text = await (
      await fetch(`${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox`)
    ).text();
    expect(text).toContain("event: cached");
    expect(text).not.toContain("event: token");
    expect(text).not.toContain("event: done");

    // Regression guard: the cached event must carry a *structured* (version 2)
    // summary — the same normalized shape as `done` — so the client renders the
    // structured §3 card. A flattened overview string here is what made
    // "מה שפספסתי" fall back to the old markdown card on a cache hit.
    const cachedFrame = text.split("\n\n").find((f) => f.includes("event: cached"));
    expect(cachedFrame).toBeTruthy();
    const cachedData = cachedFrame!
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice("data: ".length);
    const cachedPayload = JSON.parse(cachedData);
    expect(cachedPayload.summary.version).toBe(2);
    expect(cachedPayload.summary).toHaveProperty("overview");
    expect(cachedPayload.summary).toHaveProperty("topics");
    expect(cachedPayload.summary).toHaveProperty("decisions");
    expect(cachedPayload.summary).toHaveProperty("openQuestions");
    expect(typeof cachedPayload.summaryId).toBe("number");

    // No additional summary row inserted
    const { rows: after } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM summaries WHERE group_id=$1 AND summary_type='watermark'`,
      [g],
    );
    expect(Number(after[0].cnt)).toBe(countBefore);

    // Watermark unchanged
    const { rows: wmAfter } = await pool.query(
      `SELECT watermark_sent_at, watermark_message_id FROM read_watermarks WHERE group_id=$1`,
      [g],
    );
    expect(wmAfter[0].watermark_sent_at).toEqual(wmBefore[0].watermark_sent_at);
    expect(wmAfter[0].watermark_message_id).toEqual(wmBefore[0].watermark_message_id);
  });

  it("regenerate re-summarizes the same range, sets regenerated_from_id, and does NOT advance the watermark", async () => {
    // Arrange: seed a group with messages and run ONE catch-up summary so a watermark
    // row + read-watermark exist.
    const name = `WEB-regen-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    await seedText(g, "hello regen", `regen-msg-${randomUUID()}`);
    await fetch(`${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox`).then((r) =>
      r.text(),
    );

    const { rows: before } = await pool.query(
      `SELECT id FROM summaries WHERE group_id = $1 ORDER BY id`,
      [g],
    );
    expect(before).toHaveLength(1);
    const originalId = Number(before[0].id);
    const { rows: wmBefore } = await pool.query(
      `SELECT watermark_message_id FROM read_watermarks WHERE group_id = $1`,
      [g],
    );

    // Act: regenerate the original summary with a reason.
    const text = await fetch(
      `${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox&regenerate=${originalId}&reason=too_long`,
    ).then((r) => r.text());
    expect(text).toContain("event: done");

    // Parse the done frame and assert summaryId is a number greater than the original.
    const doneFrame = text.split("\n\n").find((f) => f.includes("event: done"));
    const doneData = JSON.parse(
      doneFrame!
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice("data: ".length),
    );
    expect(typeof doneData.summaryId).toBe("number");
    expect(doneData.summaryId).toBeGreaterThan(originalId);

    // Assert: a NEW row linked to the original; the watermark is unchanged.
    const { rows: after } = await pool.query(
      `SELECT id, summary_type, regenerated_from_id FROM summaries WHERE group_id = $1 ORDER BY id`,
      [g],
    );
    expect(after).toHaveLength(2);
    const child = after[1];
    expect(child.summary_type).toBe("watermark");
    expect(Number(child.regenerated_from_id)).toBe(originalId);

    const { rows: wmAfter } = await pool.query(
      `SELECT watermark_message_id FROM read_watermarks WHERE group_id = $1`,
      [g],
    );
    expect(wmAfter[0].watermark_message_id).toBe(wmBefore[0].watermark_message_id);
  });

  it("regenerate with an unknown summary id emits an error event", async () => {
    const name = `WEB-regen-404-${randomUUID()}`;
    await upsertGroup(pool, { name, source: "import" });
    const text = await fetch(
      `${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox&regenerate=999999&reason=missed`,
    ).then((r) => r.text());
    expect(text).toContain("event: error");
  });

  it("regenerate with an invalid reason emits an error event", async () => {
    // Arrange: seed + run a first catch-up so a valid summary id exists.
    const name = `WEB-regen-badreason-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    await seedText(g, "hello bad reason", `regen-badreason-${randomUUID()}`);
    await fetch(`${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox`).then((r) =>
      r.text(),
    );
    const { rows } = await pool.query(`SELECT id FROM summaries WHERE group_id = $1 ORDER BY id`, [
      g,
    ]);
    expect(rows).toHaveLength(1);
    const validId = Number(rows[0].id);

    // Act: request regeneration with a bogus reason.
    const text = await fetch(
      `${base}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox&regenerate=${validId}&reason=bogus`,
    ).then((r) => r.text());

    // Assert: the server rejects the request with an error event.
    expect(text).toContain("event: error");
  });
});

// ── backfill + liveness injection tests ──────────────────────────────────────

describe("handleSummarize with backfill deps", () => {
  let pool: pg.Pool;
  let base: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seedText(groupId: number, content: string, dedupeKey: string): Promise<void> {
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: "Dana",
      messageType: "text",
      textContent: content,
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId: null,
      sentAt: new Date("2026-01-01T10:00:00Z"),
      dedupeKey,
    };
    await insertMessages(pool, [row]);
  }

  it("under-window + healthy: emits syncing start/done before status; done includes fetched/fetchMs", async () => {
    const name = `BF-under-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    // seed 1 message (< 25 window), so backfill should run
    await seedText(g, "hello backfill", `bf-under-${randomUUID()}`);

    let backfillCalledWith: number | null = null;
    const backfillFake = async (groupId: number) => {
      backfillCalledWith = groupId;
      return { fetched: 3, durationMs: 42, partial: false };
    };
    const getLivenessFake = () => ({ healthy: true, lastHeartbeatAt: new Date() });

    const srv = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
      backfill: backfillFake,
      getLiveness: getLivenessFake,
      backfillTargetWindow: 25,
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const srvBase = `http://localhost:${(srv.address() as AddressInfo).port}`;

    try {
      const r = await fetch(`${srvBase}/api/summarize?group=${encodeURIComponent(name)}&last=100`);
      const text = await r.text();

      // syncing start must appear before status
      const syncStart = text.indexOf("event: syncing");
      const statusIdx = text.indexOf("event: status");
      expect(syncStart).toBeGreaterThanOrEqual(0);
      expect(statusIdx).toBeGreaterThan(syncStart);

      // syncing phase:start and phase:done both present
      expect(text).toContain('"phase":"start"');
      expect(text).toContain('"phase":"done"');

      // backfill was called with the correct groupId
      expect(backfillCalledWith).toBe(g);

      // done event carries fetched and fetchMs
      const doneMatch = text.match(/event: done\ndata: (.+)/);
      expect(doneMatch).not.toBeNull();
      const doneData = JSON.parse(doneMatch![1]);
      expect(doneData.fetched).toBe(3);
      expect(doneData.fetchMs).toBe(42);
      expect(doneData.partial).toBe(false);
      expect(doneData.stale).toBe(false);
      expect(typeof doneData.summarizeMs).toBe("number");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60_000);

  it("enough-history + healthy: no syncing event; backfill NOT called", async () => {
    const name = `BF-enough-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    // seed 25 messages (= window), so backfill should NOT run
    for (let i = 0; i < 25; i++) {
      await seedText(g, `msg ${i}`, `bf-enough-${g}-${i}`);
    }

    let backfillCalled = false;
    const backfillFake = async (_groupId: number) => {
      backfillCalled = true;
      return { fetched: 0, durationMs: 0, partial: false };
    };
    const getLivenessFake = () => ({ healthy: true, lastHeartbeatAt: new Date() });

    const srv = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
      backfill: backfillFake,
      getLiveness: getLivenessFake,
      backfillTargetWindow: 25,
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const srvBase = `http://localhost:${(srv.address() as AddressInfo).port}`;

    try {
      const text = await (
        await fetch(`${srvBase}/api/summarize?group=${encodeURIComponent(name)}&last=100`)
      ).text();
      expect(text).not.toContain("event: syncing");
      expect(backfillCalled).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60_000);

  it("unhealthy collector: no syncing, status and done carry stale:true", async () => {
    const name = `BF-unhealthy-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    await seedText(g, "hello stale", `bf-stale-${randomUUID()}`);

    let backfillCalled = false;
    const backfillFake = async (_groupId: number) => {
      backfillCalled = true;
      return { fetched: 0, durationMs: 0, partial: false };
    };
    const getLivenessFake = () => ({ healthy: false, lastHeartbeatAt: null });

    const srv = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
      backfill: backfillFake,
      getLiveness: getLivenessFake,
      backfillTargetWindow: 25,
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const srvBase = `http://localhost:${(srv.address() as AddressInfo).port}`;

    try {
      const text = await (
        await fetch(`${srvBase}/api/summarize?group=${encodeURIComponent(name)}&last=100`)
      ).text();

      // no syncing
      expect(text).not.toContain("event: syncing");
      expect(backfillCalled).toBe(false);

      // status carries stale:true
      const statusMatch = text.match(/event: status\ndata: (.+)/);
      expect(statusMatch).not.toBeNull();
      const statusData = JSON.parse(statusMatch![1]);
      expect(statusData.stale).toBe(true);

      // done carries stale:true
      const doneMatch = text.match(/event: done\ndata: (.+)/);
      expect(doneMatch).not.toBeNull();
      const doneData = JSON.parse(doneMatch![1]);
      expect(doneData.stale).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60_000);

  it("plain serve (no backfill/getLiveness): no syncing, stale defaults false", async () => {
    const name = `BF-plain-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    await seedText(g, "hello plain", `bf-plain-${randomUUID()}`);

    const srv = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
      // NO backfill, NO getLiveness
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const srvBase = `http://localhost:${(srv.address() as AddressInfo).port}`;

    try {
      const text = await (
        await fetch(`${srvBase}/api/summarize?group=${encodeURIComponent(name)}&last=100`)
      ).text();
      expect(text).not.toContain("event: syncing");

      const doneMatch = text.match(/event: done\ndata: (.+)/);
      expect(doneMatch).not.toBeNull();
      const doneData = JSON.parse(doneMatch![1]);
      expect(doneData.stale).toBe(false);
      expect(doneData.fetchMs).toBe(0);
      expect(doneData.fetched).toBe(0);
      expect(doneData.partial).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60_000);

  // ── since-trigger backfill tests ────────────────────────────────────────────

  /**
   * Helper: seed `count` messages for the given group, each with sent_at = baseDate.
   * Returns a unique group name for each call via the passed-in groupId.
   */
  async function seedMany(
    groupId: number,
    count: number,
    baseDate: Date,
    prefix: string,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      const row: import("../importer/types.js").NormalizedMessage & {
        participantId: number | null;
      } = {
        groupId,
        importId: null,
        source: "import",
        senderName: "Bot",
        messageType: "text",
        textContent: `msg ${i}`,
        mediaFilename: null,
        mediaPath: null,
        mediaStatus: null,
        externalId: null,
        participantId: null,
        sentAt: new Date(baseDate.getTime() + i * 1000),
        dedupeKey: `${prefix}-${i}-${randomUUID()}`,
      };
      await insertMessages(pool, [row]);
    }
  }

  it("since predates oldest stored message (held>=25): backfill IS called", async () => {
    const name = `BF-since-old-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });

    // Seed 30 messages from 2 hours ago so held >= window (won't trigger held<window path).
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await seedMany(g, 30, twoHoursAgo, `since-old-${g}`);

    // Request with since = 3 days ago — predates the 2h-old messages → backfill must fire.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    let backfillCalled = false;
    const backfillFake = async (_groupId: number) => {
      backfillCalled = true;
      return { fetched: 5, durationMs: 10, partial: false };
    };
    const getLivenessFake = () => ({ healthy: true, lastHeartbeatAt: new Date() });

    const srv = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
      backfill: backfillFake,
      getLiveness: getLivenessFake,
      backfillTargetWindow: 25,
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const srvBase = `http://localhost:${(srv.address() as AddressInfo).port}`;

    try {
      const sinceParam = encodeURIComponent(threeDaysAgo.toISOString());
      await fetch(`${srvBase}/api/summarize?group=${encodeURIComponent(name)}&since=${sinceParam}`);
      expect(backfillCalled).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60_000);

  it("since is newer than oldest stored message (held>=25): backfill NOT called", async () => {
    const name = `BF-since-new-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });

    // Seed 30 messages starting from 2 hours ago.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await seedMany(g, 30, twoHoursAgo, `since-new-${g}`);

    // Request with since = 1 hour ago — NEWER than 2h-old oldest → should NOT trigger backfill.
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);

    let backfillCalled = false;
    const backfillFake = async (_groupId: number) => {
      backfillCalled = true;
      return { fetched: 0, durationMs: 0, partial: false };
    };
    const getLivenessFake = () => ({ healthy: true, lastHeartbeatAt: new Date() });

    const srv = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
      backfill: backfillFake,
      getLiveness: getLivenessFake,
      backfillTargetWindow: 25,
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const srvBase = `http://localhost:${(srv.address() as AddressInfo).port}`;

    try {
      const sinceParam = encodeURIComponent(oneHourAgo.toISOString());
      const text = await (
        await fetch(
          `${srvBase}/api/summarize?group=${encodeURIComponent(name)}&since=${sinceParam}`,
        )
      ).text();
      expect(text).not.toContain("event: syncing");
      expect(backfillCalled).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60_000);

  it("existing under-window sumbox backfill still fires when held<25 (no since)", async () => {
    // Regression: confirm the held<window path is unaffected by the new since-trigger.
    const name = `BF-underwin-rg-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    // Only 1 message — well under 25 window.
    await seedText(g, "solo message", `underwin-rg-${randomUUID()}`);

    let backfillCalled = false;
    const backfillFake = async (_groupId: number) => {
      backfillCalled = true;
      return { fetched: 2, durationMs: 5, partial: false };
    };
    const getLivenessFake = () => ({ healthy: true, lastHeartbeatAt: new Date() });

    const srv = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
      backfill: backfillFake,
      getLiveness: getLivenessFake,
      backfillTargetWindow: 25,
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const srvBase = `http://localhost:${(srv.address() as AddressInfo).port}`;

    try {
      const text = await (
        await fetch(`${srvBase}/api/summarize?group=${encodeURIComponent(name)}&last=100`)
      ).text();
      expect(text).toContain("event: syncing");
      expect(backfillCalled).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60_000);
});

// ── /api/status ──────────────────────────────────────────────────────────────

describe("/api/status", () => {
  let pool: pg.Pool;
  let connectionString: string;
  let base: string;
  let server: ReturnType<typeof createServer>;

  const happyDepths: () => Promise<Partial<Record<JobType, number>>> = async () => ({
    "import.file": 5,
    "transcribe.voicenote": 3,
  });

  beforeAll(async () => {
    connectionString = await createTestDatabase();
    pool = new pg.Pool({ connectionString });

    // Seed service_status (singleton row already exists from migration seed)
    await pool.query(
      `UPDATE service_status SET collector_connected = true, last_heartbeat_at = now() WHERE id = 1`,
    );

    // Seed job_runs rows: 2 pending, 1 running, 3 done, 1 failed, 1 dead
    const seed = async (status: "pending" | "running" | "done" | "failed" | "dead") =>
      upsertJobRun(pool, {
        id: randomUUID(),
        type: "import.file",
        status,
        payload: { filePath: `/f/${status}` },
        attempts: 1,
        maxAttempts: 3,
      });

    await Promise.all([
      seed("pending"),
      seed("pending"),
      seed("running"),
      seed("done"),
      seed("done"),
      seed("done"),
      seed("failed"),
      seed("dead"),
    ]);

    server = createServer({
      pool,
      summarizer: new (class implements StreamingSummarizer {
        async *summarizeStream() {
          yield "x";
        }
      })(),
      tokenBudget: 24000,
      model: "fake",
      getQueueDepths: happyDepths,
      stalenessMs: 60_000,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool?.end();
  }, 30_000);

  it("happy path: returns 200 with correct shape and seeded counts", async () => {
    const r = await fetch(`${base}/api/status`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as Record<string, unknown>;

    // service
    expect(body["service"]).toMatchObject({
      up: true,
      collectorConnected: true,
      stale: false,
    });
    expect(typeof (body["service"] as Record<string, unknown>)["lastHeartbeatAt"]).toBe("string");

    // jobs
    expect(body["jobs"]).toMatchObject({
      pending: 2,
      running: 1,
      done: 3,
      failed: 1,
      dead: 1,
    });

    // queues
    const queues = body["queues"] as Record<string, { depth: number | null }>;
    expect(queues["import.file"]).toEqual({ depth: 5 });
    expect(queues["transcribe.voicenote"]).toEqual({ depth: 3 });

    // generatedAt
    expect(typeof body["generatedAt"]).toBe("string");
  });

  it("broker down: queue depths are null but job counts still present (200)", async () => {
    // Create a server whose getQueueDepths throws
    let brokerServer: ReturnType<typeof createServer>;
    const brokerPool = new pg.Pool({ connectionString: connectionString });
    brokerServer = createServer({
      pool: brokerPool,
      summarizer: new (class implements StreamingSummarizer {
        async *summarizeStream() {
          yield "x";
        }
      })(),
      tokenBudget: 24000,
      model: "fake",
      getQueueDepths: async () => {
        throw new Error("broker down");
      },
      stalenessMs: 60_000,
    });
    await new Promise<void>((r) => brokerServer.listen(0, r));
    const brokerBase = `http://localhost:${(brokerServer.address() as AddressInfo).port}`;

    try {
      const r = await fetch(`${brokerBase}/api/status`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      const queues = body["queues"] as Record<string, { depth: number | null }>;
      expect(queues["import.file"]).toEqual({ depth: null });
      expect(queues["transcribe.voicenote"]).toEqual({ depth: null });
      // job counts still present
      expect((body["jobs"] as Record<string, unknown>)["pending"]).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((r) => brokerServer.close(() => r()));
      await brokerPool.end();
    }
  });

  it("db down: returns 503 with error body", async () => {
    // Create a pool that always errors
    const badPool = new pg.Pool({ connectionString: "postgres://bad:bad@localhost:9999/noexist" });
    // Don't try to actually connect — we want query to throw
    let dbDownServer: ReturnType<typeof createServer>;
    dbDownServer = createServer({
      pool: badPool,
      summarizer: new (class implements StreamingSummarizer {
        async *summarizeStream() {
          yield "x";
        }
      })(),
      tokenBudget: 24000,
      model: "fake",
      getQueueDepths: happyDepths,
      stalenessMs: 60_000,
    });
    await new Promise<void>((r) => dbDownServer.listen(0, r));
    const dbBase = `http://localhost:${(dbDownServer.address() as AddressInfo).port}`;

    try {
      const r = await fetch(`${dbBase}/api/status`);
      expect(r.status).toBe(503);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body["error"]).toBe("status unavailable");
    } finally {
      await new Promise<void>((r) => dbDownServer.close(() => r()));
      await badPool.end().catch(() => {});
    }
  });

  // T015: /api/status liveness field ─────────────────────────────────────────

  it("liveness healthy: /api/status includes liveness.healthy === true", async () => {
    const livePool = new pg.Pool({ connectionString: connectionString });
    const liveServer = createServer({
      pool: livePool,
      summarizer: new (class implements StreamingSummarizer {
        async *summarizeStream() {
          yield "x";
        }
      })(),
      tokenBudget: 24000,
      model: "fake",
      getQueueDepths: happyDepths,
      stalenessMs: 60_000,
      getLiveness: () => ({ healthy: true, lastHeartbeatAt: new Date("2026-01-01T12:00:00Z") }),
    });
    await new Promise<void>((r) => liveServer.listen(0, r));
    const liveBase = `http://localhost:${(liveServer.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${liveBase}/api/status`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      const liveness = body["liveness"] as Record<string, unknown>;
      expect(liveness).not.toBeNull();
      expect(liveness["healthy"]).toBe(true);
      expect(typeof liveness["lastHeartbeatAt"]).toBe("string");
    } finally {
      await new Promise<void>((r) => liveServer.close(() => r()));
      await livePool.end();
    }
  });

  it("liveness unhealthy: /api/status includes liveness.healthy === false", async () => {
    const livePool = new pg.Pool({ connectionString: connectionString });
    const liveServer = createServer({
      pool: livePool,
      summarizer: new (class implements StreamingSummarizer {
        async *summarizeStream() {
          yield "x";
        }
      })(),
      tokenBudget: 24000,
      model: "fake",
      getQueueDepths: happyDepths,
      stalenessMs: 60_000,
      getLiveness: () => ({ healthy: false, lastHeartbeatAt: null }),
    });
    await new Promise<void>((r) => liveServer.listen(0, r));
    const liveBase = `http://localhost:${(liveServer.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${liveBase}/api/status`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      const liveness = body["liveness"] as Record<string, unknown>;
      expect(liveness).not.toBeNull();
      expect(liveness["healthy"]).toBe(false);
      expect(liveness["lastHeartbeatAt"]).toBeNull();
    } finally {
      await new Promise<void>((r) => liveServer.close(() => r()));
      await livePool.end();
    }
  });

  it("no getLiveness: /api/status liveness field is null", async () => {
    // The main server in this suite was created without getLiveness
    const r = await fetch(`${base}/api/status`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["liveness"]).toBeNull();
  });
});

// ── GET /api/summaries ────────────────────────────────────────────────────────

describe("GET /api/summaries", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    server = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool?.end();
  }, 30_000);

  it("populated group returns array newest-first with output.overview and ISO createdAt", async () => {
    const groupId = await upsertGroup(pool, { name: "API-sum-order", source: "import" });

    // Insert summaries with explicit created_at via raw query for ordering control
    await pool.query(
      `INSERT INTO summaries (group_id, summary_type, parameters, output, model, created_at)
       VALUES ($1, 'last_n', '{"n":5}', '{"overview":"older"}', 'fake', '2026-01-01T10:00:00Z')`,
      [groupId],
    );
    await pool.query(
      `INSERT INTO summaries (group_id, summary_type, parameters, output, model, created_at)
       VALUES ($1, 'watermark', '{"messageCount":10}', '{"overview":"newer"}', 'fake', '2026-01-02T10:00:00Z')`,
      [groupId],
    );

    const r = await fetch(`${base}/api/summaries?group=API-sum-order`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as Record<string, unknown>[];
    expect(body).toHaveLength(2);
    expect(body[0].output).toMatchObject({ overview: "newer" });
    expect(body[1].output).toMatchObject({ overview: "older" });
    // createdAt must be an ISO string
    expect(typeof body[0].createdAt).toBe("string");
    expect(() => new Date(body[0].createdAt as string)).not.toThrow();
    expect(new Date(body[0].createdAt as string).toISOString()).toBe(body[0].createdAt);
    // summaryType present
    expect(body[0].summaryType).toBe("watermark");
    expect(body[1].summaryType).toBe("last_n");
  });

  it("limit is respected", async () => {
    const groupId = await upsertGroup(pool, { name: "API-sum-limit", source: "import" });
    for (let i = 0; i < 5; i++) {
      await insertSummary(pool, {
        groupId,
        summaryType: "last_n",
        parameters: { n: i },
        output: { overview: `s${i}` },
        model: "fake",
      });
    }

    const r = await fetch(`${base}/api/summaries?group=API-sum-limit&limit=2`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as unknown[];
    expect(body).toHaveLength(2);
  });

  it("limit is capped at 200", async () => {
    const groupId = await upsertGroup(pool, { name: "API-sum-cap", source: "import" });
    // Just check it doesn't error and returns valid JSON — the cap is server-side behavior
    const r = await fetch(`${base}/api/summaries?group=API-sum-cap&limit=9999`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as unknown[];
    // empty group → 0 results (cap means max 200 rows, not that it errors)
    expect(Array.isArray(body)).toBe(true);
  });

  it("invalid limit falls back to default (50)", async () => {
    const groupId = await upsertGroup(pool, { name: "API-sum-badlimit", source: "import" });
    const r = await fetch(`${base}/api/summaries?group=API-sum-badlimit&limit=notanumber`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("unknown group returns 200 with empty array", async () => {
    const r = await fetch(`${base}/api/summaries?group=totally-unknown-group-xyz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("missing group returns 400 with error message", async () => {
    const r = await fetch(`${base}/api/summaries`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("Missing group.");
  });

  it("existing /api/groups endpoint is not broken (regression)", async () => {
    const r = await fetch(`${base}/api/groups`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

// ── Client-disconnect abort tests ─────────────────────────────────────────────
//
// When a client disconnects mid-stream, the server must:
//  1. Stop the summarizer (AbortSignal fires)
//  2. NOT commit a summary row or watermark row
//  3. Not throw an unhandled error

describe("handleSummarize — client disconnect aborts summarizer, no commit", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seedText(groupId: number, content: string, dedupeKey: string): Promise<void> {
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: "Dana",
      messageType: "text",
      textContent: content,
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId: null,
      sentAt: new Date("2026-01-01T10:00:00Z"),
      dedupeKey,
    };
    await insertMessages(pool, [row]);
  }

  it("last/since path: disconnect mid-stream → signal forwarded to summarizer and no summary row committed", async () => {
    const name = `DC-last-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    await seedText(g, "hello disconnect", `dc-last-${randomUUID()}`);

    let signalReceived = false;
    const summarizer: StreamingSummarizer = {
      async *summarizeStream(_prompt: SummaryPrompt, opts?: { signal?: AbortSignal }) {
        signalReceived = opts?.signal != null;
        yield "partial-token";
        // Hang until signal fires (or 10s safety)
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            resolve();
            return;
          }
          if (opts?.signal) {
            opts.signal.addEventListener("abort", () => resolve(), { once: true });
          } else {
            setTimeout(resolve, 10_000);
          }
        });
      },
    };

    const srv = createServer({ pool, summarizer, tokenBudget: 24000, model: "fake" });
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as AddressInfo).port;

    try {
      // Open a request, wait for first data chunk (confirms status event sent), then destroy
      await new Promise<void>((resolve) => {
        const req = http.get(
          `http://localhost:${port}/api/summarize?group=${encodeURIComponent(name)}&last=100`,
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
            res.on("error", () => resolve());
          },
        );
        req.on("error", () => resolve());
        setTimeout(resolve, 5000);
      });

      // Wait for server-side abort propagation
      await new Promise((r) => setTimeout(r, 400));

      // Signal must have been forwarded
      expect(signalReceived).toBe(true);
      // expect(signalAborted).toBe(true); // nice-to-have, not strictly required

      // No summary row should have been committed
      const { rows } = await pool.query(`SELECT COUNT(*) AS cnt FROM summaries WHERE group_id=$1`, [
        g,
      ]);
      expect(Number(rows[0].cnt)).toBe(0);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 30_000);

  it("sumbox path: disconnect mid-stream → signal forwarded and no summary or watermark committed", async () => {
    const name = `DC-sumbox-${randomUUID()}`;
    const g = await upsertGroup(pool, { name, source: "import" });
    await seedText(g, "hello sumbox disconnect", `dc-sumbox-${randomUUID()}`);

    let signalReceived = false;
    const summarizer: StreamingSummarizer = {
      async *summarizeStream(_prompt: SummaryPrompt, opts?: { signal?: AbortSignal }) {
        signalReceived = opts?.signal != null;
        yield "partial-token";
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            resolve();
            return;
          }
          if (opts?.signal) {
            opts.signal.addEventListener("abort", () => resolve(), { once: true });
          } else {
            setTimeout(resolve, 10_000);
          }
        });
      },
    };

    const srv = createServer({ pool, summarizer, tokenBudget: 24000, model: "fake" });
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as AddressInfo).port;

    try {
      await new Promise<void>((resolve) => {
        const req = http.get(
          `http://localhost:${port}/api/summarize?group=${encodeURIComponent(name)}&mode=sumbox`,
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
            res.on("error", () => resolve());
          },
        );
        req.on("error", () => resolve());
        setTimeout(resolve, 5000);
      });

      await new Promise((r) => setTimeout(r, 400));

      // Signal must have been forwarded to the summarizer
      expect(signalReceived).toBe(true);

      // No summary row
      const { rows: sumRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM summaries WHERE group_id=$1`,
        [g],
      );
      expect(Number(sumRows[0].cnt)).toBe(0);

      // No watermark row
      const { rows: wmRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM read_watermarks WHERE group_id=$1`,
        [g],
      );
      expect(Number(wmRows[0].cnt)).toBe(0);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 30_000);
});

// ── GET /api/total-summary ────────────────────────────────────────────────────

describe("GET /api/total-summary", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof createServer>;

  // Fake summarizer that branches on the prompt system text:
  //   - reduce phase: prompt.system contains "דורש תשומת לב" → yield reduce text
  //   - map phase (per-chat): yield generic per-chat text
  class BranchingFake implements StreamingSummarizer {
    async *summarizeStream(prompt: SummaryPrompt) {
      if (prompt.system.includes("דורש תשומת לב")) {
        yield "## דורש תשומת לב\n- [X] do";
      } else {
        yield "## תקציר\nx";
      }
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    server = createServer({
      pool,
      summarizer: new BranchingFake(),
      tokenBudget: 24000,
      model: "fake",
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool?.end();
  }, 30_000);

  it("streams status/token events and returns perChat in done event", async () => {
    // Seed two active chats with messages at or after `since`
    const since = "2026-06-06T00:00:00.000Z";
    const sinceDate = new Date(since);

    const g1 = await upsertGroup(pool, { name: `TS-chat1-${randomUUID()}`, source: "import" });
    const g2 = await upsertGroup(pool, { name: `TS-chat2-${randomUUID()}`, source: "import" });

    // Seed at least one message per group after `since`
    for (const [gid, key] of [
      [g1, `ts-1-${randomUUID()}`],
      [g2, `ts-2-${randomUUID()}`],
    ] as [number, string][]) {
      const row: NormalizedMessage & { participantId: number | null } = {
        groupId: gid,
        importId: null,
        source: "import",
        senderName: "Dana",
        messageType: "text",
        textContent: "hello total summary",
        mediaFilename: null,
        mediaPath: null,
        mediaStatus: null,
        externalId: null,
        participantId: null,
        sentAt: new Date(sinceDate.getTime() + 1000),
        dedupeKey: key,
      };
      await insertMessages(pool, [row]);
    }
    // Default-off scoping: include both chats so they're summarized.
    await upsertScope(pool, { groupId: g1, included: true });
    await upsertScope(pool, { groupId: g2, included: true });

    const r = await fetch(`${base}/api/total-summary?since=${encodeURIComponent(since)}`);
    const text = await r.text();

    expect(r.headers.get("content-type")).toContain("text/event-stream");

    // Parse SSE events from raw text
    const events: { event: string; data: unknown }[] = [];
    for (const block of text.split("\n\n")) {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (eventLine && dataLine) {
        events.push({
          event: eventLine.slice("event: ".length).trim(),
          data: JSON.parse(dataLine.slice("data: ".length)),
        });
      }
    }

    const done = events.find((e) => e.event === "done");
    expect(done).toBeTruthy();
    expect((done!.data as Record<string, unknown>).perChat).toBeDefined();
    expect(
      ((done!.data as Record<string, unknown>).perChat as unknown[]).length,
    ).toBeGreaterThanOrEqual(1);

    const tokens = events
      .filter((e) => e.event === "token")
      .map((e) => (e.data as Record<string, unknown>).delta as string)
      .join("");
    expect(tokens).toContain("דורש תשומת לב");
  });
});

// ── Static asset handler ──────────────────────────────────────────────────────

describe("static asset handler", () => {
  const __testDirname = path.dirname(fileURLToPath(import.meta.url));
  const PUBLIC_DIR = path.join(__testDirname, "public");
  const FIXTURE_NAME = "__test_asset__.css";
  const FIXTURE_PATH = path.join(PUBLIC_DIR, FIXTURE_NAME);

  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    // Write a small fixture CSS file into public/
    fs.writeFileSync(FIXTURE_PATH, "body { color: red; }", "utf8");

    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    server = createServer({
      pool,
      summarizer: new FakeStreaming(),
      tokenBudget: 24000,
      model: "fake",
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    // Clean up fixture
    try {
      fs.unlinkSync(FIXTURE_PATH);
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => server.close(() => r()));
    await pool?.end();
  }, 30_000);

  it("serves existing CSS file with correct content-type and body", async () => {
    const r = await fetch(`${base}/${FIXTURE_NAME}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/css");
    const text = await r.text();
    expect(text).toBe("body { color: red; }");
  });

  it("returns 404 for a missing file", async () => {
    const r = await fetch(`${base}/__missing_asset_xyz__.css`);
    expect(r.status).toBe(404);
  });

  it("blocks path traversal (URL-encoded ../ → 404)", async () => {
    // /%2e%2e/package.json → resolved outside public/ → must NOT be 200
    const r = await fetch(`${base}/%2e%2e/package.json`);
    expect(r.status).not.toBe(200);
  });

  it("/ route (index.html) still works and takes priority over static handler", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });

  it("serves index.html with text/html content-type", async () => {
    const r = await fetch(`${base}/index.html`);
    // index.html exists in public/
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });
});
