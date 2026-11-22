/**
 * config.ts — Rosey's own configuration keys (ROSEY_*), separate from @Aida's.
 *
 * Isolation (D6) extends to config: nothing here reads an ASK_* key, and @Aida
 * reads nothing here. Rosey shares the Ollama host and context size with the
 * rest of Sumbox because those describe the machine, not a bot.
 */

import { parseTagAliases } from "./tags.js";

export type RoseyConfig = {
  /** Tag aliases members type, e.g. ["@Rosey", "@רוזי"]. ROSEY_TAGS, comma-separated. */
  tags: string[];
  ollamaHost: string;
  /** Model for suggestions and dedup. Defaults to the summary model. */
  model: string;
  numCtx: number;
};

/** The default tag aliases: Latin and Hebrew. */
export const DEFAULT_ROSEY_TAGS = "@Rosey,@רוזי";

export function loadRoseyConfig(env: NodeJS.ProcessEnv = process.env): RoseyConfig {
  const tags = parseTagAliases(env.ROSEY_TAGS ?? DEFAULT_ROSEY_TAGS);
  return {
    tags: tags.length > 0 ? tags : parseTagAliases(DEFAULT_ROSEY_TAGS),
    ollamaHost: env.OLLAMA_HOST ?? "http://localhost:11434",
    model: env.ROSEY_MODEL ?? env.SUMMARY_MODEL ?? "gemma4:26b",
    numCtx: Number(env.SUMMARY_NUM_CTX ?? 32768),
  };
}
