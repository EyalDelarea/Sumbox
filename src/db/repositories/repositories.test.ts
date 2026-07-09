import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { listGroups, upsertGroup } from "./groups.js";
import { createImport, markImportCompleted, markImportFailed } from "./imports.js";
import { insertMessages } from "./messages.js";
import { upsertParticipant, upsertParticipants } from "./participants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNormalizedMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    groupId: 0, // overridden below
    importId: null,
    source: "import",
    senderName: "Alice",
    messageType: "text",
    textContent: "Hello world",
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    sentAt: new Date("2024-01-15T10:30:00.000Z"),
    dedupeKey: "test-dedupe-key-001",
    externalId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("repositories integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  // -------------------------------------------------------------------------
  // groups
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // listGroups
  // -------------------------------------------------------------------------

  describe("listGroups", () => {
    it("returns groups with their message counts ordered by name", async () => {
      // Use unique names to avoid collision with other tests
      const nameA = "ZZZ listGroups Group Alpha";
      const nameB = "ZZZ listGroups Group Beta";

      const groupIdA = await upsertGroup(pool, { name: nameA, source: "import" });
      const groupIdB = await upsertGroup(pool, { name: nameB, source: "import" });

      const participantId = await upsertParticipant(pool, "ListGroups Sender");

      // Insert 2 messages in group A
      await insertMessages(pool, [
        {
          ...makeNormalizedMessage({
            groupId: groupIdA,
            dedupeKey: "listgroups-a-001",
            textContent: "Msg A1",
          }),
          participantId,
        },
        {
          ...makeNormalizedMessage({
            groupId: groupIdA,
            dedupeKey: "listgroups-a-002",
            textContent: "Msg A2",
          }),
          participantId,
        },
      ]);

      // Insert 1 message in group B
      await insertMessages(pool, [
        {
          ...makeNormalizedMessage({
            groupId: groupIdB,
            dedupeKey: "listgroups-b-001",
            textContent: "Msg B1",
          }),
          participantId,
        },
      ]);

      const allGroups = await listGroups(pool);

      // Filter to just our test groups to avoid interference from other tests
      const testGroups = allGroups.filter((g) => g.name === nameA || g.name === nameB);

      expect(testGroups).toHaveLength(2);
      // Both groups share the same fixed sent_at, so the recency sort ties and
      // falls back to the name tiebreaker: Alpha before Beta.
      expect(testGroups[0]!.name).toBe(nameA);
      expect(testGroups[0]!.source).toBe("import");
      expect(testGroups[0]!.messageCount).toBe(2);

      expect(testGroups[1]!.name).toBe(nameB);
      expect(testGroups[1]!.source).toBe("import");
      expect(testGroups[1]!.messageCount).toBe(1);
    });

    it("returns messageCount of 0 for a group with no messages", async () => {
      const emptyGroupName = "ZZZ listGroups Empty Group";
      await upsertGroup(pool, { name: emptyGroupName, source: "import" });

      const allGroups = await listGroups(pool);
      const emptyGroup = allGroups.find((g) => g.name === emptyGroupName);

      expect(emptyGroup).toBeDefined();
      expect(emptyGroup!.messageCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // upsertGroup
  // -------------------------------------------------------------------------

  describe("upsertGroup", () => {
    it("inserts a new group and returns its id", async () => {
      const id = await upsertGroup(pool, { name: "Test Chat 1", source: "import" });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("is idempotent: same name twice returns the same id and leaves one row", async () => {
      const id1 = await upsertGroup(pool, { name: "Idempotent Group", source: "import" });
      const id2 = await upsertGroup(pool, { name: "Idempotent Group", source: "import" });
      expect(id1).toBe(id2);

      const { rows } = await pool.query(`SELECT COUNT(*) AS cnt FROM groups WHERE name = $1`, [
        "Idempotent Group",
      ]);
      expect(Number(rows[0].cnt)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // participants
  // -------------------------------------------------------------------------

  describe("upsertParticipant", () => {
    it("inserts a new participant and returns its id", async () => {
      const id = await upsertParticipant(pool, "Bob");
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("is idempotent: same display_name twice returns the same id", async () => {
      const id1 = await upsertParticipant(pool, "Charlie");
      const id2 = await upsertParticipant(pool, "Charlie");
      expect(id1).toBe(id2);

      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM participants WHERE display_name = $1`,
        ["Charlie"],
      );
      expect(Number(rows[0].cnt)).toBe(1);
    });
  });

  describe("upsertParticipants", () => {
    it("returns a Map of display_name → id for multiple names", async () => {
      const names = ["Dave", "Eve", "Frank"];
      const map = await upsertParticipants(pool, names);
      expect(map.size).toBe(3);
      for (const name of names) {
        expect(map.has(name)).toBe(true);
        expect(typeof map.get(name)).toBe("number");
      }
    });

    it("is idempotent when called twice with overlapping names", async () => {
      const first = await upsertParticipants(pool, ["Grace", "Heidi"]);
      const second = await upsertParticipants(pool, ["Grace", "Ivan"]);
      expect(first.get("Grace")).toBe(second.get("Grace"));
    });
  });

  // -------------------------------------------------------------------------
  // imports
  // -------------------------------------------------------------------------

  describe("createImport / markImportCompleted / markImportFailed", () => {
    it("creates an import record in pending status and returns an id", async () => {
      const groupId = await upsertGroup(pool, { name: "Import Group", source: "import" });
      const importId = await createImport(pool, {
        groupId,
        sourcePath: "/tmp/chat.txt",
        sourceHash: "abc123",
        originalFilePath: "data/imports/1/original.txt",
        status: "pending",
      });
      expect(typeof importId).toBe("number");
      expect(importId).toBeGreaterThan(0);

      const { rows } = await pool.query(`SELECT status FROM imports WHERE id = $1`, [importId]);
      expect(rows[0].status).toBe("pending");
    });

    it("markImportCompleted sets status to completed", async () => {
      const groupId = await upsertGroup(pool, { name: "Import Group 2", source: "import" });
      const importId = await createImport(pool, {
        groupId,
        sourcePath: "/tmp/chat2.txt",
        sourceHash: "def456",
        originalFilePath: "data/imports/2/original.txt",
        status: "pending",
      });
      await markImportCompleted(pool, importId);
      const { rows } = await pool.query(`SELECT status FROM imports WHERE id = $1`, [importId]);
      expect(rows[0].status).toBe("completed");
    });

    it("markImportFailed sets status to failed with an error message", async () => {
      const groupId = await upsertGroup(pool, { name: "Import Group 3", source: "import" });
      const importId = await createImport(pool, {
        groupId,
        sourcePath: "/tmp/chat3.txt",
        sourceHash: "ghi789",
        originalFilePath: "data/imports/3/original.txt",
        status: "pending",
      });
      await markImportFailed(pool, importId, "Something went wrong");
      const { rows } = await pool.query(`SELECT status, error_message FROM imports WHERE id = $1`, [
        importId,
      ]);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].error_message).toBe("Something went wrong");
    });
  });

  // -------------------------------------------------------------------------
  // messages — the core SC-002 dedupe proof
  // -------------------------------------------------------------------------

  describe("insertMessages", () => {
    it("inserts N rows and returns inserted=N the first time", async () => {
      const groupId = await upsertGroup(pool, {
        name: "Messages Group 1",
        source: "import",
      });
      const participantId = await upsertParticipant(pool, "Alice-Msg");

      const rows: (NormalizedMessage & { participantId: number | null })[] = [
        {
          ...makeNormalizedMessage({
            groupId,
            dedupeKey: "unique-key-001",
            textContent: "First message",
          }),
          participantId,
        },
        {
          ...makeNormalizedMessage({
            groupId,
            dedupeKey: "unique-key-002",
            textContent: "Second message",
          }),
          participantId,
        },
      ];

      const result = await insertMessages(pool, rows);
      expect(result.inserted).toBe(2);
      expect(result.skipped).toBe(0);
    });

    it("re-inserting the same rows returns inserted=0, skipped=N (SC-002 dedupe proof)", async () => {
      const groupId = await upsertGroup(pool, {
        name: "Messages Group Dedupe",
        source: "import",
      });
      const participantId = await upsertParticipant(pool, "Alice-Dedupe");

      const rows: (NormalizedMessage & { participantId: number | null })[] = [
        {
          ...makeNormalizedMessage({
            groupId,
            dedupeKey: "dedupe-proof-001",
            textContent: "Deduped A",
          }),
          participantId,
        },
        {
          ...makeNormalizedMessage({
            groupId,
            dedupeKey: "dedupe-proof-002",
            textContent: "Deduped B",
          }),
          participantId,
        },
        {
          ...makeNormalizedMessage({
            groupId,
            dedupeKey: "dedupe-proof-003",
            textContent: "Deduped C",
          }),
          participantId,
        },
      ];

      // First pass
      const first = await insertMessages(pool, rows);
      expect(first.inserted).toBe(3);
      expect(first.skipped).toBe(0);

      // Second pass — ALL must be skipped (SC-002)
      const second = await insertMessages(pool, rows);
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBe(3);
    });

    it("handles system messages with null participantId", async () => {
      const groupId = await upsertGroup(pool, {
        name: "Messages Group System",
        source: "import",
      });

      const rows: (NormalizedMessage & { participantId: number | null })[] = [
        {
          ...makeNormalizedMessage({
            groupId,
            senderName: null,
            messageType: "system",
            textContent: "You were added",
            dedupeKey: "system-msg-001",
          }),
          participantId: null,
        },
      ];

      const result = await insertMessages(pool, rows);
      expect(result.inserted).toBe(1);
    });

    it("returns inserted=0 skipped=0 for an empty array", async () => {
      const result = await insertMessages(pool, []);
      expect(result.inserted).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });
});
