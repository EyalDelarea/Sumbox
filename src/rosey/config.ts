/**
 * config.ts — Rosey's own configuration keys (ROSEY_*), separate from @Aida's.
 *
 * Isolation (D6) extends to config: nothing here reads an ASK_* key, and @Aida
 * reads nothing here. Rosey shares the Ollama host and context size with the
 * rest of Sumbox because those describe the machine, not a bot.
 */

import { parseSendMode, type RoseySendMode } from "./reply.js";
import { parseTagAliases } from "./tags.js";

export type RoseyConfig = {
  /**
   * Live capture in the collector. Off by default: ROSEY_ENABLED=true opts in,
   * and even then only groups on the 'rosey' allowlist key are read.
   */
  enabled: boolean;
  /** Tag aliases members type, e.g. ["@Rosey", "@רוזי"]. ROSEY_TAGS, comma-separated. */
  tags: string[];
  ollamaHost: string;
  /** Model for suggestions and dedup. Defaults to the summary model. */
  model: string;
  numCtx: number;
  /**
   * Live suggestions run this long after the LAST message of a burst in a group
   * (ROSEY_SUGGEST_DEBOUNCE_MS, default 5 min), so a list typed over several
   * messages is read together.
   */
  suggestDebounceMs: number;
  /**
   * ROSEY_SEND_MODE: off (default, and the kill switch) | dry-run | live. Her
   * only send is a list reply (reply.ts); anything but dry-run or live is off.
   */
  sendMode: RoseySendMode;
};

/** The default tag aliases: Latin and Hebrew. */
export const DEFAULT_ROSEY_TAGS = "@Rosey,@רוזי";

export function loadRoseyConfig(env: NodeJS.ProcessEnv = process.env): RoseyConfig {
  const tags = parseTagAliases(env.ROSEY_TAGS ?? DEFAULT_ROSEY_TAGS);
  const debounce = Number(env.ROSEY_SUGGEST_DEBOUNCE_MS ?? 5 * 60_000);
  return {
    enabled: env.ROSEY_ENABLED === "true",
    tags: tags.length > 0 ? tags : parseTagAliases(DEFAULT_ROSEY_TAGS),
    ollamaHost: env.OLLAMA_HOST ?? "http://localhost:11434",
    model: env.ROSEY_MODEL ?? env.SUMMARY_MODEL ?? "gemma4:26b",
    numCtx: Number(env.SUMMARY_NUM_CTX ?? 32768),
    suggestDebounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 5 * 60_000,
    sendMode: parseSendMode(env.ROSEY_SEND_MODE),
  };
}
