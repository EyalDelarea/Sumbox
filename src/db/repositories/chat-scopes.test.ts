import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import {
  getGroupCategoryName,
  isGroupIncluded,
  listIncludedGroupIds,
  listScopes,
  listSuggestibleGroupIds,
  upsertScope,
} from "./chat-scopes.js";
import { upsertGroup } from "./groups.js";
import { insertMessages } from "./messages.js";
import { upsertParticipant } from "./participants.js";
import { createCategory } from "./scope-categories.js";

describe("chat-scopes repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seedGroupWithMessage(name: string): Promise<number> {
    const groupId = await upsertGroup(pool, { name, source: "import" });
    const participantId = await upsertParticipant(pool, `p-${name}`);
    const msg: NormalizedMessage = {
      groupId,
      importId: null,
      source: "import",
      senderName: "X",
      messageType: "text",
      textContent: "hi",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      sentAt: new Date("2026-05-01T10:00:00.000Z"),
      dedupeKey: `dk-${name}-${Math.random()}`,
      externalId: null,
      fromMe: null,
    };
    await insertMessages(pool, [{ ...msg, participantId }]);
    return groupId;
  }

  describe("listIncludedGroupIds (the digest filter)", () => {
    it("default-off: only an explicitly-included group qualifies; unscoped/excluded/removed are filtered", async () => {
      const noScope = await seedGroupWithMessage("cs-noscope");
      const included = await seedGroupWithMessage("cs-included");
      const excluded = await seedGroupWithMessage("cs-excluded");
      const removed = await seedGroupWithMessage("cs-removed");

      await upsertScope(pool, { groupId: included, included: true });
      await upsertScope(pool, { groupId: excluded, included: false });
      await upsertScope(pool, { groupId: removed, included: true, removed: true });

      const ids = await listIncludedGroupIds(pool);
      expect(ids).toContain(included);
      expect(ids).not.toContain(noScope);
      expect(ids).not.toContain(excluded);
      expect(ids).not.toContain(removed);
    });
  });

  describe("upsertScope", () => {
    it("inserts then partially updates, leaving untouched fields intact", async () => {
      const g = await seedGroupWithMessage("cs-partial");
      await upsertScope(pool, { groupId: g, included: false, categoryId: null });
      // a second call touching only `included` must not reset category/removed
      await upsertScope(pool, { groupId: g, included: true });
      const row = (await listScopes(pool)).find((r) => r.group === "cs-partial")!;
      expect(row.included).toBe(true);
      expect(row.removed).toBe(false);
    });

    it("remove then restore round-trips removed_at", async () => {
      const g = await seedGroupWithMessage("cs-restore");
      await upsertScope(pool, { groupId: g, removed: true });
      expect((await listScopes(pool)).find((r) => r.group === "cs-restore")!.removed).toBe(true);
      await upsertScope(pool, { groupId: g, removed: false });
      expect((await listScopes(pool)).find((r) => r.group === "cs-restore")!.removed).toBe(false);
    });
  });

  describe("listScopes", () => {
    it("projects an un-scoped group as excluded/uncategorized/not-removed/not-muted (default-off)", async () => {
      await seedGroupWithMessage("cs-projection");
      const row = (await listScopes(pool)).find((r) => r.group === "cs-projection")!;
      expect(row).toMatchObject({
        included: false,
        categoryId: null,
        removed: false,
        muted: false,
      });
      expect(row.messageCount).toBe(1);
    });
  });

  describe("per-chat mute (§7 third state)", () => {
    it("upsertScope round-trips muted and listScopes projects it", async () => {
      const g = await seedGroupWithMessage("cs-mute");
      await upsertScope(pool, { groupId: g, included: true });
      expect((await listScopes(pool)).find((r) => r.group === "cs-mute")!.muted).toBe(false);
      await upsertScope(pool, { groupId: g, muted: true });
      const row = (await listScopes(pool)).find((r) => r.group === "cs-mute")!;
      // muting must not change inclusion — it still gets summarized.
      expect(row).toMatchObject({ included: true, muted: true });
      await upsertScope(pool, { groupId: g, muted: false });
      expect((await listScopes(pool)).find((r) => r.group === "cs-mute")!.muted).toBe(false);
    });

    it("listSuggestibleGroupIds excludes muted chats but listIncludedGroupIds keeps them", async () => {
      const plain = await seedGroupWithMessage("cs-sugg-plain");
      const muted = await seedGroupWithMessage("cs-sugg-muted");
      await upsertScope(pool, { groupId: plain, included: true });
      await upsertScope(pool, { groupId: muted, included: true, muted: true });

      const suggestible = await listSuggestibleGroupIds(pool);
      const included = await listIncludedGroupIds(pool);

      // muted chat is still summarized (included) ...
      expect(included).toEqual(expect.arrayContaining([plain, muted]));
      // ... but never produces suggestions.
      expect(suggestible).toContain(plain);
      expect(suggestible).not.toContain(muted);
    });
  });

  describe("isGroupIncluded", () => {
    it("isGroupIncluded reflects the scope row (default-off when unscoped)", async () => {
      const gid = await seedGroupWithMessage("cs-is-included");
      expect(await isGroupIncluded(pool, gid)).toBe(false); // unscoped → default off
      await upsertScope(pool, { groupId: gid, included: true });
      expect(await isGroupIncluded(pool, gid)).toBe(true);
      await upsertScope(pool, { groupId: gid, included: false });
      expect(await isGroupIncluded(pool, gid)).toBe(false);
    });
  });

  describe("getGroupCategoryName", () => {
    it("returns the assigned category name, or null when uncategorized", async () => {
      const gid = await seedGroupWithMessage(`cs-cat-${Math.random()}`);
      expect(await getGroupCategoryName(pool, gid)).toBeNull(); // unscoped → no category
      const cat = await createCategory(pool, `עבודה-${Math.random()}`);
      await upsertScope(pool, { groupId: gid, included: true, categoryId: cat.id });
      expect(await getGroupCategoryName(pool, gid)).toBe(cat.name);
    });
  });
});
