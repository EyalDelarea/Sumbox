import { describe, expect, it, vi } from "vitest";
import { streamSummary } from "./run-summary.js";
import type { SummaryOutput } from "./summarizer.js";

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

describe("streamSummary", () => {
  const indexMap = new Map<number, number>();

  it("accumulates tokens, emits each delta, parses, and commits via persist", async () => {
    const deltas: string[] = [];
    const persist = vi.fn(async (_output: SummaryOutput) => 77);

    const result = await streamSummary({
      tokens: fromChunks(["hel", "lo ", "world"]),
      indexMap,
      onToken: (d) => deltas.push(d),
      persist,
    });

    expect(deltas).toEqual(["hel", "lo ", "world"]);
    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      expect(result.summaryId).toBe(77);
      expect(result.output).toBeDefined();
    }
    expect(persist).toHaveBeenCalledOnce();
  });

  it("does NOT parse or commit when the signal aborted during streaming", async () => {
    const persist = vi.fn(async () => 1);
    const ac = new AbortController();

    // Abort mid-stream (as req/res 'close' would). The guard runs after the
    // token loop and before any commit.
    const result = await streamSummary({
      tokens: fromChunks(["a", "b"]),
      indexMap,
      signal: ac.signal,
      onToken: () => ac.abort(),
      persist,
    });

    expect(result.aborted).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("commits when a signal is present but never aborted", async () => {
    const persist = vi.fn(async () => 5);
    const ac = new AbortController();

    const result = await streamSummary({
      tokens: fromChunks(["x"]),
      indexMap,
      signal: ac.signal,
      persist,
    });

    expect(result.aborted).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("works without an onToken sink (batch-style caller)", async () => {
    const persist = vi.fn(async () => 9);
    const result = await streamSummary({ tokens: fromChunks(["done"]), indexMap, persist });
    expect(result.aborted).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
  });
});
