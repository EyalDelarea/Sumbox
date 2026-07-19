import { describe, expect, it } from "vitest";
import { assertLocal, type DatasetApi, syncDataset, toDatasetItem } from "./dataset-sync.js";
import type { GoldenItem } from "./golden.js";

const item = (over: Partial<GoldenItem> = {}): GoldenItem => ({
  id: "g-1",
  groupId: 70,
  question: "מה נאמר?",
  goldExternalIds: ["3ABC"],
  mustNotRefuse: true,
  expectedToolCalls: ["search_chat"],
  slice: ["recency:<5m"],
  provenance: { added: "2026-07-16", reason: "unit" },
  ...over,
});

function fakeApi() {
  const calls: { ensured: string[]; items: Record<string, unknown>[] } = { ensured: [], items: [] };
  const api: DatasetApi = {
    ensureDataset: async (name) => {
      calls.ensured.push(name);
    },
    upsertItem: async (i) => {
      calls.items.push(i as unknown as Record<string, unknown>);
    },
  };
  return { api, calls };
}

const LOCAL = { baseUrl: "http://localhost:3000", datasetName: "aida-golden" };

describe("assertLocal — the privacy guard", () => {
  // @langfuse/client POSTs wherever LANGFUSE_BASEURL points and does NOT go
  // through the exporter's check. Golden items quote real group messages.
  it.each(["https://cloud.langfuse.com", "http://192.0.2.10:3000", "https://langfuse.example.com"])(
    "refuses a non-local baseUrl: %s",
    (url) => {
      expect(() => assertLocal(url)).toThrow(/never leave the device/);
    },
  );

  it.each(["http://localhost:3000", "http://127.0.0.1:3000"])("allows local: %s", (url) => {
    expect(() => assertLocal(url)).not.toThrow();
  });

  it("syncDataset refuses BEFORE writing anything", async () => {
    const { api, calls } = fakeApi();
    await expect(
      syncDataset(api, { baseUrl: "https://cloud.langfuse.com", datasetName: "x" }, [item()]),
    ).rejects.toThrow(/never leave the device/);
    // Fails closed: nothing was created and no content was sent.
    expect(calls.ensured).toEqual([]);
    expect(calls.items).toEqual([]);
  });
});

describe("toDatasetItem", () => {
  it("carries assertions, not an expected answer string", () => {
    const d = toDatasetItem("aida-golden", item());
    expect(d.id).toBe("g-1");
    expect(d.input).toEqual({ question: "מה נאמר?", groupId: 70 });
    expect(d.expectedOutput).toEqual({
      goldExternalIds: ["3ABC"],
      mustNotRefuse: true,
      expectedToolCalls: ["search_chat"],
    });
    expect(d.metadata).toMatchObject({ slice: ["recency:<5m"] });
  });

  it("defaults expectedToolCalls to an empty array", () => {
    const d = toDatasetItem("x", item({ expectedToolCalls: undefined as never }));
    expect((d.expectedOutput as { expectedToolCalls: string[] }).expectedToolCalls).toEqual([]);
  });
});

describe("syncDataset", () => {
  it("ensures the dataset then upserts every item", async () => {
    const { api, calls } = fakeApi();
    const r = await syncDataset(api, LOCAL, [item({ id: "a" }), item({ id: "b" })]);
    expect(calls.ensured).toEqual(["aida-golden"]);
    expect(calls.items.map((i) => i["id"])).toEqual(["a", "b"]);
    expect(r).toEqual({ dataset: "aida-golden", synced: 2 });
  });

  it("upserts by id so a re-run updates rather than duplicating", async () => {
    // A duplicate would silently double that item's weight in the aggregate.
    const { api, calls } = fakeApi();
    await syncDataset(api, LOCAL, [item({ id: "a" })]);
    await syncDataset(api, LOCAL, [item({ id: "a", question: "edited" })]);
    expect(calls.items.map((i) => i["id"])).toEqual(["a", "a"]);
    expect(calls.items[1]).toMatchObject({ input: { question: "edited" } });
  });
});
