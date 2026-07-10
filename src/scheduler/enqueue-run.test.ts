/**
 * T013 — Integration tests for enqueueScheduledRun.
 *
 * Uses Testcontainers for a real Postgres DB (to test the "changed group"
 * detection query), with a fake JobBus to avoid a live RabbitMQ.
 *
 * Scenarios:
 * 1. Enqueues only changed groups (groups with readable messages after their watermark).
 * 2. Skips unchanged groups (watermark already at latest message).
 * 3. opts.all=true forces enqueue for all groups regardless of changes.
 * 4. A single failing group does not abort the batch (other groups still enqueued).
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertScope } from "../db/repositories/chat-scopes.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import { upsertWatermark } from "../db/repositories/read-watermarks.js";
import type { JobBus } from "../jobs/job-bus.js";
import type { JobPayloads, JobType } from "../jobs/job-types.js";
import { createTestDatabase } from "../test/db.js";
import { enqueueScheduledRun } from "./enqueue-run.js";

// ---------------------------------------------------------------------------
// Fake bus
// ---------------------------------------------------------------------------

type EnqueueCall = { type: string; payload: Record<string, unknown> };

function makeFakeBus(): JobBus & { calls: EnqueueCall[]; failForGroupId?: string } {
  const calls: EnqueueCall[] = [];
  let failForGroupId: string | undefined;

  const bus: JobBus & { calls: EnqueueCall[]; failForGroupId?: string } = {
    calls,
    get failForGroupId() {
      return failForGroupId;
    },
    set failForGroupId(v) {
      failForGroupId = v;
    },
    enqueue: vi.fn(async <T extends JobType>(type: T, payload: JobPayloads[T]) => {
      if (
        type === "summarize.group" &&
        failForGroupId !== undefined &&
        (payload as { groupId: string }).groupId === failForGroupId
      ) {
        throw new Error(`Fake bus failure for groupId ${failForGroupId}`);
      }
      calls.push({ type, payload: payload as Record<string, unknown> });
      return { id: "fake-id" };
    }),
    consume: vi.fn(),
    depth: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobBus & { calls: EnqueueCall[]; failForGroupId?: string };

  return bus;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

// Scope is now default-OFF, so a group is only summarized when explicitly
// included. These tests exercise watermark/change logic, not scoping, so by
// default we opt every seeded group in; the scope-specific test opts out.
async function seedGroup(pool: pg.Pool, name: string, include = true): Promise<number> {
  const id = await upsertGroup(pool, { name, source: "import" });
  if (include) await upsertScope(pool, { groupId: id, included: true });
  return id;
}

async function seedMessage(
  pool: pg.Pool,
  groupId: number,
  dedupeKey: string,
  sentAt: Date,
): Promise<number> {
  const participantId = await upsertParticipant(pool, "Tester");
  await insertMessages(pool, [
    {
      groupId,
      importId: null,
      source: "import",
      senderName: "Tester",
      participantId,
      messageType: "text",
      textContent: "Hello",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      dedupeKey,
      sentAt,
    },
  ]);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM messages WHERE dedupe_key = $1`,
    [dedupeKey],
  );
  return Number(rows[0]!.id);
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

describe("enqueueScheduledRun", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("enqueues only changed groups (those with messages after their watermark)", async () => {
    const bus = makeFakeBus();

    // Group A: has new messages (no watermark → changed)
    const groupAId = await seedGroup(pool, "enqueue-test-a");
    const sentAt = new Date("2026-06-04T07:00:00Z");
    await seedMessage(pool, groupAId, "enq-a-msg-1", sentAt);

    // Group B: watermark already at latest message → not changed
    const groupBId = await seedGroup(pool, "enqueue-test-b");
    const sentAtB = new Date("2026-06-04T06:00:00Z");
    const msgBId = await seedMessage(pool, groupBId, "enq-b-msg-1", sentAtB);
    // Set watermark to cover that message
    await upsertWatermark(pool, groupBId, { sentAt: sentAtB, messageId: msgBId });

    const result = await enqueueScheduledRun(pool, bus);

    // At least group A was enqueued, group B was not
    const enqueuedGroupIds = bus.calls
      .filter((c) => c.type === "summarize.group")
      .map((c) => String(c.payload["groupId"]));

    expect(enqueuedGroupIds).toContain(String(groupAId));
    expect(enqueuedGroupIds).not.toContain(String(groupBId));

    // Result reflects the counts
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.enqueued + result.skipped).toBeGreaterThanOrEqual(2);
  });

  it("enqueues only explicitly-included chats; skips un-scoped/excluded/removed, even with all:true", async () => {
    const bus = makeFakeBus();
    const ts = new Date("2026-06-05T07:00:00Z");

    const included = await seedGroup(pool, "scope-included"); // auto included:true
    await seedMessage(pool, included, "scope-inc-1", ts);
    const unscoped = await seedGroup(pool, "scope-unscoped", false); // no scope row
    await seedMessage(pool, unscoped, "scope-uns-1", ts);
    const excluded = await seedGroup(pool, "scope-excluded", false);
    await seedMessage(pool, excluded, "scope-exc-1", ts);
    const removed = await seedGroup(pool, "scope-removed", false);
    await seedMessage(pool, removed, "scope-rem-1", ts);

    await upsertScope(pool, { groupId: excluded, included: false });
    await upsertScope(pool, { groupId: removed, included: true, removed: true });

    // all:true ignores the watermark but must NOT resurrect un-scoped/excluded chats.
    await enqueueScheduledRun(pool, bus, { all: true });

    const ids = bus.calls
      .filter((c) => c.type === "summarize.group")
      .map((c) => String(c.payload["groupId"]));
    expect(ids).toContain(String(included));
    expect(ids).not.toContain(String(unscoped));
    expect(ids).not.toContain(String(excluded));
    expect(ids).not.toContain(String(removed));
  });

  it("returns enqueued=0, skipped=all when every group is up to date", async () => {
    const bus = makeFakeBus();

    // Group C: watermark at latest message
    const groupCId = await seedGroup(pool, "enqueue-test-c");
    const sentAt = new Date("2026-06-04T05:00:00Z");
    const msgId = await seedMessage(pool, groupCId, "enq-c-msg-1", sentAt);
    await upsertWatermark(pool, groupCId, { sentAt, messageId: msgId });

    const before = bus.calls.length;
    const result = await enqueueScheduledRun(pool, bus);

    // Group C should not be enqueued (watermark covers it)
    const newCalls = bus.calls
      .slice(before)
      .filter(
        (c) => c.type === "summarize.group" && String(c.payload["groupId"]) === String(groupCId),
      );
    expect(newCalls).toHaveLength(0);
    // skipped >= 1 because at least group C was skipped
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("opts.all=true enqueues all groups regardless of watermark", async () => {
    const bus = makeFakeBus();

    // Group D: already up to date
    const groupDId = await seedGroup(pool, "enqueue-test-d");
    const sentAt = new Date("2026-06-04T04:00:00Z");
    const msgId = await seedMessage(pool, groupDId, "enq-d-msg-1", sentAt);
    await upsertWatermark(pool, groupDId, { sentAt, messageId: msgId });

    const result = await enqueueScheduledRun(pool, bus, { all: true });

    // Group D must be in the enqueued calls despite being up to date
    const enqueuedGroupIds = bus.calls
      .filter((c) => c.type === "summarize.group")
      .map((c) => String(c.payload["groupId"]));

    expect(enqueuedGroupIds).toContain(String(groupDId));
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
  });

  it("enqueues one summarize.total job when sinceForTotal is provided", async () => {
    const bus = makeFakeBus();
    const since = new Date("2026-06-06T00:00:00.000Z");
    await enqueueScheduledRun(pool, bus, { all: true, sinceForTotal: since });
    const totals = bus.calls.filter((e) => e.type === "summarize.total");
    expect(totals.length).toBe(1);
    expect(totals[0]!.payload).toEqual({
      since: since.toISOString(),
    });
  });

  it("does NOT enqueue a total when sinceForTotal is omitted", async () => {
    const bus = makeFakeBus();
    await enqueueScheduledRun(pool, bus, { all: true });
    expect(bus.calls.filter((e) => e.type === "summarize.total").length).toBe(0);
  });

  it("one failing group does not abort the batch (other groups still enqueued)", async () => {
    const bus = makeFakeBus();

    // Group E (will fail) and Group F (should still enqueue)
    const groupEId = await seedGroup(pool, "enqueue-test-e");
    const groupFId = await seedGroup(pool, "enqueue-test-f");

    const sentAtE = new Date("2026-06-04T03:00:00Z");
    const sentAtF = new Date("2026-06-04T02:00:00Z");
    await seedMessage(pool, groupEId, "enq-e-msg-1", sentAtE);
    await seedMessage(pool, groupFId, "enq-f-msg-1", sentAtF);

    // Make the bus throw for group E
    bus.failForGroupId = String(groupEId);

    // Should not throw
    const result = await enqueueScheduledRun(pool, bus);

    // Group F should still have been enqueued
    const fEnqueued = bus.calls.some(
      (c) => c.type === "summarize.group" && String(c.payload["groupId"]) === String(groupFId),
    );
    expect(fEnqueued).toBe(true);

    // Function returned without throwing
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
  });
});
