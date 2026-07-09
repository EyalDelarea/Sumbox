import type http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamingSummarizer } from "../summarization/summarizer.js";
import { createTestDatabase } from "../test/db.js";
import { createServer, isCrossOrigin } from "./server.js";

/**
 * CSRF same-origin guard on the state-changing GET endpoints (/api/summarize,
 * /api/total-summary). EventSource can't carry a token, so we validate Origin/Referer.
 */

function fakeReq(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

describe("isCrossOrigin", () => {
  const host = "localhost:8787";

  it("blocks a mismatched Origin", () => {
    expect(isCrossOrigin(fakeReq({ host, origin: "http://evil.test" }))).toBe(true);
  });

  it("blocks a mismatched Referer", () => {
    expect(isCrossOrigin(fakeReq({ host, referer: "http://evil.test/page" }))).toBe(true);
  });

  it("allows a matching Origin / Referer", () => {
    expect(isCrossOrigin(fakeReq({ host, origin: "http://localhost:8787" }))).toBe(false);
    expect(isCrossOrigin(fakeReq({ host, referer: "http://localhost:8787/app" }))).toBe(false);
  });

  it("allows when neither Origin nor Referer is present (same-origin GET nav)", () => {
    expect(isCrossOrigin(fakeReq({ host }))).toBe(false);
  });

  it("treats a malformed Origin as cross-origin", () => {
    expect(isCrossOrigin(fakeReq({ host, origin: "not a url" }))).toBe(true);
  });
});

describe("dispatchApi same-origin enforcement", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof createServer>;
  let base: string;

  const noopSummarizer: StreamingSummarizer = {
    async *summarizeStream() {},
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    server = createServer({ pool, summarizer: noopSummarizer, tokenBudget: 24000, model: "fake" });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool?.end();
  });

  it("403s a cross-origin GET /api/summarize before running the handler", async () => {
    const r = await fetch(`${base}/api/summarize?group=x&mode=sumbox`, {
      headers: { origin: "http://evil.test" },
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("Cross-origin request rejected.");
  });

  it("403s a cross-origin POST /api/summaries/:id/rating before running the handler", async () => {
    const r = await fetch(`${base}/api/summaries/1/rating`, {
      method: "POST",
      headers: { origin: "http://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ rating: -1, reason: "too_long" }),
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("Cross-origin request rejected.");
  });
});
