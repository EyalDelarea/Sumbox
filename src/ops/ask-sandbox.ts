/**
 * ask-sandbox.ts — run @Aida's REAL agentic loop against a real group's data,
 * with Langfuse tracing ON, WITHOUT sending anything to WhatsApp.
 *
 * It's the agentic sibling of ask-redteam: same read-only stance, but it drives
 * `answerAgentic` (the tool-loop) instead of the single-shot path, and it tags
 * every run as a `sandbox` trace so a batch of questions populates Langfuse with
 * inspectable samples over real data. `search_chat` only SELECTs, and this module
 * never calls sendText/react — so it can't post a message even by accident.
 *
 * Run: `npm run dev -- ask-sandbox --group <id>`  (needs a live Ollama + the
 * local Langfuse stack; see ops/runbooks/langfuse-observability.md).
 */
import type { LanguageModel } from "ai";
import type pg from "pg";
import { answerAgentic } from "../ask/agentic-answer.js";
import type { Embedder } from "../ask/embedder.js";
import { PROBES, type Probe } from "./ask-redteam.js";

export type SandboxResult = { probe: Probe; answer: string; ms: number };

export type SandboxDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  model: LanguageModel;
  /** The real group to run against — the retrieval boundary, same as live. */
  group: number;
  /** Defaults to the committed red-team PROBES. */
  probes?: Probe[];
  /** Injectable for tests; defaults to the real agentic answer. */
  answer?: typeof answerAgentic;
  /** Injectable for tests. */
  now?: () => number;
  onResult?: (r: SandboxResult) => void;
};

/** Run every probe through the agentic loop against `group`, read-only, tracing
 *  each as a `sandbox` run. Returns the answers for printing/grading. */
export async function runSandbox(deps: SandboxDeps): Promise<SandboxResult[]> {
  const probes = deps.probes ?? PROBES;
  const answer = deps.answer ?? answerAgentic;
  const now = deps.now ?? (() => Date.now());
  const results: SandboxResult[] = [];
  for (const probe of probes) {
    const t = now();
    let out: string;
    try {
      out = await answer(
        {
          pool: deps.pool,
          embedder: deps.embedder,
          model: deps.model,
          telemetry: true,
          trace: {
            sessionId: `sandbox:group:${deps.group}`,
            userId: probe.target,
            tags: ["aida", "sandbox", probe.scope],
          },
        },
        { groupId: deps.group, question: probe.question },
      );
    } catch (err) {
      out = `<<ERROR: ${err instanceof Error ? err.message : String(err)}>>`;
    }
    const r: SandboxResult = { probe, answer: out, ms: now() - t };
    results.push(r);
    deps.onResult?.(r);
  }
  return results;
}
