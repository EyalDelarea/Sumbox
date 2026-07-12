import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { getLogger } from "../logging/log.js";

const log = getLogger("summarizer");

/** A summary bullet, optionally linked to the message it was drawn from. */
export type SummaryBullet = {
  text: string;
  /** messages.id of the single most relevant source line, when resolvable. */
  sourceMessageId?: number;
};

/** Fielded summary (S3+). Discriminated by `version: 2`. */
export type StructuredSummary = {
  version: 2;
  /**
   * The FULL markdown summary. Kept as the back-compat field every legacy reader
   * (history UI, copy, sumbox cache) already renders, and verbatim for "העתק סיכום".
   */
  overview: string;
  /** The ## תקציר TL;DR line — the new §3 card's summary section. */
  tldr: string;
  /** נושאים עיקריים */
  topics: SummaryBullet[];
  /** החלטות ומשימות */
  decisions: SummaryBullet[];
  /** שאלות פתוחות */
  openQuestions: SummaryBullet[];
  /** Explicit owner/task items (overlaps the meetings/to-dos slice). */
  actionItems: SummaryBullet[];
};

/** Legacy prose shape — rows written before S3. */
export type LegacySummary = {
  /** Prose summary in the conversation's language ("what you missed"). */
  overview: string;
};

/**
 * Persisted/served summary output. The engine streams prose and returns a
 * {@link LegacySummary}; the /api/summarize handler parses it into a
 * {@link StructuredSummary} before persisting. Discriminate with
 * `"version" in output && output.version === 2`, never on field presence
 * (a structured summary may have all arrays empty).
 */
export type SummaryOutput = StructuredSummary | LegacySummary;

export type SummaryPrompt = {
  system: string;
  user: string;
};

/**
 * What one generation actually cost, as reported by Ollama — not estimated.
 *
 * `estimateTokens()` is a chars/4 heuristic tuned for English; Hebrew tokenizes
 * at roughly half that, so it under-counts by ~2.17x. The only way to see the
 * true size of a prompt (and whether it left the model any room to answer) is to
 * read back what the engine counted. Persisted onto the summary row so the
 * token budget can be calibrated against the real distribution.
 */
export type GenUsage = {
  /** Real input tokens (Ollama's `prompt_eval_count`). */
  promptTokens: number;
  /** Real output tokens (Ollama's `eval_count`). */
  evalTokens: number;
  /** `stop` = finished; `length` = ran out of room. */
  doneReason: string;
  /**
   * The summary was cut off mid-sentence. num_ctx is shared between prompt and
   * response, so an oversized prompt starves the answer: eval_count comes back
   * as exactly (num_ctx - prompt_eval_count) and done_reason is `length`.
   */
  truncated: boolean;
  /** Time spent ingesting the prompt — the dominant cost on a large input. */
  promptMs: number;
  /** Time spent generating. */
  evalMs: number;
};

/** Per-call options shared by the streaming and non-streaming entry points. */
export type SummarizeOpts = {
  signal?: AbortSignal;
  /** Invoked once, after the engine reports what the generation cost. */
  onUsage?: (usage: GenUsage) => void;
};

/** Ollama's usage fields, present on the non-streaming body and the final stream chunk. */
type OllamaDone = {
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
};

/**
 * Ollama reports durations in nanoseconds.
 *
 * Returns undefined — never a zero-filled GenUsage — when the engine did not
 * report the token counts. This telemetry exists to be calibration data: a row
 * of fabricated zeros is indistinguishable from a real measurement and would
 * drag the estimated-vs-real ratio DOWN, toward the false conclusion that the
 * chars/4 estimate is fine. A missing `done_reason` would likewise silently
 * disarm `truncated`. Absent must stay absent.
 */
function toUsage(d: OllamaDone): GenUsage | undefined {
  if (d.prompt_eval_count === undefined || d.done_reason === undefined) return undefined;
  return {
    promptTokens: d.prompt_eval_count,
    evalTokens: d.eval_count ?? 0,
    doneReason: d.done_reason,
    truncated: d.done_reason === "length",
    promptMs: Math.round((d.prompt_eval_duration ?? 0) / 1e6),
    evalMs: Math.round((d.eval_duration ?? 0) / 1e6),
  };
}

/** One NDJSON chunk off the stream. */
type StreamChunk = { message?: { content?: string }; done?: boolean } & OllamaDone;

/**
 * Parse one stream line, or undefined if it is not JSON. An unparseable line is
 * logged rather than dropped in silence — now that the persisted row depends on
 * the done chunk arriving, the line thrown away could BE the done chunk.
 */
function parseChunk(line: string): StreamChunk | undefined {
  try {
    return JSON.parse(line) as StreamChunk;
  } catch {
    log.warn({ line: line.slice(0, 120) }, "unparseable line in Ollama stream — skipped");
    return undefined;
  }
}

/**
 * Hand usage to the caller's sink. Telemetry must never be able to kill the
 * generation it measures — a throwing sink would otherwise discard a summary
 * that already succeeded (and, on the streaming path, one already rendered to
 * the user). A missing report is logged rather than swallowed: the production
 * engine is always Ollama, so it should never legitimately fail to report.
 */
function reportUsage(usage: GenUsage | undefined, onUsage: SummarizeOpts["onUsage"]): void {
  if (!onUsage) return;
  if (!usage) {
    log.warn("generation reported no usage — this row will carry no token counts");
    return;
  }
  try {
    onUsage(usage);
  } catch (err) {
    log.error({ err }, "onUsage sink threw — telemetry dropped, summary kept");
  }
}

/**
 * A summarization engine. summarize() sends an assembled prompt to a model and
 * returns the prose summary. Throws on transport/empty-output failure.
 */
export interface Summarizer {
  summarize(prompt: SummaryPrompt, opts?: SummarizeOpts): Promise<SummaryOutput>;
}

/** A summarizer that can stream its output token-by-token (for the web UI). */
export interface StreamingSummarizer {
  summarizeStream(prompt: SummaryPrompt, opts?: SummarizeOpts): AsyncGenerator<string>;
}

/**
 * FetchImpl used by OllamaSummarizer.
 *
 * Non-streaming calls receive the full body and return a JSON-able Response.
 * Streaming calls need a ReadableStream body — for the node:http transport we
 * implement a minimal shim that wraps the IncomingMessage in a ReadableStream.
 *
 * Injectable for tests (pass a fake); production defaults to the node:http
 * transport to avoid undici's 300s headersTimeout (same pattern as
 * OllamaVisionAnalyzer — see src/vision/ollama-analyzer.ts).
 */
type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<Response>;

/** Default socket-inactivity timeout — generous for cold Ollama model loads. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

/**
 * node:http(s) transport with a generous socket timeout.
 * Mirrors the transport in src/vision/ollama-analyzer.ts but wraps the
 * IncomingMessage in a ReadableStream so streaming callers work too.
 */
function nodeHttpTransport(timeoutMs: number): FetchImpl {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
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
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;

          // Wrap IncomingMessage in a ReadableStream so streaming paths work.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              res.on("end", () => controller.close());
              res.on("error", (err) => controller.error(err));
            },
            cancel() {
              res.destroy();
            },
          });

          resolve(
            new Response(body, {
              status,
              headers: { "content-type": res.headers["content-type"] ?? "application/json" },
            }) as Response & { ok: boolean; status: number },
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`OllamaSummarizer: socket timeout after ${timeoutMs}ms`));
      });

      // Honor abort signal
      if (init.signal) {
        if (init.signal.aborted) {
          req.destroy(new DOMException("aborted", "AbortError"));
          return;
        }
        init.signal.addEventListener(
          "abort",
          () => {
            req.destroy(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      }

      req.write(init.body);
      req.end();
    });
}

export type OllamaSummarizerOptions = {
  host: string;
  model: string;
  numCtx: number;
  /** Sampling temperature. Default 0.7 (gemma's native default is 1.0; 0.2 was too terse). */
  temperature?: number;
  /** repeat_penalty. Default 1.1 — guards loops without suppressing detail (1.3 was too aggressive). */
  repeatPenalty?: number;
  /** Max tokens to generate. Default 4096 — a generous cap so summaries are never truncated. */
  numPredict?: number;
  /**
   * Injectable for tests; defaults to the node:http transport (avoids
   * undici's 300s headersTimeout on cold/large model loads).
   */
  fetchImpl?: FetchImpl;
  /** Socket inactivity timeout in ms (default 15 min). */
  timeoutMs?: number;
};

/** Tuned sampling defaults — see docs thin-summaries-design. */
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_REPEAT_PENALTY = 1.1;
const DEFAULT_NUM_PREDICT = 4096;

export class OllamaSummarizer implements Summarizer, StreamingSummarizer {
  private readonly host: string;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly temperature: number;
  private readonly repeatPenalty: number;
  private readonly numPredict: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OllamaSummarizerOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.model = opts.model;
    this.numCtx = opts.numCtx;
    this.temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
    this.repeatPenalty = opts.repeatPenalty ?? DEFAULT_REPEAT_PENALTY;
    this.numPredict = opts.numPredict ?? DEFAULT_NUM_PREDICT;
    this.fetchImpl = opts.fetchImpl ?? nodeHttpTransport(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /** Sampling options shared by the streaming and non-streaming requests. */
  private requestOptions() {
    return {
      num_ctx: this.numCtx,
      temperature: this.temperature,
      repeat_penalty: this.repeatPenalty,
      num_predict: this.numPredict,
    };
  }

  async summarize(prompt: SummaryPrompt, opts?: SummarizeOpts): Promise<SummaryOutput> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No `format`: requesting JSON/structured output makes some models
        // (gemma4:26b) degenerate into repetition loops on short Hebrew input.
        // Plain prose is reliable; repeat_penalty>1 further guards against loops.
        // think:false — gemma4 thinks by default, which burns the generation
        // budget on hidden reasoning and yields SHORTER, ~5x slower summaries.
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          options: this.requestOptions(),
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        signal: opts?.signal,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Ollama not reachable at ${this.host} (${m}). Is it running? Try 'ollama serve'.`,
      );
    }

    if (!res.ok) {
      throw new Error(`Ollama not reachable at ${this.host}: HTTP ${res.status}.`);
    }

    const body = (await res.json()) as { message?: { content?: string } } & OllamaDone;
    const usage = toUsage(body);
    reportUsage(usage, opts?.onUsage);
    const text = (body.message?.content ?? "").trim();
    if (text.length === 0) {
      // No row will be persisted, so these counts are about to be lost — but an
      // empty output is the STRONGEST signal of context starvation (prompt_eval
      // near num_ctx, nothing left to generate). Log it or the evidence vanishes.
      log.error({ usage }, "empty model output — likely no context left to generate into");
      throw new Error("Empty model output (no summary text returned).");
    }
    return { overview: text };
  }

  async *summarizeStream(prompt: SummaryPrompt, opts?: SummarizeOpts): AsyncGenerator<string> {
    // If already aborted before we even start, return immediately.
    if (opts?.signal?.aborted) return;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          think: false,
          options: this.requestOptions(),
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        signal: opts?.signal,
      });
    } catch (err) {
      // Treat AbortError as a clean stop — not a crash.
      if (err instanceof Error && err.name === "AbortError") return;
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Ollama not reachable at ${this.host} (${m}). Is it running? Try 'ollama serve'.`,
      );
    }
    if (!res.ok) throw new Error(`Ollama not reachable at ${this.host}: HTTP ${res.status}.`);
    if (!res.body) throw new Error("Ollama returned no response body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      // Check abort before each read so we stop promptly.
      if (opts?.signal?.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        // AbortError thrown by reader.read() when the signal fires — clean stop.
        if (err instanceof Error && err.name === "AbortError") {
          await reader.cancel().catch(() => {});
          return;
        }
        throw err;
      }
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const obj = parseChunk(line);
        if (!obj) continue;
        const delta = obj.message?.content;
        if (delta) yield delta;
        if (obj.done) {
          // The final chunk is the only one carrying the token counts.
          reportUsage(toUsage(obj), opts?.onUsage);
          return;
        }
      }
    }

    // The loop above only consumes NEWLINE-TERMINATED lines. If the stream's last
    // NDJSON object arrives without a trailing "\n" it is still sitting in `buf`
    // — and that object is the sole carrier of the token counts and the truncated
    // alarm. Flush it rather than dropping the very signal this feature exists for.
    const tail = buf.trim();
    if (tail) {
      const obj = parseChunk(tail);
      if (obj) {
        const delta = obj.message?.content;
        if (delta) yield delta;
        if (obj.done) {
          reportUsage(toUsage(obj), opts?.onUsage);
          return;
        }
      }
    }

    // Fell out of the read loop WITHOUT a done chunk — a transport drop or a
    // crashed engine, neither of which raises AbortError. The caller cannot tell
    // this apart from a clean finish (the signal was never aborted), so it will
    // persist whatever prose accumulated as if it were a complete summary. That
    // is pre-existing behavior; at minimum it must not also be invisible.
    log.error("Ollama stream ended without a done chunk — summary is likely incomplete");
  }
}
