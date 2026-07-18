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
 * Runs either the committed red-team probes (guardrails) or a custom question
 * list from a file (retrieval/answer quality) — see the CLI `ask-sandbox`.
 *
 * Run: `npm run dev -- ask-sandbox --group <id> [--questions <file>]`
 * (needs a live Ollama + the local Langfuse stack; see
 * ops/runbooks/langfuse-observability.md).
 */
import type { LanguageModel } from "ai";
import type pg from "pg";
import { answerAgentic } from "../ask/agentic-answer.js";
import type { Embedder } from "../ask/embedder.js";
import { PROBES, type Probe } from "./ask-redteam.js";

/** One thing to ask @Aida. `id` → trace userId; `kind` → the 3rd trace tag
 *  (after "aida","sandbox"): a probe scope ("people"/"pii") or "custom". */
export type SandboxItem = { id: string; question: string; kind: string; expect?: string };

export type SandboxResult = { item: SandboxItem; answer: string; ms: number };

/** Adapt the red-team probes into sandbox items (guardrail run). */
export function probesToItems(probes: Probe[] = PROBES): SandboxItem[] {
  return probes.map((p) => ({
    id: p.target,
    question: p.question,
    kind: p.scope,
    expect: p.expect,
  }));
}

/** Parse a questions file into items: one question per line; blank lines and
 *  `#` comments ignored. Item ids are q1, q2, … so traces are easy to find. */
export function itemsFromText(text: string): SandboxItem[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((question, i) => ({ id: `q${i + 1}`, question, kind: "custom" }));
}

export type SandboxDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  model: LanguageModel;
  /** The real group to run against — the retrieval boundary, same as live. */
  group: number;
  /** What to ask. Defaults to the committed red-team probes. */
  items?: SandboxItem[];
  /** Injectable for tests; defaults to the real agentic answer. */
  answer?: typeof answerAgentic;
  /** Injectable for tests. */
  now?: () => number;
  onResult?: (r: SandboxResult) => void;
};

/** Run every item through the agentic loop against `group`, read-only, tracing
 *  each as a `sandbox` run. Returns the answers for printing/grading. */
export async function runSandbox(deps: SandboxDeps): Promise<SandboxResult[]> {
  const items = deps.items ?? probesToItems();
  const answer = deps.answer ?? answerAgentic;
  const now = deps.now ?? (() => Date.now());
  const results: SandboxResult[] = [];
  for (const item of items) {
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
            userId: item.id,
            tags: ["aida", "sandbox", item.kind],
          },
        },
        { groupId: deps.group, question: item.question },
      ).then((a) => a.text);
    } catch (err) {
      out = `<<ERROR: ${err instanceof Error ? err.message : String(err)}>>`;
    }
    const r: SandboxResult = { item, answer: out, ms: now() - t };
    results.push(r);
    deps.onResult?.(r);
  }
  return results;
}
