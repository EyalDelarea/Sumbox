import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { insertStatusSnapshot, listStatusSnapshots } from "./status-snapshots.js";

describe("status-snapshots repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const BASE_SNAPSHOT = {
    serviceUp: true,
    collectorConnected: true,
    lastHeartbeatAt: new Date("2026-06-06T08:00:00Z"),
    stale: false,
    jobsPending: 1,
    jobsRunning: 2,
    jobsDone: 100,
    jobsFailed: 3,
    jobsDead: 0,
    queueDepths: { "import.file": 1, "transcribe.voicenote": 5 },
    redriven: 2,
    flagged: 0,
    flaggedDetails: [],
  } as const;

  it("inserts a snapshot and retrieves it round-trip", async () => {
    await insertStatusSnapshot(pool, BASE_SNAPSHOT);

    const rows = await listStatusSnapshots(pool, 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const row = rows[0];
    expect(row.serviceUp).toBe(true);
    expect(row.collectorConnected).toBe(true);
    expect(row.stale).toBe(false);
    expect(row.jobsPending).toBe(1);
    expect(row.jobsRunning).toBe(2);
    expect(row.jobsDone).toBe(100);
    expect(row.jobsFailed).toBe(3);
    expect(row.jobsDead).toBe(0);
    expect(row.redriven).toBe(2);
    expect(row.flagged).toBe(0);
  });

  it("round-trips jsonb queue_depths correctly", async () => {
    await insertStatusSnapshot(pool, {
      ...BASE_SNAPSHOT,
      queueDepths: { "import.file": 7, "transcribe.voicenote": 3 },
    });

    const rows = await listStatusSnapshots(pool, 1);
    expect(rows[0].queueDepths).toMatchObject({ "import.file": 7, "transcribe.voicenote": 3 });
  });

  it("round-trips jsonb flagged_details correctly", async () => {
    const flaggedDetails = [
      { type: "transcribe.voicenote", messageId: "msg-99", redriveCount: 2, lastError: "boom" },
    ];
    await insertStatusSnapshot(pool, {
      ...BASE_SNAPSHOT,
      flagged: 1,
      flaggedDetails,
    });

    const rows = await listStatusSnapshots(pool, 1);
    expect(rows[0].flaggedDetails).toEqual(flaggedDetails);
    expect(rows[0].flagged).toBe(1);
  });

  it("handles null lastHeartbeatAt", async () => {
    await insertStatusSnapshot(pool, {
      ...BASE_SNAPSHOT,
      lastHeartbeatAt: null,
    });

    const rows = await listStatusSnapshots(pool, 1);
    expect(rows[0].lastHeartbeatAt).toBeNull();
  });

  it("handles null queueDepths", async () => {
    await insertStatusSnapshot(pool, {
      ...BASE_SNAPSHOT,
      queueDepths: null,
    });

    const rows = await listStatusSnapshots(pool, 1);
    expect(rows[0].queueDepths).toBeNull();
  });

  it("listStatusSnapshots returns rows newest-first up to limit", async () => {
    // Insert 3 more snapshots
    for (let i = 0; i < 3; i++) {
      await insertStatusSnapshot(pool, { ...BASE_SNAPSHOT, redriven: i });
      // small delay to ensure ordering
      await new Promise((r) => setTimeout(r, 5));
    }

    const rows = await listStatusSnapshots(pool, 2);
    expect(rows).toHaveLength(2);
    // Newest first: the last inserted has redriven=2
    expect(rows[0].capturedAt).toBeInstanceOf(Date);
    if (rows.length >= 2) {
      expect(rows[0].capturedAt.getTime()).toBeGreaterThanOrEqual(rows[1].capturedAt.getTime());
    }
  });

  it("returns an id and capturedAt on each row", async () => {
    await insertStatusSnapshot(pool, BASE_SNAPSHOT);
    const rows = await listStatusSnapshots(pool, 1);
    expect(typeof rows[0].id).toBe("string");
    expect(rows[0].capturedAt).toBeInstanceOf(Date);
  });
});
