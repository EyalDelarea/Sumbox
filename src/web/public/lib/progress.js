/**
 * progress.js — pure loader-progress curve for the Glacier summarize loader.
 *
 * Browser ES module (plain JS, no DOM dependencies). Pure and deterministic.
 *
 * We genuinely don't know how long a summarize will take (the LLM streams for an
 * unknown duration), so the bar can't show a true percentage before the first
 * token. Instead it's driven by *elapsed time* through an asymptotic ease-out
 * curve: it advances quickly at first and slows as it approaches a ceiling it
 * never quite reaches. The fill is therefore always monotonically increasing —
 * it *feels* like steady progress — without ever falsely claiming 100% before
 * the work is actually done (completion snaps it the rest of the way).
 */

/**
 * Map elapsed seconds → a progress percentage in [0, ceiling).
 *
 * @param {number} elapsedSec - seconds since the operation started
 * @param {{ ceiling?: number, tau?: number }} [opts]
 *   ceiling - asymptote the bar approaches but never reaches (default 95)
 *   tau     - time constant; larger = slower climb (default 11s)
 * @returns {number} percentage, one decimal place, in [0, ceiling)
 */
export function loaderProgress(elapsedSec, { ceiling = 95, tau = 11 } = {}) {
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return 0;
  const pct = ceiling * (1 - Math.exp(-elapsedSec / tau));
  // Floor to one decimal so we never round *up*, and clamp strictly below the
  // ceiling (at huge elapsed the exponential underflows to exactly `ceiling`).
  return Math.min(Math.floor(pct * 10) / 10, ceiling - 0.1);
}
