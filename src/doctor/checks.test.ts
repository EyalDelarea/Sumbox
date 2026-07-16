import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { type CheckEntry, checkEntries, defaultChecks, runCheck, runChecks } from "./checks.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ok = () => Promise.resolve(true);
const fail = () => Promise.resolve(false);
const throws = () => Promise.reject(new Error("probe boom"));

/** A check entry with sensible defaults; override any field per test. */
const entry = (over: Partial<CheckEntry> = {}): CheckEntry => ({
  name: "Test check",
  fix: "do the thing",
  probe: ok,
  ...over,
});

/** Minimal AppConfig carrying only the fields the check table reads. */
const fakeConfig = (model = "gemma4:26b"): AppConfig =>
  ({
    databaseUrl: "postgres://localhost/test",
    broker: { url: "amqp://localhost" },
    summarization: { model, ollamaHost: "http://localhost:11434" },
    transcription: { pythonPath: "python3", ffmpegPath: "ffmpeg" },
  }) as unknown as AppConfig;

// ── runCheck ──────────────────────────────────────────────────────────────────

describe("runCheck", () => {
  it("returns ok (no fix/detail) when the probe resolves true", async () => {
    expect(await runCheck(entry({ probe: ok }))).toEqual({ name: "Test check", ok: true });
  });

  it("returns not-ok with the fix when the probe resolves false", async () => {
    const r = await runCheck(entry({ probe: fail }));
    expect(r.ok).toBe(false);
    expect(r.fix).toBe("do the thing");
  });

  it("treats a probe throw as not-ok with fix by default", async () => {
    const r = await runCheck(entry({ probe: throws }));
    expect(r.ok).toBe(false);
    expect(r.fix).toBe("do the thing");
  });

  it("treats a probe throw as inconclusive (ok) when onProbeError is 'pass'", async () => {
    expect(await runCheck(entry({ probe: throws, onProbeError: "pass" }))).toEqual({
      name: "Test check",
      ok: true,
    });
  });

  it("still fails on a definitive false even when onProbeError is 'pass'", async () => {
    // onProbeError only governs *throws*; a false verdict is a real failure.
    const r = await runCheck(entry({ probe: fail, onProbeError: "pass", detail: "d" }));
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("d");
  });

  it("includes detail on a non-ok result when the entry has one (and no warn level)", async () => {
    const r = await runCheck(entry({ probe: fail, detail: "why it broke" }));
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("why it broke");
    expect(r.level).toBeUndefined();
  });

  it("omits detail on an ok result", async () => {
    expect(await runCheck(entry({ probe: ok, detail: "why it broke" }))).toEqual({
      name: "Test check",
      ok: true,
    });
  });
});

// ── checkEntries (the table) ────────────────────────────────────────────────

describe("checkEntries", () => {
  it("lists every check in stable display order, each with a fix hint", () => {
    const entries = checkEntries(fakeConfig());
    expect(entries.map((e) => e.name)).toEqual([
      "Docker running",
      "Compose services up",
      "Postgres reachable + migrations applied",
      "DB indexes pass integrity check (amcheck)",
      "RabbitMQ reachable",
      "Ollama reachable + model pulled",
      "Python + faster-whisper importable",
      "ffmpeg on PATH",
      // App health last — every infra check above is a prerequisite for it.
      "@Aida embeddings current",
    ]);
    for (const e of entries) expect(e.fix.length).toBeGreaterThan(0);
  });

  it("interpolates the configured model into the Ollama fix", () => {
    const ollama = checkEntries(fakeConfig("mymodel:latest")).find((e) =>
      e.name.startsWith("Ollama"),
    );
    expect(ollama?.fix).toContain("mymodel:latest");
  });

  it("marks index-integrity as inconclusive-on-probe-error and gives it a detail", () => {
    const idx = checkEntries(fakeConfig()).find((e) => e.name.startsWith("DB indexes"));
    expect(idx?.onProbeError).toBe("pass");
    expect(idx?.detail).toMatch(/XX002|collation/);
  });

  it("uses the default (fail) probe-error policy for every other check", () => {
    // Both exceptions defer a DB outage to the Postgres check rather than
    // reporting it a second time.
    const others = checkEntries(fakeConfig()).filter(
      (e) => !e.name.startsWith("DB indexes") && !e.name.startsWith("@Aida"),
    );
    for (const e of others) expect(e.onProbeError).toBeUndefined();
  });

  it("marks the @Aida embedding check advisory, not a hard failure", () => {
    // A stale sweep degrades @Aida without breaking Sumbox — and in split-dev it
    // is simply what "the worker isn't running" looks like. Failing hard there
    // would make the doctor cry wolf every time only dev-ui is up.
    const aida = checkEntries(fakeConfig()).find((e) => e.name.startsWith("@Aida"));
    expect(aida?.level).toBe("warn");
    expect(aida?.onProbeError).toBe("pass");
  });
});

// ── runChecks / defaultChecks ─────────────────────────────────────────────────

describe("runChecks", () => {
  it("runs all checks and returns one result per check", async () => {
    const checks = [
      () => runCheck(entry({ name: "a", probe: ok })),
      () => runCheck(entry({ name: "b", probe: ok })),
      () => runCheck(entry({ name: "c", probe: ok })),
    ];
    expect(await runChecks(checks)).toHaveLength(3);
  });

  it("continues running remaining checks when some fail", async () => {
    const results = await runChecks([
      () => runCheck(entry({ name: "a", probe: fail })),
      () => runCheck(entry({ name: "b", probe: ok })),
      () => runCheck(entry({ name: "c", probe: fail })),
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]!.ok).toBe(false);
    expect(results[1]!.ok).toBe(true);
    expect(results[2]!.ok).toBe(false);
  });

  it("does not throw when a check probe throws — still returns a result", async () => {
    const results = await runChecks([
      () => runCheck(entry({ name: "a", probe: throws })),
      () => runCheck(entry({ name: "b", probe: ok })),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(false);
    expect(results[1]!.ok).toBe(true);
  });

  it("returns empty array for empty checks list", async () => {
    expect(await runChecks([])).toHaveLength(0);
  });

  it("defaultChecks wires the full table into runnable thunks", async () => {
    const checks = defaultChecks(fakeConfig());
    expect(checks).toHaveLength(9);
  });
});
