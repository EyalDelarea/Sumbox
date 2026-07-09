import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID } from "../db/tenant-context.js";
import { type RegistrySession, TenantSessionRegistry } from "./tenant-session-registry.js";

/**
 * T3 — one supervised WhatsApp session per tenant. Sessions are injected (fake here;
 * Baileys in production), so the registry's lifecycle/supervision/attribution logic is
 * fully testable without a socket.
 */

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

class FakeSession extends EventEmitter implements RegistrySession {
  stopped = false;
  constructor(readonly authDir: string) {
    super();
  }
  stop(): void {
    this.stopped = true;
  }
}

function makeRegistry(opts?: {
  failuresBeforeSuccess?: Map<string, number>;
  authRoot?: string;
  staggerMs?: number;
}) {
  const created: FakeSession[] = [];
  const failLeft = opts?.failuresBeforeSuccess ?? new Map<string, number>();
  const delays: number[] = [];
  const registry = new TenantSessionRegistry({
    authRoot: opts?.authRoot ?? path.join(os.tmpdir(), `t3-${process.pid}-${created.length}`),
    startSession: async (authDir: string) => {
      const left = failLeft.get(authDir) ?? 0;
      if (left > 0) {
        failLeft.set(authDir, left - 1);
        throw new Error(`connect refused (${left} more failures)`);
      }
      const s = new FakeSession(authDir);
      created.push(s);
      return s;
    },
    // Instant timers, but record the requested delays so backoff/stagger is assertable.
    wait: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    staggerMs: opts?.staggerMs ?? 2000,
    maxStartRetries: 3,
    backoffMs: 1000,
  });
  return { registry, created, delays };
}

describe("TenantSessionRegistry — lifecycle", () => {
  it("starts a session per tenant under its own auth dir; default tenant keeps the legacy dir", async () => {
    const { registry, created } = makeRegistry({ authRoot: "/data/baileys-auth" });
    await registry.start(A);
    await registry.start(DEFAULT_TENANT_ID);

    expect(created[0]!.authDir).toBe(path.join("/data/baileys-auth", A));
    // Backward compat: the pre-T3 single-user link lives at the root — must NOT need re-linking.
    expect(created[1]!.authDir).toBe("/data/baileys-auth");
  });

  it("stop(tenant) stops only that tenant's session; stopAll stops the rest", async () => {
    const { registry, created } = makeRegistry();
    await registry.start(A);
    await registry.start(B);

    registry.stop(A);
    expect(created[0]!.stopped).toBe(true);
    expect(created[1]!.stopped).toBe(false);
    expect(registry.snapshot().find((s) => s.tenantId === A)?.status).toBe("stopped");

    registry.stopAll();
    expect(created[1]!.stopped).toBe(true);
  });

  it("tracks connected/disconnected transitions per tenant in the health snapshot", async () => {
    const { registry, created } = makeRegistry();
    await registry.start(A);
    await registry.start(B);

    created[0]!.emit("connected");
    expect(registry.snapshot().find((s) => s.tenantId === A)?.status).toBe("connected");
    expect(registry.snapshot().find((s) => s.tenantId === B)?.status).toBe("connecting");

    created[0]!.emit("disconnected");
    expect(registry.snapshot().find((s) => s.tenantId === A)?.status).toBe("disconnected");
    // B is untouched by A's churn.
    expect(registry.snapshot().find((s) => s.tenantId === B)?.status).toBe("connecting");
  });

  it("marks a logged-out session terminal (needs re-link, no restart loop)", async () => {
    const { registry, created } = makeRegistry();
    await registry.start(A);
    created[0]!.emit("logged-out");
    expect(registry.snapshot().find((s) => s.tenantId === A)?.status).toBe("logged-out");
  });

  it("re-emits history-progress with the tenant prepended (S5 scan-% feed)", async () => {
    const { registry, created } = makeRegistry();
    await registry.start(A);
    await registry.start(B);

    const seen: unknown[][] = [];
    registry.on("history-progress", (...args) => seen.push(args));

    const info = { progress: 42, isLatest: false, syncType: 2, count: 7 };
    created[0]!.emit("history-progress", info);

    expect(seen).toEqual([[A, info]]);
    // B's session never fired — only A's progress is attributed.
    expect(seen.every(([tenant]) => tenant === A)).toBe(true);
  });
});

describe("TenantSessionRegistry — supervision", () => {
  it("retries a failing start with backoff and succeeds within maxStartRetries", async () => {
    const authRoot = "/data/baileys-auth";
    const failures = new Map([[path.join(authRoot, A), 2]]);
    const { registry, created, delays } = makeRegistry({
      failuresBeforeSuccess: failures,
      authRoot,
    });

    await registry.start(A);

    expect(created).toHaveLength(1); // eventually connected
    expect(registry.snapshot().find((s) => s.tenantId === A)?.restarts).toBe(2);
    // Exponential-ish backoff was requested between attempts.
    expect(delays.filter((d) => d >= 1000)).toHaveLength(2);
  });

  it("gives up after maxStartRetries and marks the tenant failed — without disturbing others", async () => {
    const authRoot = "/data/baileys-auth";
    const failures = new Map([[path.join(authRoot, A), 99]]);
    const { registry, created } = makeRegistry({ failuresBeforeSuccess: failures, authRoot });

    await registry.start(B); // healthy neighbor first
    await registry.start(A); // hopeless

    expect(registry.snapshot().find((s) => s.tenantId === A)?.status).toBe("failed");
    expect(registry.snapshot().find((s) => s.tenantId === A)?.lastError).toContain("connect");
    // B is alive and was never touched.
    expect(created).toHaveLength(1);
    expect(created[0]!.stopped).toBe(false);
  });
});

describe("TenantSessionRegistry — discovery + stagger", () => {
  it("discovers linked tenants (creds.json present) and starts them with a stagger between connects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-disc-"));
    // Linked tenant A, linked legacy/default, unlinked junk dir, non-uuid dir.
    fs.mkdirSync(path.join(root, A), { recursive: true });
    fs.writeFileSync(path.join(root, A, "creds.json"), "{}");
    fs.writeFileSync(path.join(root, "creds.json"), "{}"); // legacy default link at root
    fs.mkdirSync(path.join(root, B)); // no creds.json → not linked
    fs.mkdirSync(path.join(root, "not-a-tenant"));

    const { registry, created, delays } = makeRegistry({ authRoot: root, staggerMs: 5000 });
    const started = await registry.startDiscovered();

    expect(started.sort()).toEqual([DEFAULT_TENANT_ID, A].sort());
    expect(created).toHaveLength(2);
    // Ban-risk mitigation: connects are staggered, not simultaneous.
    expect(delays).toContain(5000);
  });

  it("startDiscovered can exclude tenants (serve owns the default session separately)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-excl-"));
    fs.mkdirSync(path.join(root, A), { recursive: true });
    fs.writeFileSync(path.join(root, A, "creds.json"), "{}");
    fs.writeFileSync(path.join(root, "creds.json"), "{}");

    const { registry, created } = makeRegistry({ authRoot: root });
    const started = await registry.startDiscovered({ exclude: [DEFAULT_TENANT_ID] });

    expect(started).toEqual([A]);
    expect(created).toHaveLength(1);
    expect(created[0]!.authDir).toBe(path.join(root, A));
  });
});
