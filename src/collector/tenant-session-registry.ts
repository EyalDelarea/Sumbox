import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TENANT_ID } from "../db/tenant-context.js";

/**
 * T3 — one supervised WhatsApp (Baileys) session per tenant.
 *
 * The registry owns lifecycle only: per-tenant auth-state directories, supervised
 * start with bounded backoff, status/health tracking, and connect staggering (N
 * simultaneous links from one host is exactly the WhatsApp-ban-risk signature).
 * The session itself is injected, so all of this is testable without a socket.
 *
 * Backward compat: the pre-T3 single-user link lives at `<authRoot>` itself; the
 * DEFAULT tenant keeps that directory so an existing linked device never re-links.
 * Every other tenant gets `<authRoot>/<tenantId>`.
 *
 * Events (re-emitted with the tenant prepended):
 *   "message"           (tenantId, msg)   — for tenant-scoped ingest
 *   "qr"                (tenantId, qr)     — consumed by T4's web onboarding flow
 *   "history-progress"  (tenantId, info)   — drives S5's onboarding scan-% ring
 *   "connected" / "disconnected" / "logged-out"  (tenantId)
 */

/**
 * The minimal surface the registry needs from a session. `on` is typed with bottom
 * parameters so BOTH a plain EventEmitter and the strictly-typed CollectorSession
 * are assignable (we only ever call it through the internal Emitterish cast).
 */
export type RegistrySession = {
  on(event: never, listener: never): unknown;
  stop(): void;
};

type Emitterish = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

export type TenantSessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "stopped"
  | "failed"
  | "logged-out";

export type SessionHealth = {
  tenantId: string;
  status: TenantSessionStatus;
  /** Failed start attempts consumed for the CURRENT start (supervision counter). */
  restarts: number;
  lastError: string | null;
  lastConnectedAt: Date | null;
};

export type RegistryDeps = {
  /** Root of all auth state (the single-user legacy dir itself). */
  authRoot: string;
  /** Session factory — production passes startSession(authDir, allowSend); tests fake it. */
  startSession: (authDir: string) => Promise<RegistrySession>;
  /** Injectable sleep so tests run instantly while asserting requested delays. */
  wait?: (ms: number) => Promise<void>;
  /** Delay between consecutive connects (ban-risk mitigation). Default 5s. */
  staggerMs?: number;
  /** Retries after a failed start before marking the tenant failed. Default 3. */
  maxStartRetries?: number;
  /** Base backoff between retries; doubles per attempt. Default 3s. */
  backoffMs?: number;
};

type Entry = {
  session: RegistrySession | null;
  status: TenantSessionStatus;
  restarts: number;
  lastError: string | null;
  lastConnectedAt: Date | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantSessionRegistry extends EventEmitter {
  private readonly deps: Required<Omit<RegistryDeps, "wait">> & {
    wait: (ms: number) => Promise<void>;
  };
  private readonly entries = new Map<string, Entry>();

  constructor(deps: RegistryDeps) {
    super();
    this.deps = {
      authRoot: deps.authRoot,
      startSession: deps.startSession,
      wait: deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      staggerMs: deps.staggerMs ?? 5000,
      maxStartRetries: deps.maxStartRetries ?? 3,
      backoffMs: deps.backoffMs ?? 3000,
    };
  }

  /** The default tenant keeps the legacy root dir (no re-link); others get a subdir. */
  authDirFor(tenantId: string): string {
    return tenantId === DEFAULT_TENANT_ID
      ? this.deps.authRoot
      : path.join(this.deps.authRoot, tenantId);
  }

  /** A tenant is "linked" when its auth dir holds Baileys credentials. */
  hasLinkedAuth(tenantId: string): boolean {
    return fs.existsSync(path.join(this.authDirFor(tenantId), "creds.json"));
  }

  /** The live session for a tenant, if any (T4's QR flow drives this). */
  session(tenantId: string): RegistrySession | null {
    return this.entries.get(tenantId)?.session ?? null;
  }

  /**
   * Start (supervised) the tenant's session. Retries with doubling backoff up to
   * maxStartRetries; a hopeless tenant ends `failed` WITHOUT affecting any other
   * tenant. Idempotent while a session exists.
   */
  async start(tenantId: string): Promise<void> {
    const existing = this.entries.get(tenantId);
    if (existing?.session) return;

    const entry: Entry = {
      session: null,
      status: "connecting",
      restarts: 0,
      lastError: null,
      lastConnectedAt: null,
    };
    this.entries.set(tenantId, entry);

    const authDir = this.authDirFor(tenantId);
    for (let attempt = 0; ; attempt++) {
      try {
        const session = await this.deps.startSession(authDir);
        entry.session = session;
        this.wire(tenantId, entry, session);
        return;
      } catch (err) {
        entry.restarts++;
        entry.lastError = err instanceof Error ? err.message : String(err);
        if (attempt >= this.deps.maxStartRetries - 1) {
          entry.status = "failed";
          return;
        }
        await this.deps.wait(this.deps.backoffMs * 2 ** attempt);
      }
    }
  }

  /**
   * Discover already-linked tenants on disk (legacy root link = default tenant;
   * `<root>/<uuid>/creds.json` = that tenant) and start them, staggering connects.
   * Returns the tenant ids started.
   */
  async startDiscovered(opts: { exclude?: string[] } = {}): Promise<string[]> {
    const excluded = new Set(opts.exclude ?? []);
    const found: string[] = [];
    if (this.hasLinkedAuth(DEFAULT_TENANT_ID) && !excluded.has(DEFAULT_TENANT_ID)) {
      found.push(DEFAULT_TENANT_ID);
    }
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.deps.authRoot);
    } catch {
      // No auth root at all → nothing linked yet.
    }
    for (const name of names) {
      if (UUID_RE.test(name) && !excluded.has(name) && this.hasLinkedAuth(name)) {
        found.push(name);
      }
    }

    for (let i = 0; i < found.length; i++) {
      if (i > 0) await this.deps.wait(this.deps.staggerMs);
      await this.start(found[i] as string);
    }
    return found;
  }

  stop(tenantId: string): void {
    const entry = this.entries.get(tenantId);
    if (!entry) return;
    entry.session?.stop();
    entry.session = null;
    entry.status = "stopped";
  }

  stopAll(): void {
    for (const tenantId of this.entries.keys()) this.stop(tenantId);
  }

  /** Per-tenant health — the feed for the T5 operator dashboard. */
  snapshot(): SessionHealth[] {
    return [...this.entries.entries()].map(([tenantId, e]) => ({
      tenantId,
      status: e.status,
      restarts: e.restarts,
      lastError: e.lastError,
      lastConnectedAt: e.lastConnectedAt,
    }));
  }

  private wire(tenantId: string, entry: Entry, session: RegistrySession): void {
    const ev = session as unknown as Emitterish;
    ev.on("connected", () => {
      entry.status = "connected";
      entry.lastConnectedAt = new Date();
      this.emit("connected", tenantId);
    });
    ev.on("disconnected", () => {
      // Terminal states stick; a transient close otherwise (the session itself
      // auto-reconnects — see CollectorSession.connect).
      if (entry.status !== "stopped" && entry.status !== "logged-out") {
        entry.status = "disconnected";
      }
      this.emit("disconnected", tenantId);
    });
    ev.on("logged-out", () => {
      entry.status = "logged-out";
      this.emit("logged-out", tenantId);
    });
    ev.on("message", (...args: unknown[]) => {
      this.emit("message", tenantId, ...args);
    });
    ev.on("qr", (...args: unknown[]) => {
      this.emit("qr", tenantId, ...args);
    });
    // S5: WhatsApp's history-sync progress (0–100), forwarded so the onboarding
    // pane can show a live "scanning your chats" ring after the link connects.
    ev.on("history-progress", (...args: unknown[]) => {
      this.emit("history-progress", tenantId, ...args);
    });
  }
}
