/**
 * Capturing transports for the benchmark harness.
 *
 * The production OllamaVisionAnalyzer (src/vision/ollama-analyzer.ts) and
 * OllamaSummarizer (src/summarization/summarizer.ts) both accept an injectable
 * HTTP transport and both DISCARD Ollama's timing fields. We inject a transport
 * that performs the real request but parses and stashes the raw response — so the
 * harness measures the exact production request path with ZERO production changes.
 *
 * Ollama returns nanosecond durations on the non-streaming response:
 *   total_duration, load_duration, prompt_eval_count, prompt_eval_duration,
 *   eval_count, eval_duration, done_reason
 * From these we derive prompt tok/s and generation tok/s (the fair cross-model metric,
 * since wall-clock is confounded by differing output lengths).
 */
import http from "node:http";
import { URL } from "node:url";

export type OllamaTimings = {
  model?: string;
  done_reason?: string;
  total_duration_ns?: number;
  load_duration_ns?: number;
  prompt_eval_count?: number;
  prompt_eval_duration_ns?: number;
  eval_count?: number;
  eval_duration_ns?: number;
  /** Derived: generation tokens / second. */
  gen_tok_s?: number;
  /** Derived: prompt (prefill) tokens / second. */
  prompt_tok_s?: number;
};

type RawResponse = { status: number; text: string };

function rawPost(url: string, body: string, timeoutMs: number): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`socket timeout after ${timeoutMs}ms`)));
    req.write(body);
    req.end();
  });
}

function extractTimings(parsed: Record<string, unknown>): OllamaTimings {
  const num = (k: string) => (typeof parsed[k] === "number" ? (parsed[k] as number) : undefined);
  const t: OllamaTimings = {
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    done_reason: typeof parsed.done_reason === "string" ? parsed.done_reason : undefined,
    total_duration_ns: num("total_duration"),
    load_duration_ns: num("load_duration"),
    prompt_eval_count: num("prompt_eval_count"),
    prompt_eval_duration_ns: num("prompt_eval_duration"),
    eval_count: num("eval_count"),
    eval_duration_ns: num("eval_duration"),
  };
  if (t.eval_count && t.eval_duration_ns) {
    t.gen_tok_s = t.eval_count / (t.eval_duration_ns / 1e9);
  }
  if (t.prompt_eval_count && t.prompt_eval_duration_ns) {
    t.prompt_tok_s = t.prompt_eval_count / (t.prompt_eval_duration_ns / 1e9);
  }
  return t;
}

/**
 * Build a pair of capturing transports plus a shared sink. Each call appends the
 * parsed timings to `last`; the harness snapshots `last` right after each model call.
 */
export function makeCapture(timeoutMs = 20 * 60 * 1000) {
  let last: OllamaTimings | undefined;

  /** Matches OllamaVisionAnalyzer's FetchFn: returns { ok, status, json }. */
  const visionFetch = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    const { status, text } = await rawPost(url, init.body, timeoutMs);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    last = extractTimings(parsed);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => parsed,
    };
  };

  /** Matches OllamaSummarizer's FetchImpl: returns a Response. */
  const summaryFetch = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<Response> => {
    const { status, text } = await rawPost(url, init.body, timeoutMs);
    last = extractTimings(JSON.parse(text) as Record<string, unknown>);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    visionFetch,
    summaryFetch,
    /** Timings from the most recent call. */
    takeLast: () => last,
  };
}
