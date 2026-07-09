import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedSumbox } from "./prepare-sumbox.js";
import type { SummarizeAndPersistDeps } from "./run-summary.js";
import { summarizeAndPersist } from "./run-summary.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<SummarizeAndPersistDeps> = {}): SummarizeAndPersistDeps {
  return {
    pool: {} as never,
    prepareSumbox: vi.fn(),
    summarize: vi.fn(),
    insertSummary: vi.fn(),
    updateWatermark: vi.fn(),
    model: "test-model",
    tokenBudget: 24000,
    groupName: "TestGroup",
    ...overrides,
  };
}

// ── cache-hit path ────────────────────────────────────────────────────────────

describe("summarizeAndPersist — cache-hit", () => {
  it("returns cache-hit status and performs no writes", async () => {
    const cacheHitResult: PreparedSumbox = {
      kind: "cache-hit",
      summary: "Yesterday's summary",
      generatedAt: new Date("2026-06-04T08:00:00.000Z"),
    };

    const deps = makeDeps({
      prepareSumbox: vi.fn().mockResolvedValue(cacheHitResult),
    });

    const result = await summarizeAndPersist(deps, 42);

    expect(result).toEqual({ status: "cache-hit" });
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(deps.insertSummary).not.toHaveBeenCalled();
    expect(deps.updateWatermark).not.toHaveBeenCalled();
  });
});

// ── empty path ────────────────────────────────────────────────────────────────

describe("summarizeAndPersist — empty (no messages)", () => {
  it("returns cache-hit status and performs no writes when no messages exist", async () => {
    const emptyResult: PreparedSumbox = { kind: "empty" };

    const deps = makeDeps({
      prepareSumbox: vi.fn().mockResolvedValue(emptyResult),
    });

    const result = await summarizeAndPersist(deps, 42);

    expect(result).toEqual({ status: "cache-hit" });
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(deps.insertSummary).not.toHaveBeenCalled();
    expect(deps.updateWatermark).not.toHaveBeenCalled();
  });
});

// ── generated path ────────────────────────────────────────────────────────────

describe("summarizeAndPersist — new messages (generated)", () => {
  const groupId = 42;
  const newWatermark = { sentAt: new Date("2026-06-04T10:00:00.000Z"), messageId: 123 };
  const readyResult: PreparedSumbox = {
    kind: "ready",
    groupId,
    prompt: { system: "sys", user: "user prompt" },
    summaryType: "watermark",
    parameters: {
      fromExclusive: null,
      toInclusive: { sentAt: newWatermark.sentAt.toISOString(), messageId: 123 },
      messageCount: 5,
      usedFallback: false,
    },
    messageCount: 5,
    newWatermark,
    usedFallback: false,
  };

  let deps: SummarizeAndPersistDeps;

  beforeEach(() => {
    deps = makeDeps({
      prepareSumbox: vi.fn().mockResolvedValue(readyResult),
      summarize: vi.fn().mockResolvedValue("A great summary"),
      insertSummary: vi.fn().mockResolvedValue(99),
      updateWatermark: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("returns generated status", async () => {
    const result = await summarizeAndPersist(deps, groupId);
    expect(result).toEqual({ status: "generated" });
  });

  it("calls summarize with the prepared prompt", async () => {
    await summarizeAndPersist(deps, groupId);
    expect(deps.summarize).toHaveBeenCalledOnce();
    expect(deps.summarize).toHaveBeenCalledWith({ system: "sys", user: "user prompt" });
  });

  it("calls insertSummary with the generated text", async () => {
    await summarizeAndPersist(deps, groupId);
    expect(deps.insertSummary).toHaveBeenCalledOnce();
    const [, input] = (deps.insertSummary as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(input.groupId).toBe(groupId);
    // overview stays the full text (back-compat) and the row is now structured.
    expect(input.output.overview).toBe("A great summary");
    expect(input.output.version).toBe(2);
    expect(input.summaryType).toBe("watermark");
    expect(input.model).toBe("test-model");
  });

  it("calls updateWatermark with the new cursor", async () => {
    await summarizeAndPersist(deps, groupId);
    expect(deps.updateWatermark).toHaveBeenCalledOnce();
    const [, wGroupId, cursor] = (deps.updateWatermark as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(wGroupId).toBe(groupId);
    expect(cursor.sentAt.getTime()).toBe(newWatermark.sentAt.getTime());
    expect(cursor.messageId).toBe(newWatermark.messageId);
  });

  it("calls insertSummary BEFORE updateWatermark (summary first, watermark second)", async () => {
    const callOrder: string[] = [];
    deps = makeDeps({
      prepareSumbox: vi.fn().mockResolvedValue(readyResult),
      summarize: vi.fn().mockResolvedValue("A great summary"),
      insertSummary: vi.fn().mockImplementation(async () => {
        callOrder.push("insertSummary");
        return 1;
      }),
      updateWatermark: vi.fn().mockImplementation(async () => {
        callOrder.push("updateWatermark");
      }),
    });

    await summarizeAndPersist(deps, groupId);

    expect(callOrder).toEqual(["insertSummary", "updateWatermark"]);
  });
});

// ── entity extraction wiring (TRG-1 regression lock) ───────────────────────────

describe("summarizeAndPersist — entity extraction", () => {
  const groupId = 42;
  const newWatermark = { sentAt: new Date("2026-06-04T10:00:00.000Z"), messageId: 123 };
  const readyResult: PreparedSumbox = {
    kind: "ready",
    groupId,
    prompt: { system: "sys", user: "user prompt" },
    summaryType: "watermark",
    parameters: {
      fromExclusive: null,
      toInclusive: { sentAt: newWatermark.sentAt.toISOString(), messageId: 123 },
      messageCount: 5,
      usedFallback: false,
    },
    messageCount: 5,
    newWatermark,
    usedFallback: false,
  };

  it("runs the injected extraction with the structured output after a generated summary", async () => {
    const refreshEntities = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      prepareSumbox: vi.fn().mockResolvedValue(readyResult),
      summarize: vi.fn().mockResolvedValue("A great summary"),
      insertSummary: vi.fn().mockResolvedValue(99),
      updateWatermark: vi.fn().mockResolvedValue(undefined),
      refreshEntities,
    });

    await summarizeAndPersist(deps, groupId);

    expect(refreshEntities).toHaveBeenCalledOnce();
    const [, gid, output] = refreshEntities.mock.calls[0]!;
    expect(gid).toBe(groupId);
    expect(output.version).toBe(2);
  });

  it("does NOT extract on a cache-hit (no fresh messages)", async () => {
    const refreshEntities = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      prepareSumbox: vi.fn().mockResolvedValue({
        kind: "cache-hit",
        summary: "y",
        generatedAt: new Date("2026-06-04T08:00:00.000Z"),
      } satisfies PreparedSumbox),
      refreshEntities,
    });

    await summarizeAndPersist(deps, groupId);

    expect(refreshEntities).not.toHaveBeenCalled();
  });
});

// ── failure isolation ─────────────────────────────────────────────────────────

describe("summarizeAndPersist — failure isolation", () => {
  it("does not advance watermark if insertSummary throws", async () => {
    const newWatermark = { sentAt: new Date("2026-06-04T10:00:00.000Z"), messageId: 1 };
    const readyResult: PreparedSumbox = {
      kind: "ready",
      groupId: 1,
      prompt: { system: "s", user: "u" },
      summaryType: "watermark",
      parameters: {
        fromExclusive: null,
        toInclusive: { sentAt: newWatermark.sentAt.toISOString(), messageId: 1 },
        messageCount: 1,
        usedFallback: false,
      },
      messageCount: 1,
      newWatermark,
      usedFallback: false,
    };

    const deps = makeDeps({
      prepareSumbox: vi.fn().mockResolvedValue(readyResult),
      summarize: vi.fn().mockResolvedValue("text"),
      insertSummary: vi.fn().mockRejectedValue(new Error("DB write failed")),
      updateWatermark: vi.fn(),
    });

    await expect(summarizeAndPersist(deps, 1)).rejects.toThrow("DB write failed");
    expect(deps.updateWatermark).not.toHaveBeenCalled();
  });
});
