/**
 * Status of the WhatsApp (Baileys) link, as reported to the onboarding surface.
 *
 * Kept separate from the session itself so the web layer can describe link health
 * without importing the collector's socket machinery.
 */

export type SessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "stopped"
  | "failed"
  | "logged-out";

export type SessionHealth = {
  status: SessionStatus;
  /** Failed start attempts consumed for the CURRENT start (supervision counter). */
  restarts: number;
  lastError: string | null;
  lastConnectedAt: Date | null;
};
