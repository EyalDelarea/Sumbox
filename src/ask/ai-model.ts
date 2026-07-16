import type { LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { Agent, fetch as undiciFetch } from "undici";

/** Ollama over the AI SDK, with a fetch whose timeouts tolerate a COLD gemma4
 *  load (undici's defaults abort a slow first response — the exact reason the
 *  summarizer uses node:http). We raise headers/body timeouts instead. */
export function makeAgenticModel(cfg: {
  host: string;
  model: string;
  timeoutMs?: number;
}): LanguageModel {
  const timeout = cfg.timeoutMs ?? 15 * 60 * 1000;
  const agent = new Agent({ headersTimeout: timeout, bodyTimeout: timeout });
  const ollama = createOllama({
    baseURL: `${cfg.host.replace(/\/$/, "")}/api`,
    fetch: ((url: string, init?: RequestInit) =>
      undiciFetch(url, { ...(init as object), dispatcher: agent } as never)) as typeof fetch,
  });
  return ollama(cfg.model);
}
