/**
 * run-labelfree.ts — drive the real answer path over the real question corpus,
 * N times, and report per-metric mean plus observed spread.
 *
 * Read-only by construction: it calls `answerAgentic` and never `sendText` or
 * `react`, the same stance as `ask-sandbox` and `run-e`. It cannot post to
 * WhatsApp even by accident.
 *
 * `temperature` is left UNSET on purpose, which is the opposite of `run-e`.
 * run-e pins it to 0 to buy reproducibility — but measured on this stack that
 * reproducibility does not exist (3 distinct answers from 3 runs with `asOf`
 * pinned), so pinning only makes the harness measure something the live path
 * never does. Better to measure production's actual sampling and report the
 * spread honestly than to measure a fiction precisely.
 */
import type { LanguageModel } from "ai";
import type pg from "pg";
import { answerAgentic } from "../ask/agentic-answer.js";
import type { Embedder } from "../ask/embedder.js";
import { buildGroupRoster } from "../ask/roster.js";
import type { CorpusItem } from "./corpus.js";
import { LABEL_FREE_METRICS, scoreLabelFree } from "./labelfree.js";
import type { RunScores } from "./repeat.js";

export type RunLabelFreeDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  model: LanguageModel;
  /** Injectable for tests; defaults to the real agentic answer. */
  answer?: typeof answerAgentic;
  /** Injectable for tests; defaults to the live per-group roster. */
  roster?: (groupId: number) => Promise<string[]>;
  onItem?: (i: { item: CorpusItem; answer: string; index: number; total: number }) => void;
};

/** One pass over the corpus. Returns the mean of each metric across items. */
export async function runOnce(
  deps: RunLabelFreeDeps,
  corpus: CorpusItem[],
): Promise<{ scores: RunScores; answered: number }> {
  const answer = deps.answer ?? answerAgentic;
  const rosterFor = deps.roster ?? ((g: number) => buildGroupRoster(deps.pool, g));
  const totals: Record<string, number> = {};
  let answered = 0;

  // Rosters are per-group and stable across a run, so cache them rather than
  // re-querying once per item — the corpus spans few groups and many questions.
  const rosters = new Map<number, string[]>();

  for (const [index, item] of corpus.entries()) {
    if (!rosters.has(item.groupId)) rosters.set(item.groupId, await rosterFor(item.groupId));
    let prompt = "";
    try {
      const out = await answer(
        {
          pool: deps.pool,
          embedder: deps.embedder,
          model: deps.model,
          onPrompt: (p) => {
            prompt = p;
          },
        },
        {
          groupId: item.groupId,
          question: item.question,
          asOf: item.asOf,
          roster: rosters.get(item.groupId) ?? [],
        },
      );
      const scored = scoreLabelFree({ answer: out.text, prompt, citedIds: out.citedIds });
      for (const [k, v] of Object.entries(scored)) totals[k] = (totals[k] ?? 0) + v;
      answered += 1;
      deps.onItem?.({ item, answer: out.text, index, total: corpus.length });
    } catch (err) {
      // One bad item must not void a 200-item run. It is EXCLUDED from the
      // denominator rather than scored zero: a crash is not a refusal, and
      // counting it as one would quietly flatter or damn a prompt change.
      process.stderr.write(
        `  [skip] ${item.id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const scores: RunScores = {};
  for (const m of LABEL_FREE_METRICS)
    scores[m.name] = answered ? (totals[m.name] ?? 0) / answered : 0;
  return { scores, answered };
}

/** Run the corpus `runs` times. Each pass is one sample of the arm. */
export async function runRepeated(
  deps: RunLabelFreeDeps,
  corpus: CorpusItem[],
  runs: number,
): Promise<RunScores[]> {
  const out: RunScores[] = [];
  for (let i = 0; i < runs; i++) {
    process.stderr.write(`  run ${i + 1}/${runs} …\n`);
    out.push((await runOnce(deps, corpus)).scores);
  }
  return out;
}
