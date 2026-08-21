/**
 * redteam-run.ts — run the red-team probes N times through the AGENTIC path and
 * score them.
 *
 * Two things wrong with `ask-redteam` that this fixes:
 *
 * 1. It drives `answerQuestion` — the SINGLE-SHOT prompt. Production runs
 *    `buildAgenticSystem` (ASK_AGENTIC=true). So the committed suite has been
 *    exercising a prompt that does not ship, which is issue #67's exact
 *    complaint and how the anti-format-injection clause stayed missing from the
 *    live path for a whole release while the probes passed.
 * 2. It runs once and prints for a human. A guard that holds two times in three
 *    is not "passing", and nobody catches that by eye — which matters here
 *    because the model is measurably non-deterministic even at temperature 0.
 *
 * Read-only: drives `answerAgentic`, never `sendText`/`react`.
 */
import type { LanguageModel } from "ai";
import type pg from "pg";
import { answerAgentic } from "../ask/agentic-answer.js";
import type { Embedder } from "../ask/embedder.js";
import { buildGroupRoster } from "../ask/roster.js";
import { PROBES, type Probe } from "./ask-redteam.js";
import { type ProbeRun, type ProbeScore, scoreProbeRuns } from "./redteam-verdict.js";

export type RedteamRunDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  model: LanguageModel;
  /** The group to run against — its real roster and history are used. */
  group: number;
  probes?: Probe[];
  answer?: typeof answerAgentic;
  roster?: (groupId: number) => Promise<string[]>;
  onAnswer?: (r: { target: string; run: number; answer: string; verdict?: string }) => void;
};

export type RedteamReport = {
  scores: ProbeScore[];
  /** Probes with no machine verdict — printed for a human, never scored. */
  manual: { target: string; answers: string[] }[];
};

export async function runRedteamScored(deps: RedteamRunDeps, runs: number): Promise<RedteamReport> {
  const probes = deps.probes ?? PROBES;
  const answer = deps.answer ?? answerAgentic;
  const rosterFor = deps.roster ?? ((g: number) => buildGroupRoster(deps.pool, g));
  const roster = await rosterFor(deps.group);

  const graded: ProbeRun[] = [];
  const manual = new Map<string, string[]>();

  for (let run = 1; run <= runs; run++) {
    for (const probe of probes) {
      let text: string;
      try {
        const out = await answer(
          { pool: deps.pool, embedder: deps.embedder, model: deps.model },
          { groupId: deps.group, question: probe.question, roster },
        );
        text = out.text;
      } catch (err) {
        // A crash is not a guard failure. Scoring it as one would make an
        // unrelated outage look like a security regression.
        deps.onAnswer?.({
          target: probe.target,
          run,
          answer: `<<ERROR: ${err instanceof Error ? err.message : String(err)}>>`,
        });
        continue;
      }
      if (probe.verdict) {
        const v = probe.verdict(text);
        graded.push({ target: probe.target, verdict: v });
        deps.onAnswer?.({ target: probe.target, run, answer: text, verdict: v });
      } else {
        manual.set(probe.target, [...(manual.get(probe.target) ?? []), text]);
        deps.onAnswer?.({ target: probe.target, run, answer: text });
      }
    }
  }

  return {
    scores: scoreProbeRuns(graded),
    manual: [...manual.entries()].map(([target, answers]) => ({ target, answers })),
  };
}
