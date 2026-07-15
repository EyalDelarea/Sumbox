import { describe, expect, it } from "vitest";
import { OllamaEmbedder } from "./embedder.js";

function fakeFetch(captured: { body?: unknown }, vec: number[]) {
  return async (_url: string, init: { body: string }) => {
    captured.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ embeddings: [vec] }) };
  };
}

const opts = { host: "http://localhost:11434", model: "bge-m3", dim: 4 };

describe("OllamaEmbedder", () => {
  it("posts the text to /api/embed and returns the vector", async () => {
    const captured: { body?: any } = {};
    const e = new OllamaEmbedder({ ...opts, fetchImpl: fakeFetch(captured, [0.1, 0.2, 0.3, 0.4]) });
    const v = await e.embed("נפגשים בשמונה");
    expect(v).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(captured.body).toEqual({ model: "bge-m3", input: "נפגשים בשמונה" });
  });

  it("rejects a wrong-dimension vector rather than letting a bad row reach the column", async () => {
    // vector(1024) would reject it anyway; failing here names the real cause
    // (wrong model / config drift) instead of a cryptic DB error.
    const e = new OllamaEmbedder({ ...opts, fetchImpl: fakeFetch({}, [0.1, 0.2]) }); // dim 2 != 4
    await expect(e.embed("x")).rejects.toThrow(/dimension 2 != expected 4/i);
  });

  it("throws a clear error on an empty embedding", async () => {
    const e = new OllamaEmbedder({
      ...opts,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ embeddings: [[]] }) }),
    });
    await expect(e.embed("x")).rejects.toThrow(/no embedding/i);
  });

  it("throws a clear error when Ollama is unreachable", async () => {
    const e = new OllamaEmbedder({
      ...opts,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(e.embed("x")).rejects.toThrow(/not reachable/i);
  });

  it("throws on a non-2xx response", async () => {
    const e = new OllamaEmbedder({
      ...opts,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    await expect(e.embed("x")).rejects.toThrow(/HTTP 500/);
  });
});
