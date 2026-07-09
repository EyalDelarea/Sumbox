import { EventEmitter } from "node:events";
import { DEFAULT_TENANT_ID } from "../db/tenant-context.js";
import type { OnboardingRegistry } from "../web/onboarding-routes.js";
import type { SessionHealth, TenantSessionStatus } from "./tenant-session-registry.js";

/**
 * 021 — single-user web onboarding.
 *
 * A thin {@link OnboardingRegistry} over the ONE default-tenant `CollectorSession`
 * (the one `serve --collect` starts). It re-emits that session's onboarding-relevant
 * events with the `DEFAULT_TENANT_ID` prefix the routes filter on, mirroring what
 * `TenantSessionRegistry` does per tenant — but for a single, already-supervised
 * session. The live session is injected via {@link attachSession} after `--collect`
 * starts it (the adapter must exist earlier, at `createServer` time).
 */

/** The slice of CollectorSession this adapter consumes (keeps tests socket-free). */
export type OnboardingSessionSource = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

export class SingleTenantOnboardingAdapter implements OnboardingRegistry {
  private readonly emitter = new EventEmitter();
  private status: TenantSessionStatus;
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
      this.emitter.emit("qr", DEFAULT_TENANT_ID, a[0]);
    });
    session.on("connected", () => {
      this.status = "connected";
      this.lastQr = null;
      this.emitter.emit("connected", DEFAULT_TENANT_ID);
    });
    session.on("disconnected", () => {
      if (this.status !== "logged-out") this.status = "disconnected";
      this.emitter.emit("disconnected", DEFAULT_TENANT_ID);
    });
    session.on("logged-out", () => {
      this.status = "logged-out";
      this.lastQr = null;
      this.emitter.emit("logged-out", DEFAULT_TENANT_ID);
    });
    session.on("history-progress", (...a) => {
      this.emitter.emit("history-progress", DEFAULT_TENANT_ID, a[0]);
    });
  }

  /** The session is already supervised by the `--collect` block — nothing to start. */
  start(): Promise<void> {
    return Promise.resolve();
  }

  snapshot(): SessionHealth[] {
    return [
      {
        tenantId: DEFAULT_TENANT_ID,
        status: this.status,
        restarts: 0,
        lastError: null,
        lastConnectedAt: null,
      },
    ];
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    this.emitter.on(event, listener);
    // Replay the buffered QR so the Connect step renders immediately instead of
    // waiting for the next ~20s Baileys rotation.
    if (event === "qr" && this.lastQr && this.status !== "connected") {
      listener(DEFAULT_TENANT_ID, this.lastQr);
    }
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): unknown {
    this.emitter.off(event, listener);
    return this;
  }
}

/**
 * Compose onboarding for MT + `--collect`: the DEFAULT tenant is owned by the legacy
 * `--collect` session (`legacy`), every other tenant by the per-tenant `registry`.
 *
 * Routing the default tenant to the registry would make it open a SECOND Baileys socket
 * on the shared root creds (the registry's `authDirFor(DEFAULT)` == the legacy auth root) —
 * WhatsApp permits one socket per linked device, so the two evict each other forever
 * (stream-error 440 "replaced") → endless reconnect loop. Events are tenant-prefixed and
 * the routes filter by tenant, so forwarding listeners to both adapters is safe.
 */
export function composeOnboarding(
  legacy: OnboardingRegistry,
  registry: OnboardingRegistry,
): OnboardingRegistry {
  return {
    start: (tenantId) =>
      tenantId === DEFAULT_TENANT_ID ? legacy.start(tenantId) : registry.start(tenantId),
    snapshot: () => [
      ...legacy.snapshot(),
      ...registry.snapshot().filter((h) => h.tenantId !== DEFAULT_TENANT_ID),
    ],
    on: (event, listener) => {
      legacy.on(event, listener);
      registry.on(event, listener);
      return undefined;
    },
    off: (event, listener) => {
      legacy.off(event, listener);
      registry.off(event, listener);
      return undefined;
    },
  };
}
