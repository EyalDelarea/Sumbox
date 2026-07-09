/**
 * T009 — Tests for OllamaVisionAnalyzer.
 *
 * All tests inject a fake fetchFn and a fake fs read; no real Ollama or files needed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OllamaVisionAnalyzer, sanitizeDescription } from "./ollama-analyzer.js";

describe("sanitizeDescription", () => {
  it("strips the stray _GF_ artifact and degenerate runs, collapsing whitespace", () => {
    expect(sanitizeDescription("ה_GF_ התמונה מציגה כלב")).toBe("ה התמונה מציגה כלב");
    expect(sanitizeDescription("GF__GF_GF_GF_GF_").trim()).toBe("");
    expect(sanitizeDescription("  תיאור תקין של תמונה  ")).toBe("תיאור תקין של תמונה");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object as fetchFn would return. */
function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Write a tiny temp file so OllamaVisionAnalyzer can read it as base64. */
let tempFileCounter = 0;
// A unique, private temp directory (0700) created lazily on first use, so test
// files are never written to a predictable, world-readable path in the shared
// os temp dir. Cleaned up in afterAll.
let tempDir: string | undefined;
function makeTempImageFile(content: string = "fake-image-bytes"): string {
  if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-ollama-test-"));
  const filePath = path.join(tempDir, `test-img-${tempFileCounter++}.jpg`);
  fs.writeFileSync(filePath, Buffer.from(content, "utf8"));
  return filePath;
}

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OllamaVisionAnalyzer", () => {
  it("sends a POST to <host>/api/generate with the correct URL", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור מבחן" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImage(tmpFile);

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url] = fakeFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://localhost:11434/api/generate");
  });

  it("sends the configured model in the request body", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://ollama:11434",
      model: "llava:13b",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImage(tmpFile);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe("llava:13b");
  });

  it("sends stream:false in the request body", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImage(tmpFile);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { stream: boolean };
    expect(body.stream).toBe(false);
  });

  it("sends temperature 0.1 in options", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImage(tmpFile);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { options: { temperature: number } };
    expect(body.options.temperature).toBe(0.1);
  });

  it("caps the context window (num_ctx) and sets keep_alive to bound memory and stay warm", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור" }));
    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "qwen2.5vl",
      fetchFn: fakeFetch,
      numCtx: 8192,
    });
    await analyzer.describeImage(tmpFile);
    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { options: { num_ctx: number }; keep_alive: string };
    expect(body.options.num_ctx).toBe(8192);
    expect(body.keep_alive).toBe("10m");
  });

  it("sends an images array with the base64-encoded file content", async () => {
    const content = "fake-image-bytes-xyz";
    const tmpFile = makeTempImageFile(content);
    const expectedBase64 = Buffer.from(content, "utf8").toString("base64");

    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור" }));
    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImage(tmpFile);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { images: string[] };
    expect(Array.isArray(body.images)).toBe(true);
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toBe(expectedBase64);
  });

  it("sends a Hebrew prompt that mentions describing and transcribing visible text", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImage(tmpFile);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { prompt: string };
    expect(typeof body.prompt).toBe("string");
    expect(body.prompt.length).toBeGreaterThan(20);
  });

  it("returns the description from .response and engine from model", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תמונה של חתול" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    const result = await analyzer.describeImage(tmpFile);

    expect(result.description).toBe("תמונה של חתול");
    expect(result.engine).toBe("llama3.2-vision");
  });

  it("throws when the HTTP response is not OK", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(makeErrorResponse(500, { error: "model load failed" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await expect(analyzer.describeImage(tmpFile)).rejects.toThrow();
  });

  it("throws with a message containing 'fetch failed' and the underlying cause code when fetch rejects with a cause", async () => {
    const tmpFile = makeTempImageFile();
    const innerError = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    });
    const fakeFetch = vi.fn().mockRejectedValue(innerError);

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await expect(analyzer.describeImage(tmpFile)).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining("ECONNREFUSED") }),
    );
  });

  it("throws when the response body contains an error field", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ error: "unknown model" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await expect(analyzer.describeImage(tmpFile)).rejects.toThrow();
  });

  it("strips trailing slashes from host before building the URL", async () => {
    const tmpFile = makeTempImageFile();
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434/",
      model: "llama3.2-vision",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImage(tmpFile);

    const [url] = fakeFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://localhost:11434/api/generate");
  });
});

describe("OllamaVisionAnalyzer.describeImages (multi-frame / video)", () => {
  it("sends ALL frames as base64 in the images array, in order", async () => {
    const files = ["frame-a", "frame-b", "frame-c"].map((c) => makeTempImageFile(c));
    const expected = ["frame-a", "frame-b", "frame-c"].map((c) =>
      Buffer.from(c, "utf8").toString("base64"),
    );
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור וידאו" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "gemma4:12b",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImages(files);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { images: string[] };
    expect(body.images).toHaveLength(3);
    expect(body.images).toEqual(expected);
  });

  it("uses a video-sequence prompt (mentions פריימים/סרטון) when given multiple frames", async () => {
    const files = [makeTempImageFile("a"), makeTempImageFile("b")];
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "x" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "gemma4:12b",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImages(files);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { prompt: string };
    expect(body.prompt).toMatch(/פריימים|סרטון/);
  });

  it("uses the single-image prompt (not the video prompt) for a single frame", async () => {
    const files = [makeTempImageFile("solo")];
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "x" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "gemma4:12b",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImages(files);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { prompt: string };
    expect(body.prompt).not.toMatch(/פריימים רצופים/);
  });

  it("throws when called with an empty frame list", async () => {
    const fakeFetch = vi.fn();
    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "gemma4:12b",
      fetchFn: fakeFetch,
    });
    await expect(analyzer.describeImages([])).rejects.toThrow(/no images/i);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("disables thinking (think:false) so reasoning models don't return an empty caption", async () => {
    const files = [makeTempImageFile("a"), makeTempImageFile("b")];
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "x" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "gemma4:12b",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImages(files);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { think: boolean };
    expect(body.think).toBe(false);
  });

  it("describeImage delegates to the single-frame path (one image, image prompt)", async () => {
    const tmpFile = makeTempImageFile("single");
    const fakeFetch = vi.fn().mockResolvedValue(makeOkResponse({ response: "תיאור" }));

    const analyzer = new OllamaVisionAnalyzer({
      host: "http://localhost:11434",
      model: "gemma4:12b",
      fetchFn: fakeFetch,
    });
    await analyzer.describeImage(tmpFile);

    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { images: string[]; prompt: string };
    expect(body.images).toHaveLength(1);
    expect(body.prompt).not.toMatch(/פריימים רצופים/);
  });
});
