import { EventEmitter } from "node:events";
import type { OnboardingRegistry } from "../web/onboarding-routes.js";
import type { SessionHealth, SessionStatus } from "./session-status.js";

/**
 * Web onboarding over the ONE `CollectorSession` that `serve --collect` starts.
 *
 * A thin {@link OnboardingRegistry} that re-emits the session's onboarding-relevant
 * events. The live session is injected via {@link attachSession} after `--collect`
 * starts it (the adapter must exist earlier, at `createServer` time).
 */

/** The slice of CollectorSession this adapter consumes (keeps tests socket-free). */
export type OnboardingSessionSource = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

export class OnboardingAdapter implements OnboardingRegistry {
  private readonly emitter = new EventEmitter();
  private status: SessionStatus;
  private lastQr: string | null = null;

  /**
   * `initiallyLinked` (creds.json on disk) → "connected" so an already-linked device
   * skips onboarding from the very first request, before the socket reconnects.
   */
  constructor(opts: { initiallyLinked: boolean }) {
    this.status = opts.initiallyLinked ? "connected" : "connecting";
  }

  /** Bridge a started session's events in. Call once, after the session exists. */
  attachSession(session: OnboardingSessionSource): void {
    session.on("qr", (...a) => {
      this.lastQr = String(a[0]);
      if (this.status !== "connected") this.status = "connecting";
      this.emitter.emit("qr", a[0]);
    });
    session.on("connected", () => {
      this.status = "connected";
      this.lastQr = null;
      this.emitter.emit("connected");
    });
    session.on("disconnected", () => {
      if (this.status !== "logged-out") this.status = "disconnected";
      this.emitter.emit("disconnected");
    });
    session.on("logged-out", () => {
      this.status = "logged-out";
      this.lastQr = null;
      this.emitter.emit("logged-out");
    });
    session.on("history-progress", (...a) => {
      this.emitter.emit("history-progress", a[0]);
    });
  }

  /** The session is already supervised by the `--collect` block — nothing to start. */
  start(): Promise<void> {
    return Promise.resolve();
  }

  snapshot(): SessionHealth {
    return {
      status: this.status,
      restarts: 0,
      lastError: null,
      lastConnectedAt: null,
    };
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    this.emitter.on(event, listener);
    // Replay the buffered QR so the Connect step renders immediately instead of
    // waiting for the next ~20s Baileys rotation.
    if (event === "qr" && this.lastQr && this.status !== "connected") {
      listener(this.lastQr);
    }
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): unknown {
    this.emitter.off(event, listener);
    return this;
  }
}
