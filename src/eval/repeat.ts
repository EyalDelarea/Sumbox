/**
 * repeat.ts — turn N runs into a verdict, and refuse to give one when N is too small.
 *
 * This module exists because of a specific, repeated failure. `run-e.ts` pins
 * `temperature` to 0 and justifies it as "an eval that cannot reproduce its own
 * number cannot detect a regression". That floor does not exist: measured on this
 * stack, the same question with `asOf` pinned produced **3 distinct answers out
 * of 3 runs**. During PR #78 a single run looked like a clear ranking regression;
 * on repeat, the identical input behaved normally. It was noise, and it was one
 * sentence away from being reported as a finding.
 *
 * So the unit of measurement here is never a number — it is a number WITH the
 * spread that produced it, and an explicit verdict about whether two arms can be
 * told apart at all. `compare()` is allowed to answer "cannot tell", and that is
 * the most valuable thing it does.
 */

/** Per-metric values for one run over the corpus (already averaged per run). */
export type RunScores = Record<string, number>;

export type MetricSummary = {
  metric: string;
  mean: number;
  min: number;
  max: number;
  /** max - min. The observed noise band for this metric on this corpus. */
  spread: number;
  runs: number;
};

/** Aggregate N runs of the same arm into per-metric mean and observed range. */
export function summarize(runs: RunScores[]): MetricSummary[] {
  if (runs.length === 0) return [];
  const names = [...new Set(runs.flatMap((r) => Object.keys(r)))].sort();
  return names.map((metric) => {
    const vals = runs.map((r) => r[metric] ?? 0);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return {
      metric,
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      min,
      max,
      spread: max - min,
      runs: vals.length,
    };
  });
}

export type Verdict = "moved" | "unresolvable" | "flat";

export type Comparison = {
  metric: string;
  before: MetricSummary;
  after: MetricSummary;
  delta: number;
  /** The noise band both arms have to clear: the wider observed spread. */
  noise: number;
  verdict: Verdict;
};

/**
 * Compare two arms, metric by metric.
 *
 * The rule is deliberately blunt: a difference counts only if it exceeds the
 * NOISE the arms themselves exhibited. No p-values, no distributional
 * assumptions — with three runs of a non-deterministic local model those would be
 * decoration over the same judgement call, and a blunt rule that is actually
 * applied beats a sophisticated one that is quietly ignored.
 *
 * - `moved`         — |delta| > noise. Believe it.
 * - `unresolvable`  — the arms differ, but by less than their own spread. This is
 *                     NOT "no change"; it is "this harness cannot tell", and the
 *                     honest response is more runs or a bigger corpus.
 * - `flat`          — no measurable difference and no spread to hide one in.
 *
 * Single-run arms always come back `unresolvable` when they differ: one sample
 * has no observed spread, so it cannot clear a bar it never measured. That is the
 * point — it makes the mistake that started this module impossible to repeat.
 */
export function compare(before: RunScores[], after: RunScores[]): Comparison[] {
  const b = new Map(summarize(before).map((s) => [s.metric, s]));
  const a = new Map(summarize(after).map((s) => [s.metric, s]));
  const names = [...new Set([...b.keys(), ...a.keys()])].sort();

  return names.flatMap((metric) => {
    const bs = b.get(metric);
    const as = a.get(metric);
    if (!bs || !as) return [];
    const delta = as.mean - bs.mean;
    const noise = Math.max(bs.spread, as.spread);
    let verdict: Verdict;
    if (delta === 0 && noise === 0) verdict = "flat";
    else if (Math.abs(delta) > noise) verdict = "moved";
    else verdict = "unresolvable";
    // A single run per arm has spread 0, so a nonzero delta would read as
    // "moved" on one sample — precisely the error this module exists to prevent.
    if ((bs.runs < 2 || as.runs < 2) && delta !== 0) verdict = "unresolvable";
    return [{ metric, before: bs, after: as, delta, noise, verdict }];
  });
}

/** Render a comparison as a fixed-width table for the CLI. */
export function formatComparison(rows: Comparison[], lowerIsBetter: Set<string>): string {
  const head = "metric                before      after       delta     noise   verdict";
  const body = rows.map((r) => {
    const n = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(3));
    // The direction marker matters: a FALL in `refused` is an improvement, and a
    // table that shows a bare negative delta invites reading it as a regression.
    const dir =
      r.verdict !== "moved"
        ? ""
        : r.delta < 0 === lowerIsBetter.has(r.metric)
          ? "  better"
          : "  worse";
    return (
      `${r.metric.padEnd(20)}  ${n(r.before.mean).padEnd(10)}  ${n(r.after.mean).padEnd(10)}  ` +
      `${(r.delta >= 0 ? "+" : "") + n(r.delta)}`.padEnd(10) +
      `${n(r.noise).padEnd(8)}  ${r.verdict}${dir}`
    );
  });
  const unresolvable = rows.filter((r) => r.verdict === "unresolvable").length;
  const note = unresolvable
    ? `\n\n${unresolvable} metric(s) unresolvable — the arms differ by less than their own run-to-run spread.\nThat is "this harness cannot tell", not "nothing changed". Add runs or corpus.`
    : "";
  return [head, ...body].join("\n") + note;
}
