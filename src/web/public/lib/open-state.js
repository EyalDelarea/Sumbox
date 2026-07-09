/**
 * open-state.js — Pure decision logic for the group-detail open-time behavior.
 *
 * Given a cached summary (or null) and the current SSE stream phase,
 * determines what the UI should display and whether to show the
 * "מתעדכן…" (updating) chip.
 *
 * Browser ES module (plain JS, no DOM dependencies). Pure and deterministic.
 *
 * Stream phases (string):
 *   "idle"      — stream not started
 *   "streaming" — stream is open (tokens or syncing may be arriving)
 *   "done"      — stream finished with a fresh summary (new messages)
 *   "cached"    — stream finished with cache-hit (no new messages since cache)
 *   "empty"     — stream finished with no messages at all (cold group)
 *   "error"     — stream finished with an error
 */

/**
 * @typedef {"idle"|"streaming"|"done"|"cached"|"empty"|"error"} StreamPhase
 */

/**
 * Given whether a pre-cached summary is present and the current stream phase,
 * decide whether to show the "מתעדכן…" (updating) chip.
 *
 * The chip is shown when:
 * - A cached summary is already visible, AND
 * - The background stream is in flight (phase = "streaming"), AND
 * - It hasn't yet settled to a terminal state.
 *
 * @param {boolean} hasCached - true if a pre-cached summary is displayed
 * @param {StreamPhase} phase - current SSE stream phase
 * @returns {boolean}
 */
export function shouldShowUpdatingChip(hasCached, phase) {
  return hasCached && phase === "streaming";
}

/**
 * Given whether a pre-cached summary is present and the current stream phase,
 * decide whether an incoming stream error should be displayed as an error state
 * (replacing the cached summary) or suppressed (keeping the cached summary).
 *
 * When a cached summary is visible, stream errors are suppressed — the user
 * already has valid content; showing an error would degrade the experience.
 *
 * @param {boolean} hasCached - true if a pre-cached summary is displayed
 * @param {StreamPhase} phase - current SSE stream phase (expected "error")
 * @returns {boolean} true if the error should be shown to the user
 */
export function shouldShowStreamError(hasCached, phase) {
  return !hasCached && phase === "error";
}

/**
 * Derive whether the stream indicates new messages (i.e. a background
 * regeneration produced a fresh summary rather than a cache-hit).
 *
 * "done" means the stream generated a new summary.
 * "cached" or "empty" means no new content beyond what was already cached.
 *
 * @param {StreamPhase} phase
 * @returns {boolean}
 */
export function streamProducedNewSummary(phase) {
  return phase === "done";
}

/**
 * Decide whether to start the background SSE refresh after a debounce delay.
 *
 * The background refresh is ONLY started when:
 * - A pre-cached summary was rendered (hasCached=true), AND
 * - The user is still viewing the same group they opened (openedGroup === currentDetailGroup), AND
 * - We haven't already started a background refresh for this open (backgroundRefreshStarted=false).
 *
 * This prevents firing a 70s Ollama call for a group the user only glanced at,
 * and ensures at most one background refresh per group open.
 *
 * @param {{ hasCached: boolean, openedGroup: string, currentDetailGroup: string|null, backgroundRefreshStarted: boolean }} opts
 * @returns {boolean}
 */
export function shouldStartBackgroundRefresh({ hasCached, openedGroup, currentDetailGroup, backgroundRefreshStarted }) {
  return hasCached && currentDetailGroup === openedGroup && !backgroundRefreshStarted;
}
