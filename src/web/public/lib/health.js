/**
 * health.js — Pure health-derivation helper for the WhatsApp-Sum web UI.
 *
 * Browser ES module (plain JS, no DOM dependencies). Pure and deterministic.
 *
 * `deriveHealth` answers ONE question: "is the collector alive and receiving
 * messages?" — i.e. should we warn the user that recent messages may be missing.
 *
 * It deliberately does NOT factor in background-job failures (failed/dead job_runs).
 * A dead `analyze.image`/`transcribe.voicenote` job means one piece of media
 * couldn't be processed — it does NOT mean the system is "not responding", and
 * "restart to sync" would never clear a dead-lettered row. Job-processing health
 * is surfaced separately in the status panel.
 */

/**
 * Derive collector liveness from the /api/status payload.
 *
 * @param {object} status - parsed /api/status response
 * @returns {boolean} true if the collector is connected and not stale
 */
export function deriveHealth(status) {
  try {
    const svc = status.service || {};
    const liveness = status.liveness;

    // Prefer the explicit liveness signal when present; fall back to service flags.
    if (liveness !== null && liveness !== undefined) {
      return Boolean(liveness.healthy);
    }
    return Boolean(svc.collectorConnected && !svc.stale);
  } catch {
    return false;
  }
}
