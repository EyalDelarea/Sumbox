import os from "node:os";
import path from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant-context.js";
import { appPool, createTestDatabase, operatorPool } from "../test/db.js";
import { makeTenantIngest } from "./tenant-ingest.js";

/**
 * T3 acceptance — two tenants' sessions ingest concurrently and every row lands on
 * the right tenant, enforced by RLS (the pool is the real catchapp_app role).
 */

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function fakeText(id: string, jid: string, text: string): WAMessage {
  return {
    key: { id, remoteJid: jid, fromMe: false },
    messageTimestamp: 1700001000,
    pushName: "Sender",
    message: { conversation: text },
  } as unknown as WAMessage;
}

let app: pg.Pool;
let op: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
  for (const id of [A, B]) {
    await op.query(`INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      id,
      id,
    ]);
  }
});

afterAll(async () => {
  await app?.end();
  await op?.end();
});

describe("makeTenantIngest", () => {
  it("attributes each session's messages to ITS tenant, isolated under RLS", async () => {
    const ingest = makeTenantIngest({
      appPool: app,
      dataDir: path.join(os.tmpdir(), "t3-ingest"),
      sessionGlue: () => ({
        downloadVoiceNote: async () => Buffer.alloc(0),
        downloadImage: async () => Buffer.alloc(0),
        downloadVideo: async () => Buffer.alloc(0),
        groupSubject: async () => "קבוצה",
        lidForPn: async () => null,
        pnForLid: async () => null,
      }),
    });

    const storedA = await ingest(A, fakeText("MA1", "111-aaa@g.us", "שלום מטננט A"));
    const storedB = await ingest(B, fakeText("MB1", "222-bbb@g.us", "שלום מטננט B"));
    expect(storedA).toBe(true);
    expect(storedB).toBe(true);

    // Truth check across tenants on the operator pool.
    const rows = await op.query<{ tenant_id: string; text_content: string }>(
      `SELECT tenant_id, text_content FROM messages WHERE external_id IN ('MA1','MB1')
       ORDER BY external_id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ tenant_id: A, text_content: "שלום מטננט A" });
    expect(rows.rows[1]).toMatchObject({ tenant_id: B, text_content: "שלום מטננט B" });

    // And RLS: from inside tenant A, tenant B's message does not exist.
    const fromA = await withTenant(app, A, (c) =>
      c.query(`SELECT external_id FROM messages WHERE external_id IN ('MA1','MB1')`),
    );
    expect(fromA.rows.map((r) => r.external_id)).toEqual(["MA1"]);
  });

  it("dedupes per tenant (same message twice stores once)", async () => {
    const ingest = makeTenantIngest({
      appPool: app,
      dataDir: path.join(os.tmpdir(), "t3-ingest"),
      sessionGlue: () => ({
        downloadVoiceNote: async () => Buffer.alloc(0),
        downloadImage: async () => Buffer.alloc(0),
        downloadVideo: async () => Buffer.alloc(0),
        groupSubject: async () => "קבוצה",
        lidForPn: async () => null,
        pnForLid: async () => null,
      }),
    });
    const msg = fakeText("DUP1", "333-ccc@g.us", "כפול");
    expect(await ingest(A, msg)).toBe(true);
    expect(await ingest(A, msg)).toBe(false); // dedupe_key hit
  });
});
