import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../ask/embedder.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { upsertMessageEmbedding } from "../db/repositories/message-embeddings.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import type { GoldenItem } from "./golden.js";
import { evaluateItem, runSuiteR } from "./suite-r.js";

function vec(axis: number) {
  const v = new Array(1024).fill(0);
  v[axis] = 1;
  return v;
}

async function seed(
  pool: pg.Pool,
  groupId: number,
  text: string,
  externalId: string,
  axis: number,
) {
  const participantId = await upsertParticipant(pool, "Royi");
  const row: NormalizedMessage & { participantId: number | null } = {
    groupId,
    importId: null,
    source: "import",
    senderName: "Royi",
    messageType: "text",
    textContent: text,
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    externalId,
    participantId,
    sentAt: new Date("2026-07-10T10:00:00Z"),
    dedupeKey: externalId,
  };
  const { ids } = await insertMessages(pool, [row]);
  await upsertMessageEmbedding(pool, {
    messageId: Number(ids[0]!),
    embedding: vec(axis),
    model: "bge-m3",
  });
  return Number(ids[0]!);
}

const item = (over: Partial<GoldenItem> = {}): GoldenItem => ({
  id: "i1",
  groupId: 0,
  question: "מה נאמר על הפגישה",
  goldExternalIds: [],
  mustNotRefuse: false,
  slice: ["test"],
  provenance: { added: "2026-07-16", reason: "unit" },
  ...over,
});

describe("suite-r", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("scores a hit with its rank on every arm", async () => {
    const g = await upsertGroup(pool, { name: "SR-hit", source: "import" });
    const gold = await seed(pool, g, "הפגישה תהיה מחר", "SR-1", 1);
    const embedder: Embedder = { embed: async () => vec(1) };

    const r = await evaluateItem(
      { pool, embedder },
      item({ groupId: g, goldExternalIds: ["SR-1"], question: "הפגישה" }),
    );
    expect(r.arms.fused.hit).toBe(true);
    expect(r.arms.fused.recall).toBe(1);
    expect(r.arms.fused.firstGoldRank).toBe(1);
    expect(r.arms.fused.reciprocalRank).toBe(1);
    expect(r.arms.semantic.hit).toBe(true);
    // Lexical must find it too — the token is literally present.
    expect(r.arms.lexical.hit).toBe(true);
    expect(gold).toBeGreaterThan(0);
  });

  it("scores a miss as recall 0 and rank null, not a crash", async () => {
    const g = await upsertGroup(pool, { name: "SR-miss", source: "import" });
    // NOTE: semantic search has NO distance floor — pgvector returns the k
    // nearest however far away they are, so an orthogonal query still retrieves
    // the only message in a group. A miss therefore has to be constructed by
    // crowding the gold OUT of top-k, not by querying something unrelated.
    await seed(pool, g, "דבר אחר לגמרי", "SR-decoy", 900);
    await seed(pool, g, "משהו נסתר", "SR-2", 2);
    const embedder: Embedder = { embed: async () => vec(900) };

    const r = await evaluateItem(
      { pool, embedder, k: 1 },
      item({ groupId: g, goldExternalIds: ["SR-2"], question: "זברה" }),
    );
    expect(r.arms.fused.hit).toBe(false);
    expect(r.arms.fused.recall).toBe(0);
    expect(r.arms.fused.firstGoldRank).toBeNull();
    expect(r.arms.fused.reciprocalRank).toBe(0);
  });

  it("throws a ROTTED-ITEM error when a gold external_id no longer exists", async () => {
    // A purged/re-imported message must not read as a retrieval regression.
    const g = await upsertGroup(pool, { name: "SR-rot", source: "import" });
    const embedder: Embedder = { embed: async () => vec(3) };
    await expect(
      evaluateItem({ pool, embedder }, item({ groupId: g, goldExternalIds: ["NOPE"] })),
    ).rejects.toThrow(/rotted/);
  });

  it("excludes D_absent items from retrieval aggregates", async () => {
    // A D_absent item has nothing to retrieve; folding its vacuous recall=1 into
    // the mean would inflate the headline with items that cannot fail.
    const g = await upsertGroup(pool, { name: "SR-absent", source: "import" });
    await seed(pool, g, "הפגישה תהיה מחר", "SR-3", 4);
    const embedder: Embedder = { embed: async () => vec(4) };

    const s = await runSuiteR({ pool, embedder }, [
      item({ id: "present", groupId: g, goldExternalIds: ["SR-3"], question: "הפגישה" }),
      item({ id: "absent", groupId: g, goldExternalIds: [], question: "משהו שלא נאמר" }),
    ]);
    expect(s.n).toBe(2);
    // Only the one item with gold contributes.
    expect(s.byArm.fused.hitRate).toBe(1);
    expect(s.bySlice["test"]?.n).toBe(1);
  });
});
