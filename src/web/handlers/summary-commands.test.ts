/**
 * Tests for GET/PUT /api/summary-commands — Task 5: the API now carries the /סיכום
 * trigger alongside the per-group permission list. The DB is the source of truth;
 * the collector's matcher reads it live per message (Task 4b), so there is no reload
 * to assert here — persistence via getPreferences() is the only observable effect.
 *
 * Strategy: real DB (Testcontainers), no mocks.
 */

import type http from "node:http";
import { PassThrough } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPreferences } from "../../db/repositories/user-preferences.js";
import { createTestDatabase } from "../../test/db.js";
import type { ServerDeps } from "./context.js";
import { handleSummaryCommands } from "./summary-commands.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDeps(pool: pg.Pool): ServerDeps {
  return {
    pool,
    summarizer: null as unknown as ServerDeps["summarizer"],
    tokenBudget: 0,
    model: "fake",
  };
}

function makeGetRequest(): http.IncomingMessage {
  const stream = new PassThrough();
  stream.push(null);
  return Object.assign(stream, { method: "GET", headers: {} }) as unknown as http.IncomingMessage;
}

function makePutRequest(body: unknown): http.IncomingMessage {
  const json = JSON.stringify(body);
  const stream = new PassThrough();
  stream.push(Buffer.from(json));
  stream.push(null);
  return Object.assign(stream, {
    method: "PUT",
    headers: { "content-length": String(Buffer.byteLength(json)) },
  }) as unknown as http.IncomingMessage;
}

function collectResponse(): { res: http.ServerResponse; bodyPromise: Promise<string> } {
  const chunks: Buffer[] = [];
  let resolve: (v: string) => void;
  const bodyPromise = new Promise<string>((r) => {
    resolve = r;
  });
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => {},
    writeHead(code: number, _headers?: unknown) {
      this.statusCode = code;
    },
    write(chunk: Buffer | string) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      resolve(Buffer.concat(chunks).toString("utf8"));
    },
  } as unknown as http.ServerResponse;
  return { res, bodyPromise };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET/PUT /api/summary-commands", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("GET returns the trigger alongside the groups", async () => {
    const deps = makeDeps(pool);
    const req = makeGetRequest();
    const { res, bodyPromise } = collectResponse();
    await handleSummaryCommands(new URL("http://localhost/api/summary-commands"), req, res, deps);
    const body = JSON.parse(await bodyPromise);

    expect(body.trigger).toBe("/סיכום");
    expect(Array.isArray(body.groups)).toBe(true);
  });

  it("PUT { trigger } persists the new trigger", async () => {
    const deps = makeDeps(pool);
    const req = makePutRequest({ trigger: "/סכם" });
    const { res, bodyPromise } = collectResponse();
    await handleSummaryCommands(new URL("http://localhost/api/summary-commands"), req, res, deps);
    await bodyPromise;

    expect(res.statusCode).toBe(200);
    const prefs = await getPreferences(pool);
    expect(prefs?.summaryCommandTrigger).toBe("/סכם");
  });

  it("PUT rejects an invalid trigger with 400 and does not persist it", async () => {
    const deps = makeDeps(pool);
    // Establish a known-good baseline first.
    await handleSummaryCommands(
      new URL("http://localhost/api/summary-commands"),
      makePutRequest({ trigger: "/סיכום" }),
      collectResponse().res,
      deps,
    );

    const req = makePutRequest({ trigger: "סכם" }); // missing leading slash — invalid
    const { res, bodyPromise } = collectResponse();
    await handleSummaryCommands(new URL("http://localhost/api/summary-commands"), req, res, deps);
    const body = JSON.parse(await bodyPromise);

    expect(res.statusCode).toBe(400);
    expect(body.error).toBeTruthy();
    const prefs = await getPreferences(pool);
    expect(prefs?.summaryCommandTrigger).toBe("/סיכום");
  });

  it("PUT rejects a body that is neither a toggle nor a trigger", async () => {
    const deps = makeDeps(pool);
    const req = makePutRequest({ nonsense: 1 });
    const { res, bodyPromise } = collectResponse();
    await handleSummaryCommands(new URL("http://localhost/api/summary-commands"), req, res, deps);
    const body = JSON.parse(await bodyPromise);

    expect(res.statusCode).toBe(400);
    expect(body.error).toBeTruthy();
  });
});
