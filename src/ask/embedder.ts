import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/**
 * Turns text into a bge-m3 embedding vector via Ollama, for the `ask` (@Aida)
 * feature's semantic retrieval. Kept behind an interface so the repository and
 * the sweep depend on the capability, not on Ollama — and so tests inject a
 * deterministic fake instead of a live model.
 */
export interface Embedder {
  /** Embed one string. Throws on transport failure or a wrong-dimension vector. */
  embed(text: string): Promise<number[]>;
}

/** Injected transport (tests pass a fake); prod uses the node:http default. */
type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export type OllamaEmbedderOptions = {
  host: string;
  model: string;
  /** Expected vector length. A mismatch throws — a wrong-sized vector must never
   *  reach the `vector(N)` column as a silent bad row. */
  dim: number;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
};

export class OllamaEmbedder implements Embedder {
  private readonly host: string;
  private readonly model: string;
  private readonly dim: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OllamaEmbedderOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.model = opts.model;
    this.dim = opts.dim;
    this.fetchImpl = opts.fetchImpl ?? nodeHttpTransport(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async embed(text: string): Promise<number[]> {
    let res: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      res = await this.fetchImpl(`${this.host}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama not reachable at ${this.host} (${m}). Is it running?`);
    }
    if (!res.ok) throw new Error(`Ollama embed failed: HTTP ${res.status}.`);

    const body = (await res.json()) as { embeddings?: number[][] };
    const vec = body.embeddings?.[0];
    if (!vec || vec.length === 0) {
      throw new Error("Ollama returned no embedding.");
    }
    if (vec.length !== this.dim) {
      // A dimension mismatch means the wrong model or a config drift; inserting
      // it would fail the vector(N) column anyway, so fail here with a clear cause.
      throw new Error(
        `Embedding dimension ${vec.length} != expected ${this.dim} (model ${this.model}).`,
      );
    }
    return vec;
  }
}

// ── node:http transport ─────────────────────────────────────────────────────
// Mirrors the summarizer's transport: node:http avoids undici's 300s
// headersTimeout on a cold model load.
function nodeHttpTransport(timeoutMs: number): FetchImpl {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: init.method,
          headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
              status: res.statusCode ?? 0,
              json: async () => JSON.parse(text),
            });
          });
        },
      );
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error(`embed timed out after ${timeoutMs}ms`)),
      );
      req.on("error", reject);
      req.write(init.body);
      req.end();
    });
}
