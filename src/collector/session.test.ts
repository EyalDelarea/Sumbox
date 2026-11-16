/**
 * CollectorSession wiring tests — driven through injected SessionDeps (a fake
 * socket whose `ev` is a plain EventEmitter, as Baileys' is), so no WhatsApp.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredsUnreadableError, type StoredCreds } from "./creds-persistence.js";
import { CollectorSession, type SessionDeps } from "./session.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const eperm = () =>
  Object.assign(new Error("EPERM: operation not permitted, open 'creds.json'"), { code: "EPERM" });

/** Let queued promise callbacks and one macrotask turn run. */
const settle = () => new Promise((r) => setImmediate(r));

type FakeSocket = { ev: EventEmitter; end: () => void };

function harness(over: Partial<SessionDeps> = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const exits: Array<{ message: string; err: unknown }> = [];
  const deps: Partial<SessionDeps> = {
    useAuthState: async () => ({
      state: { creds: { registrationId: 1 } },
      saveCreds: async () => {},
    }),
    makeSocket: () => {
      const sock: FakeSocket = { ev: new EventEmitter(), end: () => {} };
      sockets.push(sock);
      return sock as unknown as ReturnType<SessionDeps["makeSocket"]>;
    },
    fetchVersion: async () => ({ version: [2, 3000, 1] }),
    readStoredCreds: async () => ({ registrationId: 1 }),
    setTimer: (cb) => {
      timers.push(cb);
    },
    exit: (message, err) => exits.push({ message, err }),
    ...over,
  };
  // connect() mkdirs the auth dir; nothing is read from or written to it here.
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-session-"));
  tmpDirs.push(authDir);
  const session = new CollectorSession(authDir, false, { deps });
  return {
    session,
    authDir,
    sockets,
    exits,
    latest: () => sockets[sockets.length - 1]!,
    /** Run the most recently scheduled reconnect and let it finish. */
    fireReconnect: async () => {
      const cb = timers.pop();
      if (!cb) throw new Error("no reconnect scheduled");
      cb();
      await settle();
    },
    pendingTimers: () => timers.length,
  };
}

/** Make the socket close the way a 408 does (not a logout), scheduling a reconnect. */
function dropConnection(sock: FakeSocket) {
  sock.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: Object.assign(new Error("timed out"), { output: { statusCode: 408 } }),
    },
  });
}

let session: CollectorSession | null = null;
const tmpDirs: string[] = [];
afterEach(() => {
  session?.stop();
  session = null;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ── creds.update wiring ─────────────────────────────────────────────────────

describe("CollectorSession — creds.update wiring", () => {
  it("a rejected save on creds.update is NOT an unhandled rejection (the 2026-11-15 crash)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      let saves = 0;
      const saveCreds = async () => {
        saves++;
        throw eperm();
      };
      const h = harness({
        useAuthState: async () => ({ state: { creds: { registrationId: 1 } }, saveCreds }),
      });
      session = h.session;
      await h.session.start();

      // The listener Baileys calls is the guarded saver, never saveCreds itself.
      const listeners = h.latest().ev.listeners("creds.update");
      expect(listeners).toHaveLength(1);
      expect(listeners[0]).not.toBe(saveCreds);

      h.latest().ev.emit("creds.update", {});
      await settle();
      await settle();

      expect(saves).toBe(1);
      expect(unhandled).toEqual([]);
      expect(h.exits).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ── connect failures ────────────────────────────────────────────────────────

describe("CollectorSession — connect failures count only when consecutive", () => {
  /**
   * readStoredCreds scripted per call: true = loads, false = EPERM-style refusal.
   * Call 0 is start().
   */
  function scriptedReads(script: boolean[]) {
    let call = 0;
    return async (dir: string): Promise<StoredCreds | null> => {
      const ok = script[call++] ?? true;
      if (!ok) throw new CredsUnreadableError(`${dir}/creds.json`, eperm());
      return { registrationId: 1 };
    };
  }

  it("a successful creds load breaks the streak — scattered failures in a storm never exit", async () => {
    // start ok, 9 fails, ok, 9 fails: 18 failures, never 10 in a row.
    const script = [true, ...Array(9).fill(false), true, ...Array(9).fill(false)];
    const h = harness({ readStoredCreds: scriptedReads(script) });
    session = h.session;
    await h.session.start();

    dropConnection(h.latest()); // 408 → reconnect scheduled
    for (let i = 0; i < 9; i++) await h.fireReconnect(); // 9 refusals, each reschedules
    await h.fireReconnect(); // loads → new socket, streak reset
    expect(h.sockets).toHaveLength(2);

    dropConnection(h.latest());
    for (let i = 0; i < 9; i++) await h.fireReconnect();

    expect(h.exits).toEqual([]);
    expect(h.pendingTimers()).toBe(1); // still retrying
  });

  it("ten consecutive refusals exit loudly, naming the file and how to recover", async () => {
    const h = harness({ readStoredCreds: scriptedReads([true, ...Array(10).fill(false)]) });
    session = h.session;
    await h.session.start();
    dropConnection(h.latest());
    for (let i = 0; i < 10; i++) await h.fireReconnect();

    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]?.message).toMatch(/10 consecutive times/);
    const why = String(h.exits[0]?.err);
    expect(why).toContain(path.join(h.authDir, "creds.json"));
    expect(why).toMatch(/restore/);
    expect(why).toMatch(/re-pair/);
    expect(why).toMatch(/QR/);
    expect(why).toMatch(/Nothing was deleted/);
  });

  it("an unreadable creds.json at boot retries instead of failing start()", async () => {
    const h = harness({ readStoredCreds: scriptedReads([false, true]) });
    session = h.session;
    await expect(h.session.start()).resolves.toBeUndefined();
    expect(h.sockets).toHaveLength(0); // never connected with fresh creds
    await h.fireReconnect();
    expect(h.sockets).toHaveLength(1);
  });

  it("refuses when Baileys silently minted fresh creds over the stored link", async () => {
    const h = harness({
      readStoredCreds: async () => ({ registrationId: 1 }),
      useAuthState: async () => ({
        state: { creds: { registrationId: 999 } },
        saveCreds: async () => {},
      }),
    });
    session = h.session;
    await h.session.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.pendingTimers()).toBe(1);
  });
});
