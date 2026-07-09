/**
 * OllamaVisionAnalyzer — calls a local Ollama multimodal model to describe an image.
 *
 * Transport: defaults to node:http (NOT global fetch) because Node's fetch/undici imposes
 * a 300s headersTimeout, and a local vision model can take longer than that to COLD-LOAD
 * under memory pressure (e.g. when a large summary model is also resident). node:http uses
 * a generous socket timeout instead. A `fetchFn` is injectable for tests. The request also
 * sets `keep_alive` so the model stays resident between calls (avoids repeated slow cold-loads
 * during a backlog run).
 *
 * The constrained Hebrew prompt instructs the model to:
 * - Describe only what is visible
 * - Transcribe any visible text (OCR)
 * - Say if something is unclear; never invent details
 * - Avoid preamble ("Sure, I can..." / "This image shows...")
 */
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { VisionAnalyzer } from "./analyzer.js";

/** Minimal response shape used here (satisfied by both fetch's Response and the node:http default). */
type HttpResponseLike = { ok: boolean; status: number; json: () => Promise<unknown> };

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponseLike>;

export type OllamaVisionAnalyzerOptions = {
  host: string;
  model: string;
  /** Injectable for tests; defaults to a node:http transport with a generous socket timeout. */
  fetchFn?: FetchFn;
  /** Socket inactivity timeout in ms (default 15 min) — generous for cold model loads. */
  timeoutMs?: number;
  /** How long Ollama keeps the model resident between calls (default "10m"). */
  keepAlive?: string;
  /** Context window (num_ctx). Small by default — a large ctx blows up KV-cache memory. */
  numCtx?: number;
};

const HEBREW_PROMPT = `תאר בעברית בלבד את מה שמופיע בתמונה. כתוב תיאור ממוקד של מה שרואים.
אם יש טקסט גלוי, העתק אותו מילה במילה. אם משהו לא ברור, ציין זאת. אל תמציא פרטים שאינם בתמונה.
אל תפתח בפרמול כמו "כמובן" או "התמונה מציגה" — עבור ישר לתיאור.`;

// Multi-frame (video) prompt: the images are sequential frames from one clip.
const HEBREW_VIDEO_PROMPT = `התמונות הבאות הן פריימים רצופים מתוך סרטון אחד, לפי סדר הזמן.
תאר בעברית בלבד מה קורה בסרטון לאורך הפריימים — פעולות, תנועה ושינויים בין הפריימים.
אם יש טקסט גלוי, העתק אותו מילה במילה. אם משהו לא ברור, ציין זאת. אל תמציא פרטים שאינם בפריימים.
אל תפתח בפרמול כמו "כמובן" או "הסרטון מציג" — עבור ישר לתיאור.`;

/** Default transport over node:http(s) with a generous socket timeout (no undici headersTimeout). */
function nodeHttpTransport(timeoutMs: number): FetchFn {
  return (url, init) =>
    new Promise<HttpResponseLike>((resolve, reject) => {
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
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => JSON.parse(data),
            });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`socket timeout after ${timeoutMs}ms`));
      });
      req.write(init.body);
      req.end();
    });
}

export class OllamaVisionAnalyzer implements VisionAnalyzer {
  private readonly host: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;
  private readonly keepAlive: string;
  private readonly numCtx: number;

  constructor(opts: OllamaVisionAnalyzerOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.model = opts.model;
    this.keepAlive = opts.keepAlive ?? "10m";
    this.numCtx = opts.numCtx ?? 8192;
    this.fetchFn = opts.fetchFn ?? nodeHttpTransport(opts.timeoutMs ?? 15 * 60 * 1000);
  }

  async describeImage(imagePath: string): Promise<{ description: string; engine: string }> {
    return this.describeImages([imagePath]);
  }

  async describeImages(imagePaths: string[]): Promise<{ description: string; engine: string }> {
    if (imagePaths.length === 0) {
      throw new Error("OllamaVisionAnalyzer: describeImages called with no images");
    }
    const buffers = await Promise.all(imagePaths.map((p) => fsp.readFile(p)));
    const images = buffers.map((b) => b.toString("base64"));
    // A single frame is just an image; multiple frames are a video sequence.
    const prompt = images.length > 1 ? HEBREW_VIDEO_PROMPT : HEBREW_PROMPT;

    const url = `${this.host}/api/generate`;
    const body = {
      model: this.model,
      prompt,
      images,
      stream: false,
      // Disable thinking: Gemma 4 is a reasoning model and will otherwise spend the
      // entire num_predict budget on hidden thinking tokens and return an EMPTY caption
      // (done_reason="length", response=""). We want the description directly. Harmless
      // (ignored) for non-thinking models like qwen2.5vl.
      think: false,
      keep_alive: this.keepAlive,
      // repeat_penalty + num_predict guard against degenerate repetition loops
      // (qwen2.5vl occasionally spews "GF_GF_GF…"); num_ctx capped for memory.
      options: { temperature: 0.1, num_ctx: this.numCtx, num_predict: 512, repeat_penalty: 1.3 },
    };

    let res: HttpResponseLike;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
      const causeStr = cause ? ` — cause: ${cause.code ?? cause.message ?? String(cause)}` : "";
      throw new Error(`OllamaVisionAnalyzer: request failed (${m}${causeStr}). Is Ollama running?`);
    }

    if (!res.ok) {
      throw new Error(`OllamaVisionAnalyzer: HTTP ${res.status} from ${url}.`);
    }

    const json = (await res.json()) as { response?: string; error?: string };
    if (json.error) {
      throw new Error(`OllamaVisionAnalyzer: model error — ${json.error}`);
    }

    const description = sanitizeDescription(json.response ?? "");
    return { description, engine: this.model };
  }
}

/**
 * Strip the stray "_GF_" artifact qwen2.5vl sometimes emits (incl. degenerate
 * "GF_GF_GF…" runs), then collapse whitespace. Best-effort cleanup; the repeat_penalty
 * + num_predict options are the primary guard against the degeneration.
 */
export function sanitizeDescription(raw: string): string {
  return raw
    .replace(/_{0,}GF_{1,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
