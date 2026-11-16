import { describe, expect, it } from "vitest";
import {
  assertLoadedStoredCreds,
  backoffDelay,
  CredsSaver,
  type CredsSaverOptions,
  CredsUnreadableError,
  readStoredCreds,
} from "./creds-persistence.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const eperm = () =>
  Object.assign(new Error("EPERM: operation not permitted, open 'data/baileys-auth/creds.json'"), {
    code: "EPERM",
  });

/** Settle every queued promise callback (the saver chains a few .then hops). */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A manual timer: tests fire scheduled callbacks explicitly, recording delays. */
function manualTimer() {
  const pending: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
  return {
    delays: () => pending.map((p) => p.ms),
    setTimer: (cb: () => void, ms: number) => {
      const entry = { cb, ms, cleared: false };
      pending.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (t: ReturnType<typeof setTimeout>) => {
      (t as unknown as { cleared: boolean }).cleared = true;
    },
    /** Fire the most recently scheduled live timer. */
    fireLatest: () => {
      const live = pending.filter((p) => !p.cleared);
      const last = live[live.length - 1];
      if (!last) throw new Error("no timer scheduled");
      last.cleared = true;
      last.cb();
    },
    liveCount: () => pending.filter((p) => !p.cleared).length,
  };
}

function setup(over: Partial<CredsSaverOptions> = {}) {
  const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const infos: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const lastResort: string[] = [];
  const fatals: Array<{ err: unknown; failures: number }> = [];
  const timer = manualTimer();
  const saver = new CredsSaver({
    log: {
      error: (obj, msg) => errors.push({ obj, msg }),
      warn: (obj, msg) => warns.push({ obj, msg }),
      info: (obj, msg) => infos.push({ obj, msg }),
    },
    lastResort: (line) => lastResort.push(line),
    onFatal: (err, failures) => fatals.push({ err, failures }),
    maxConsecutiveFailures: 3,
    backoff: { baseMs: 100, capMs: 1_000 },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    ...over,
  });
  return { saver, errors, infos, warns, lastResort, fatals, timer };
}

// ── backoffDelay ────────────────────────────────────────────────────────────

describe("backoffDelay", () => {
  it("doubles from base and caps", () => {
    const o = { baseMs: 1_000, capMs: 60_000 };
    expect([1, 2, 3, 4, 7, 8, 20].map((n) => backoffDelay(n, o))).toEqual([
      1_000, 2_000, 4_000, 8_000, 60_000, 60_000, 60_000,
    ]);
  });
});

// ── CredsSaver ──────────────────────────────────────────────────────────────

describe("CredsSaver", () => {
  it("saves on update and logs nothing on success", async () => {
    const { saver, errors, fatals } = setup();
    let saves = 0;
    saver.bind(async () => {
      saves++;
    });
    saver.onUpdate();
    await flush();
    expect(saves).toBe(1);
    expect(errors).toEqual([]);
    expect(fatals).toEqual([]);
  });

  it("a failing save never rejects: it logs at error level with context and retries", async () => {
    const { saver, errors, fatals, timer } = setup();
    let calls = 0;
    saver.bind(async () => {
      calls++;
      if (calls === 1) throw eperm();
    });

    // The listener itself returns void — nothing for the EventEmitter to drop.
    expect(saver.onUpdate()).toBeUndefined();
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toMatch(/creds save failed — will retry/);
    expect(errors[0]?.obj).toMatchObject({ consecutiveFailures: 1, retryInMs: 100 });
    expect(String(errors[0]?.obj.err)).toMatch(/EPERM/);
    expect(timer.delays()).toEqual([100]);

    timer.fireLatest();
    await flush();
    expect(calls).toBe(2);
    expect(saver.consecutiveFailures).toBe(0);
    expect(fatals).toEqual([]);
  });

  it("logs the recovery after failures", async () => {
    const { saver, infos, timer } = setup();
    let calls = 0;
    saver.bind(async () => {
      calls++;
      if (calls <= 2) throw eperm();
    });
    saver.onUpdate();
    await flush();
    timer.fireLatest();
    await flush();
    timer.fireLatest();
    await flush();
    expect(infos).toEqual([
      { obj: { failuresBeforeSuccess: 2 }, msg: "creds save recovered after failure(s)" },
    ]);
  });

  it("backs off exponentially and calls onFatal exactly once after N consecutive failures", async () => {
    const { saver, fatals, timer, errors } = setup();
    saver.bind(async () => {
      throw eperm();
    });
    saver.onUpdate();
    await flush();
    timer.fireLatest();
    await flush();
    timer.fireLatest();
    await flush();

    expect(timer.delays()).toEqual([100, 200]);
    expect(fatals).toHaveLength(1);
    expect(fatals[0]?.failures).toBe(3);
    expect(errors[errors.length - 1]?.msg).toMatch(/giving up/);
    // No further retry is scheduled after the fatal.
    expect(timer.liveCount()).toBe(0);

    // A later update after giving up must not raise a second fatal.
    saver.onUpdate();
    await flush();
    expect(fatals).toHaveLength(1);
  });

  it("a success resets the consecutive count, so scattered failures never go fatal", async () => {
    const { saver, fatals, timer } = setup();
    let calls = 0;
    // fail, ok, fail, ok, fail, ok — never 3 in a row
    saver.bind(async () => {
      calls++;
      if (calls % 2 === 1) throw eperm();
    });
    for (let i = 0; i < 3; i++) {
      saver.onUpdate();
      await flush();
      timer.fireLatest();
      await flush();
    }
    expect(calls).toBe(6);
    expect(fatals).toEqual([]);
  });

  it("coalesces updates that arrive while a retry is pending into one save", async () => {
    const { saver, timer } = setup();
    let calls = 0;
    saver.bind(async () => {
      calls++;
      if (calls === 1) throw eperm();
    });
    saver.onUpdate();
    await flush();
    saver.onUpdate();
    saver.onUpdate();
    await flush();
    expect(calls).toBe(1); // still waiting on the retry timer
    timer.fireLatest();
    await flush();
    expect(calls).toBe(2);
  });

  it("re-saves once when an update lands while a save is in flight", async () => {
    const { saver } = setup();
    let calls = 0;
    let release: () => void = () => {};
    saver.bind(() => {
      calls++;
      if (calls === 1) return new Promise<void>((r) => (release = r));
      return Promise.resolve();
    });
    saver.onUpdate();
    await flush();
    saver.onUpdate();
    saver.onUpdate();
    await flush();
    expect(calls).toBe(1);
    release();
    await flush();
    expect(calls).toBe(2);
  });

  it("keeps the failure count across bind() — a reconnect storm still reaches the fatal", async () => {
    const { saver, fatals, timer } = setup();
    const failing = async () => {
      throw eperm();
    };
    saver.bind(failing);
    saver.onUpdate();
    await flush();
    saver.bind(failing); // reconnect
    timer.fireLatest();
    await flush();
    saver.bind(failing); // reconnect
    timer.fireLatest();
    await flush();
    expect(fatals).toHaveLength(1);
  });

  it("a pending retry writes through the most recently bound save", async () => {
    const { saver, timer } = setup();
    const used: string[] = [];
    saver.bind(async () => {
      used.push("old");
      throw eperm();
    });
    saver.onUpdate();
    await flush();
    saver.bind(async () => {
      used.push("new");
    });
    timer.fireLatest();
    await flush();
    expect(used).toEqual(["old", "new"]);
  });

  it("turns a synchronous throw from save into a handled failure", async () => {
    const { saver, errors } = setup();
    saver.bind(() => {
      throw eperm();
    });
    expect(() => saver.onUpdate()).not.toThrow();
    await flush();
    expect(errors).toHaveLength(1);
  });

  it("stop() cancels the pending retry and ignores later updates", async () => {
    const { saver, timer } = setup();
    let calls = 0;
    saver.bind(async () => {
      calls++;
      throw eperm();
    });
    saver.onUpdate();
    await flush();
    expect(timer.liveCount()).toBe(1);
    saver.stop();
    expect(timer.liveCount()).toBe(0);
    saver.onUpdate();
    await flush();
    expect(calls).toBe(1);
  });
});

// ── CredsSaver: hostile edges ───────────────────────────────────────────────

describe("CredsSaver — nothing escapes as an unhandled rejection", () => {
  it("a throwing logger still retries, and reaches the fatal", async () => {
    const { saver, fatals, timer, lastResort } = setup({
      log: {
        error: () => {
          throw new Error("EPIPE on log");
        },
        warn: () => {},
        info: () => {},
      },
    });
    saver.bind(async () => {
      throw eperm();
    });
    saver.onUpdate();
    await flush();
    timer.fireLatest();
    await flush();
    timer.fireLatest();
    await flush();
    expect(fatals).toHaveLength(1);
    expect(lastResort.some((l) => l.includes("EPIPE on log"))).toBe(true);
  });

  it("a throwing onFatal is caught and reported, not left unhandled", async () => {
    const { saver, lastResort } = setup({
      maxConsecutiveFailures: 1,
      onFatal: () => {
        throw new Error("exit blew up");
      },
    });
    saver.bind(async () => {
      throw eperm();
    });
    saver.onUpdate();
    await flush();
    expect(lastResort.some((l) => l.includes("exit blew up"))).toBe(true);
  });
});

describe("CredsSaver — unsaved state is never dropped silently", () => {
  it("stop() with a pending retry warns that creds.json keeps the last saved state", async () => {
    const { saver, warns } = setup();
    saver.bind(async () => {
      throw eperm();
    });
    saver.onUpdate();
    await flush();
    saver.stop();
    expect(warns.map((w) => w.msg)).toEqual([
      "session stopped with unsaved creds updates — creds.json keeps the last saved state",
    ]);
  });

  it("stop() after clean saves is silent", async () => {
    const { saver, warns } = setup();
    saver.bind(async () => {});
    saver.onUpdate();
    await flush();
    saver.stop();
    expect(warns).toEqual([]);
  });

  it("a save that fails after stop() is logged and not retried", async () => {
    const { saver, errors, timer } = setup();
    let reject: (e: unknown) => void = () => {};
    saver.bind(() => new Promise<void>((_, r) => (reject = r)));
    saver.onUpdate();
    await flush();
    saver.stop();
    reject(eperm());
    await flush();
    expect(errors.map((e) => e.msg)).toEqual([
      "creds save failed after the session stopped — not retrying",
    ]);
    expect(timer.liveCount()).toBe(0);
  });

  it("rebinding while saves are failing warns that the unsaved updates are superseded", async () => {
    const { saver, warns } = setup();
    saver.bind(async () => {
      throw eperm();
    });
    saver.onUpdate();
    await flush();
    saver.bind(async () => {});
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toMatch(/continuing from the last saved creds\.json/);
  });

  it("rebinding after clean saves is silent", async () => {
    const { saver, warns } = setup();
    saver.bind(async () => {});
    saver.onUpdate();
    await flush();
    saver.bind(async () => {});
    expect(warns).toEqual([]);
  });
});

// ── Read guard ──────────────────────────────────────────────────────────────

describe("readStoredCreds", () => {
  it("returns null when creds.json does not exist (first link)", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    await expect(readStoredCreds("/auth", () => Promise.reject(enoent))).resolves.toBeNull();
  });

  it("returns the parsed creds when creds.json reads and parses", async () => {
    await expect(
      readStoredCreds("/auth", () => Promise.resolve('{"registrationId":42}')),
    ).resolves.toEqual({ registrationId: 42 });
  });

  it.each([
    ["EPERM", eperm()],
    ["EACCES", Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })],
    ["EISDIR", Object.assign(new Error("EISDIR"), { code: "EISDIR" })],
  ])("refuses when creds.json exists but can't be opened (%s)", async (_code, cause) => {
    const err = await readStoredCreds("/auth", () => Promise.reject(cause)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CredsUnreadableError);
    expect((err as CredsUnreadableError).credsPath).toBe("/auth/creds.json");
    expect((err as CredsUnreadableError).cause).toBe(cause);
  });

  it("refuses a half-written creds.json", async () => {
    await expect(
      readStoredCreds("/auth", () => Promise.resolve('{"registrationId":4')),
    ).rejects.toBeInstanceOf(CredsUnreadableError);
  });

  it("reads the real file system by default", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-"));
    try {
      await expect(readStoredCreds(dir)).resolves.toBeNull();
      fs.writeFileSync(path.join(dir, "creds.json"), '{"registrationId":7}');
      await expect(readStoredCreds(dir)).resolves.toEqual({ registrationId: 7 });
      fs.writeFileSync(path.join(dir, "creds.json"), "{");
      await expect(readStoredCreds(dir)).rejects.toBeInstanceOf(CredsUnreadableError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertLoadedStoredCreds", () => {
  it("accepts anything on a first link (nothing stored)", () => {
    expect(() => assertLoadedStoredCreds("/auth", null, { registrationId: 1 })).not.toThrow();
  });

  it("accepts the stored creds coming back", () => {
    expect(() =>
      assertLoadedStoredCreds("/auth", { registrationId: 9 }, { registrationId: 9 }),
    ).not.toThrow();
  });

  it("refuses when Baileys silently minted fresh creds over a stored link", () => {
    expect(() =>
      assertLoadedStoredCreds("/auth", { registrationId: 9 }, { registrationId: 1234 }),
    ).toThrow(CredsUnreadableError);
  });
});
