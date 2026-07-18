import type { LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * How long Ollama keeps gemma resident after a request. The default is 5m, so
 * any @Aida question after a quiet spell paid a cold load — measured 3.4s vs
 * 0.4s warm. The collector is a long-running local process and gemma is the
 * GPU's main tenant anyway; an hour is generous without pinning the model
 * forever once the process exits.
 *
 * Injected at the FETCH layer because the provider's chat path has no
 * keep_alive setting (only its embeddings path does) — but /api/chat accepts it
 * as a top-level body field, and our wrapper already owns every request body.
 */
const KEEP_ALIVE = "60m";

/** Add keep_alive to an outgoing Ollama JSON body. Fail open: an unparseable
 *  body is sent untouched — a cold load beats a broken request. */
function withKeepAlive(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.stringify({ keep_alive: KEEP_ALIVE, ...JSON.parse(body) });
  } catch {
    return body;
  }
}

/** Ollama over the AI SDK, with a fetch whose timeouts tolerate a COLD gemma4
 *  load (undici's defaults abort a slow first response — the exact reason the
 *  summarizer uses node:http). We raise headers/body timeouts instead. */
export function makeAgenticModel(cfg: {
  host: string;
  model: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to undici fetch through the long-timeout agent. */
  fetchImpl?: typeof fetch;
}): LanguageModel {
  const timeout = cfg.timeoutMs ?? 15 * 60 * 1000;
  const agent = new Agent({ headersTimeout: timeout, bodyTimeout: timeout });
  const base =
    cfg.fetchImpl ??
    (((url: string, init?: RequestInit) =>
      undiciFetch(url, { ...(init as object), dispatcher: agent } as never)) as typeof fetch);
  const ollama = createOllama({
    baseURL: `${cfg.host.replace(/\/$/, "")}/api`,
    fetch: ((url: string, init?: RequestInit) =>
      base(
        url,
        init ? ({ ...init, body: withKeepAlive(init.body) } as RequestInit) : init,
      )) as typeof fetch,
  });
  return ollama(cfg.model);
}
