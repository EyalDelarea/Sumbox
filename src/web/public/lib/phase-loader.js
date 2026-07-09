/**
 * phase-loader.js — pure mapping from pipeline phase → loader render state.
 *
 * Phases mirror the SSE stream: sync (fetch new) → read (count known) →
 * summarize (first token) → done (saved). No DOM, no side effects — so the
 * Liquid Phase Tube's visuals stay unit-testable.
 */

/** Ordered phase keys (also the 4 tube zones, right→left in RTL). */
export const PHASES = ["sync", "read", "summarize", "done"];

/** Hebrew zone labels keyed by phase. */
export const PHASE_LABELS = {
  sync: "סנכרון",
  read: "קריאה",
  summarize: "סיכום",
  done: "מוכן",
};

const FILL = { sync: 18, read: 48, summarize: 82, done: 100 };

/** Target liquid fill (%) for a phase. Unknown → 0. */
export function phaseFill(phase) {
  return Object.prototype.hasOwnProperty.call(FILL, phase) ? FILL[phase] : 0;
}

/** Index of the active zone (0..3), or -1 if unknown. */
export function activeZoneIndex(phase) {
  return PHASES.indexOf(phase);
}

/** Caption line shown above the tube for a phase. */
export function phaseCaption(phase, { messages } = {}) {
  switch (phase) {
    case "sync":
      return "🔄 מסנכרן הודעות חדשות…";
    case "read":
      return messages ? `📖 קורא ${messages} הודעות…` : "📖 קורא הודעות…";
    case "summarize":
      return "✍️ כותב את הסיכום…";
    case "done":
      return "✓ מוכן";
    default:
      return "מכין סיכום…";
  }
}

/** Total-view per-chat scan fill (%), reserving the 88→100 tail for reduce. */
export function scanFill(index, total) {
  if (!total) return 0;
  return Math.min(88, Math.round((index / total) * 88));
}
