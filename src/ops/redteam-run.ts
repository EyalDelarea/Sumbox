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
  /**
   * The asker fed to the prompt. Production always has one, so `askerLine` is
   * always in the shipping prompt; omitting it here scored a prompt that never
   * ships. Defaults to the first REAL roster member — an invented name would not
   * be on the roster, and PEOPLE-SAFETY tells her to treat anyone not on that
   * list as a non-member, which is a different prompt again. Injectable for tests.
   */
  askerName?: string;
  answer?: typeof answerAgentic;
  roster?: (groupId: number) => Promise<string[]>;
  onAnswer?: (r: { target: string; run: number; answer: string; verdict?: string }) => void;
};

export type RedteamReport = {
  scores: ProbeScore[];
  /** Probes with no machine verdict — printed for a human, never scored. */
  manual: { target: string; answers: string[] }[];
  /**
   * Runs that threw. A crash is still not a guard failure — scoring it as one
   * would make an unrelated outage look like a security regression — but it is
   * not nothing either, and it used to be dropped on the floor. A probe that
   * crashed on every run appeared in NO table while the CLI printed "All scored
   * guards held on every run"; a probe that crashed on one run of three reported
   * `runs: 2` with the missing third silently absent from the denominator.
   */
  errors: { target: string; run: number; message: string }[];
};

export async function runRedteamScored(deps: RedteamRunDeps, runs: number): Promise<RedteamReport> {
  const probes = deps.probes ?? PROBES;
  const answer = deps.answer ?? answerAgentic;
  const rosterFor = deps.roster ?? ((g: number) => buildGroupRoster(deps.pool, g));
  const roster = await rosterFor(deps.group);
  const askerName = deps.askerName ?? roster[0];

  const graded: ProbeRun[] = [];
  const manual = new Map<string, string[]>();
  const errors: RedteamReport["errors"] = [];

  for (let run = 1; run <= runs; run++) {
    for (const probe of probes) {
      let text: string;
      try {
        const out = await answer(
          { pool: deps.pool, embedder: deps.embedder, model: deps.model },
          {
            groupId: deps.group,
            question: probe.question,
            roster,
            ...(askerName ? { askerName } : {}),
          },
        );
        text = out.text;
      } catch (err) {
        // A crash is not a guard failure — but it IS recorded, so the run never
        // disappears from the denominator without the operator being told.
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ target: probe.target, run, message });
        deps.onAnswer?.({ target: probe.target, run, answer: `<<ERROR: ${message}>>` });
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
    errors,
  };
}
