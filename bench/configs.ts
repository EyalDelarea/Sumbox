/**
 * Benchmark config matrix. Each config names the models + per-request options for the
 * vision and summary stages. Server-level flags (Flash Attention, KV-cache quant) are
 * NOT per-request — they are set by restarting Ollama (see run-all.sh) and recorded via
 * the --server-config label, not here.
 *
 * Defaults below mirror src/config.ts so `baseline` reproduces production exactly.
 */
export type BenchConfig = {
  name: string;
  description: string;
  /** Ollama model tag for image + video frame analysis. */
  visionModel: string;
  /** num_ctx for the vision model (production default 8192). */
  visionNumCtx: number;
  /** Ollama model tag for text summarization. */
  summaryModel: string;
  /** num_ctx for the summary model (production default 32768). */
  summaryNumCtx: number;
  /**
   * Which server state this config is MEANT to run under. The runner restarts Ollama
   * accordingly and stamps results; the harness does not enforce it (it cannot read
   * the daemon's flags), it only records what it was told.
   */
  expectedServer: "default" | "flash+kv-q8_0";
};

const GEMMA = "gemma4:26b";
const QWEN_VL = "qwen2.5vl:latest";

export const CONFIGS: Record<string, BenchConfig> = {
  baseline: {
    name: "baseline",
    description: "Production today: gemma4:26b for vision + summary, default server flags.",
    visionModel: GEMMA,
    visionNumCtx: 8192,
    summaryModel: GEMMA,
    summaryNumCtx: 32768,
    expectedServer: "default",
  },
  "vision-7b": {
    name: "vision-7b",
    description: "Swap vision to qwen2.5vl 7B (already installed); summary stays gemma4:26b.",
    visionModel: QWEN_VL,
    visionNumCtx: 8192,
    summaryModel: GEMMA,
    summaryNumCtx: 32768,
    expectedServer: "default",
  },
  tuned: {
    name: "tuned",
    description: "Baseline models, but Ollama started with Flash Attention + KV cache q8_0.",
    visionModel: GEMMA,
    visionNumCtx: 8192,
    summaryModel: GEMMA,
    summaryNumCtx: 32768,
    expectedServer: "flash+kv-q8_0",
  },
  combined: {
    name: "combined",
    description: "qwen2.5vl vision + gemma4:26b summary, with Flash Attention + KV cache q8_0.",
    visionModel: QWEN_VL,
    visionNumCtx: 8192,
    summaryModel: GEMMA,
    summaryNumCtx: 32768,
    expectedServer: "flash+kv-q8_0",
  },
};

export function resolveConfigs(arg: string | undefined): BenchConfig[] {
  if (!arg || arg === "all") return Object.values(CONFIGS);
  const out: BenchConfig[] = [];
  for (const name of arg.split(",").map((s) => s.trim())) {
    const c = CONFIGS[name];
    if (!c) throw new Error(`Unknown config "${name}". Known: ${Object.keys(CONFIGS).join(", ")}`);
    out.push(c);
  }
  return out;
}
