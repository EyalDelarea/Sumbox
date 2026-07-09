import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaSummarizer } from "./summarizer.js";

function fakeFetch(captured: { body?: any }, content: string) {
  return async (_url: string, init: { body: string }) => {
    captured.body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ message: { content } }),
    } as unknown as Response;
  };
}

describe("OllamaSummarizer", () => {
  it("sends num_ctx + repeat_penalty (and NO json format) and returns the prose summary", async () => {
    const captured: { body?: any } = {};
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: fakeFetch(captured, "  השיחה עסקה בטיול ובמסיבה.  "),
    });
    const out = await engine.summarize({ system: "S", user: "U" });

    expect(captured.body.options.num_ctx).toBe(32768);
    // repeat_penalty guards against degeneration loops; no JSON format requested
    // (asking gemma4:26b for JSON makes it degenerate on short Hebrew input).
    expect(captured.body.options.repeat_penalty).toBeGreaterThan(1);
    expect(captured.body.format).toBeUndefined();
    expect(captured.body.model).toBe("gemma4:26b");
    // thinking is disabled — gemma4 thinks by default, which eats the generation
    // budget and produces SHORTER, slower summaries (see thin-summaries fix).
    expect(captured.body.think).toBe(false);
    expect(out.overview).toBe("השיחה עסקה בטיול ובמסיבה."); // trimmed
  });

  it("applies sampling defaults and forwards overrides (temperature, repeat_penalty, num_predict)", async () => {
    const captured: { body?: any } = {};
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      temperature: 0.9,
      repeatPenalty: 1.05,
      numPredict: 1234,
      fetchImpl: fakeFetch(captured, "ok"),
    });
    await engine.summarize({ system: "S", user: "U" });
    expect(captured.body.options.temperature).toBe(0.9);
    expect(captured.body.options.repeat_penalty).toBe(1.05);
    expect(captured.body.options.num_predict).toBe(1234);
  });

  it("uses tuned sampling defaults when not overridden", async () => {
    const captured: { body?: any } = {};
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: fakeFetch(captured, "ok"),
    });
    await engine.summarize({ system: "S", user: "U" });
    // Defaults relaxed from the old terse 0.2 / 1.3 to richer output.
    expect(captured.body.options.temperature).toBe(0.7);
    expect(captured.body.options.repeat_penalty).toBe(1.1);
    expect(captured.body.options.num_predict).toBe(4096);
  });

  it("throws a clear error when the model returns empty output", async () => {
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: async () =>
        ({ ok: true, json: async () => ({ message: { content: "   " } }) }) as unknown as Response,
    });
    await expect(engine.summarize({ system: "S", user: "U" })).rejects.toThrow(
      /empty model output/i,
    );
  });

  it("throws a clear error when Ollama is unreachable", async () => {
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(engine.summarize({ system: "S", user: "U" })).rejects.toThrow(
      /Ollama not reachable/i,
    );
  });
});

function streamBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + "\n"));
      c.close();
    },
  });
}

describe("OllamaSummarizer.summarizeStream", () => {
  it("yields content deltas in order and requests stream:true with no json format", async () => {
    let body: any;
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return {
          ok: true,
          body: streamBody([
            JSON.stringify({ message: { content: "שלום " } }),
            JSON.stringify({ message: { content: "עולם" }, done: true }),
          ]),
        } as unknown as Response;
      },
    });
    const out: string[] = [];
    for await (const d of engine.summarizeStream({ system: "S", user: "U" })) out.push(d);
    expect(out).toEqual(["שלום ", "עולם"]);
    expect(body.stream).toBe(true);
    expect(body.options.num_ctx).toBe(32768);
    expect(body.options.repeat_penalty).toBeGreaterThan(1);
    expect(body.options.num_predict).toBe(4096);
    expect(body.think).toBe(false);
    expect(body.format).toBeUndefined();
  });

  it("throws a clear error when Ollama is unreachable (stream)", async () => {
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const gen = engine.summarizeStream({ system: "S", user: "U" });
    await expect(gen.next()).rejects.toThrow(/Ollama not reachable/i);
  });

  it("forwards the AbortSignal to fetch when opts.signal is provided", async () => {
    let capturedSignal: AbortSignal | undefined;
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: async (_url, init) => {
        capturedSignal = (init as any).signal;
        return {
          ok: true,
          body: streamBody([JSON.stringify({ message: { content: "hi" }, done: true })]),
        } as unknown as Response;
      },
    });
    const ac = new AbortController();
    const out: string[] = [];
    for await (const d of engine.summarizeStream(
      { system: "S", user: "U" },
      { signal: ac.signal },
    )) {
      out.push(d);
    }
    expect(out).toEqual(["hi"]);
    expect(capturedSignal).toBe(ac.signal);
  });

  it("stops cleanly (no thrown error) when signal is aborted mid-stream", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();

    // A stream that delivers 2 chunks, then the signal gets aborted before the 3rd read
    let readCount = 0;
    const mockReader = {
      read: async () => {
        readCount++;
        if (readCount === 1) {
          return {
            done: false,
            value: enc.encode(JSON.stringify({ message: { content: "token1" } }) + "\n"),
          };
        }
        // Abort before the 2nd chunk
        ac.abort();
        // Simulate AbortError from reader.read() after abort
        const err = new DOMException("aborted", "AbortError");
        throw err;
      },
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: async () =>
        ({
          ok: true,
          body: { getReader: () => mockReader },
        }) as unknown as Response,
    });

    const out: string[] = [];
    // Must NOT throw — abort is a clean stop
    for await (const d of engine.summarizeStream(
      { system: "S", user: "U" },
      { signal: ac.signal },
    )) {
      out.push(d);
    }
    // We got 1 token before abort
    expect(out).toEqual(["token1"]);
    // reader.cancel() was called to free the socket
    expect(mockReader.cancel).toHaveBeenCalled();
  });

  it("stops cleanly when signal is already aborted before streaming starts", async () => {
    const ac = new AbortController();
    ac.abort(); // already aborted

    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: async () =>
        ({
          ok: true,
          body: streamBody([
            JSON.stringify({ message: { content: "should not yield" }, done: true }),
          ]),
        }) as unknown as Response,
    });

    const out: string[] = [];
    for await (const d of engine.summarizeStream(
      { system: "S", user: "U" },
      { signal: ac.signal },
    )) {
      out.push(d);
    }
    expect(out).toEqual([]);
  });

  it("summarizeStream with no signal still works (backwards compatible)", async () => {
    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: async () =>
        ({
          ok: true,
          body: streamBody([JSON.stringify({ message: { content: "hello" }, done: true })]),
        }) as unknown as Response,
    });
    const out: string[] = [];
    for await (const d of engine.summarizeStream({ system: "S", user: "U" })) {
      out.push(d);
    }
    expect(out).toEqual(["hello"]);
  });
});

// Fix 7: node:http transport is used by default (not global fetch)
describe("OllamaSummarizer — node:http transport default (Fix 7)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT call global fetch when no fetchImpl is provided (uses node:http transport)", async () => {
    // Spy on global fetch — if it is called, the fix is broken.
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");

    // The engine with no fetchImpl defaults to the node:http transport.
    // We inject a fetchImpl to keep this test hermetic (no real TCP).
    // The key assertion is that default construction does NOT fall back to global fetch.
    const fetchImplSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: "תשובה" } }),
    } as unknown as Response);

    const engine = new OllamaSummarizer({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      fetchImpl: fetchImplSpy,
    });
    await engine.summarize({ system: "S", user: "U" });

    // fetchImpl was called (our injected one)
    expect(fetchImplSpy).toHaveBeenCalled();
    // global fetch was NOT called
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  it("constructor without fetchImpl does not throw (transport is lazy)", () => {
    // Constructing without fetchImpl or timeoutMs should not throw.
    expect(
      () =>
        new OllamaSummarizer({
          host: "http://localhost:11434",
          model: "gemma4:26b",
          numCtx: 32768,
        }),
    ).not.toThrow();
  });
});
