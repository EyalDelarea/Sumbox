import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import {
  dismissInfoCard,
  listDismissedCardIds,
  undismissInfoCard,
} from "./dismissed-info-cards.js";
import { insertTotalSummary } from "./total-summaries.js";

describe("dismissed-info-cards repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const newSummary = () =>
    insertTotalSummary(pool, {
      rangeKind: "since",
      parameters: { since: "2026-06-06T00:00:00.000Z" },
      output: { highlights: "h", perChat: [] },
      model: "gemma4:26b",
    });

  it("records a dismissal and reads it back for that summary", async () => {
    const summaryId = await newSummary();
    expect(await listDismissedCardIds(pool, summaryId)).toEqual(new Set());

    await dismissInfoCard(pool, summaryId, "info:highlights");
    await dismissInfoCard(pool, summaryId, "info:chat:Work");

    expect(await listDismissedCardIds(pool, summaryId)).toEqual(
      new Set(["info:highlights", "info:chat:Work"]),
    );
  });

  it("is idempotent — re-dismissing the same card does not throw or duplicate", async () => {
    const summaryId = await newSummary();
    await dismissInfoCard(pool, summaryId, "info:highlights");
    await dismissInfoCard(pool, summaryId, "info:highlights");
    expect(await listDismissedCardIds(pool, summaryId)).toEqual(new Set(["info:highlights"]));
  });

  it("undismiss reverses a dismissal and is a no-op when none exists", async () => {
    const summaryId = await newSummary();
    await dismissInfoCard(pool, summaryId, "info:highlights");
    await undismissInfoCard(pool, summaryId, "info:highlights");
    expect(await listDismissedCardIds(pool, summaryId)).toEqual(new Set());
    // Reversing again is harmless.
    await undismissInfoCard(pool, summaryId, "info:highlights");
    expect(await listDismissedCardIds(pool, summaryId)).toEqual(new Set());
  });

  it("scopes dismissals per summary version — a new summary starts clean", async () => {
    const older = await newSummary();
    await dismissInfoCard(pool, older, "info:chat:Work");

    const newer = await newSummary();
    // The same card id under a fresh summary is not dismissed.
    expect(await listDismissedCardIds(pool, newer)).toEqual(new Set());
    // The older summary still carries its dismissal.
    expect(await listDismissedCardIds(pool, older)).toEqual(new Set(["info:chat:Work"]));
  });
});
