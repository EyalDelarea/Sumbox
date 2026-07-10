import { describe, expect, it } from "vitest";
import {
  type CheckResult,
  checkComposeServices,
  checkDocker,
  checkFfmpeg,
  checkIndexIntegrity,
  checkOllama,
  checkPostgres,
  checkPython,
  checkRabbitMQ,
  runChecks,
} from "./checks.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ok = () => Promise.resolve(true);
const fail = () => Promise.resolve(false);
const throws = () => Promise.reject(new Error("probe boom"));

function assertOk(result: CheckResult, name: string) {
  expect(result.name).toBe(name);
  expect(result.ok).toBe(true);
}

function assertFail(result: CheckResult, name: string) {
  expect(result.name).toBe(name);
  expect(result.ok).toBe(false);
  expect(result.fix).toBeTruthy();
  expect(result.fix!.length).toBeGreaterThan(0);
}

// ── checkDocker ───────────────────────────────────────────────────────────────

describe("checkDocker", () => {
  it("returns ok when Docker is running", async () => {
    const result = await checkDocker(ok);
    assertOk(result, "Docker running");
  });

  it("returns not-ok with a fix when Docker is not running", async () => {
    const result = await checkDocker(fail);
    assertFail(result, "Docker running");
  });

  it("returns not-ok with a fix when probe throws", async () => {
    const result = await checkDocker(throws);
    assertFail(result, "Docker running");
  });
});

// ── checkComposeServices ──────────────────────────────────────────────────────

describe("checkComposeServices", () => {
  it("returns ok when Compose services are up", async () => {
    const result = await checkComposeServices(ok);
    assertOk(result, "Compose services up");
  });

  it("returns not-ok with a fix when services are down", async () => {
    const result = await checkComposeServices(fail);
    assertFail(result, "Compose services up");
  });

  it("returns not-ok with a fix when probe throws", async () => {
    const result = await checkComposeServices(throws);
    assertFail(result, "Compose services up");
  });
});

// ── checkPostgres ─────────────────────────────────────────────────────────────

describe("checkPostgres", () => {
  it("returns ok when Postgres is reachable and migrations applied", async () => {
    const result = await checkPostgres(ok);
    assertOk(result, "Postgres reachable + migrations applied");
  });

  it("returns not-ok with a fix when Postgres check fails", async () => {
    const result = await checkPostgres(fail);
    assertFail(result, "Postgres reachable + migrations applied");
  });

  it("returns not-ok with a fix when probe throws", async () => {
    const result = await checkPostgres(throws);
    assertFail(result, "Postgres reachable + migrations applied");
  });
});

// ── checkIndexIntegrity ───────────────────────────────────────────────────────

describe("checkIndexIntegrity", () => {
  const NAME = "DB indexes pass integrity check (amcheck)";

  it("returns ok when all indexes pass amcheck", async () => {
    const result = await checkIndexIntegrity(ok);
    assertOk(result, NAME);
  });

  it("returns not-ok with detail + fix when an index is corrupt", async () => {
    const result = await checkIndexIntegrity(fail);
    assertFail(result, NAME);
    expect(result.detail).toMatch(/XX002|collation/);
    // Corruption is a hard failure, not advisory — no warn level.
    expect(result.level).toBeUndefined();
  });

  it("treats a probe error as inconclusive (ok), not corrupt", async () => {
    // The probe never throws in practice, but a throw must not masquerade as
    // corruption (which would hard-fail doctor on an environment quirk).
    const result = await checkIndexIntegrity(throws);
    assertOk(result, NAME);
  });
});

// ── checkRabbitMQ ─────────────────────────────────────────────────────────────

describe("checkRabbitMQ", () => {
  it("returns ok when RabbitMQ is reachable", async () => {
    const result = await checkRabbitMQ(ok);
    assertOk(result, "RabbitMQ reachable");
  });

  it("returns not-ok with a fix when RabbitMQ is unreachable", async () => {
    const result = await checkRabbitMQ(fail);
    assertFail(result, "RabbitMQ reachable");
  });

  it("returns not-ok with a fix when probe throws", async () => {
    const result = await checkRabbitMQ(throws);
    assertFail(result, "RabbitMQ reachable");
  });
});

// ── checkOllama ───────────────────────────────────────────────────────────────

describe("checkOllama", () => {
  it("returns ok when Ollama is reachable and model is pulled", async () => {
    const result = await checkOllama("gemma4:26b", ok);
    assertOk(result, "Ollama reachable + model pulled");
  });

  it("returns not-ok with a fix when Ollama is unreachable or model not pulled", async () => {
    const result = await checkOllama("gemma4:26b", fail);
    assertFail(result, "Ollama reachable + model pulled");
    // fix hint should reference the model name
    expect(result.fix).toContain("gemma4:26b");
  });

  it("returns not-ok with a fix when probe throws", async () => {
    const result = await checkOllama("mymodel:latest", throws);
    assertFail(result, "Ollama reachable + model pulled");
    expect(result.fix).toContain("mymodel:latest");
  });
});

// ── checkPython ───────────────────────────────────────────────────────────────

describe("checkPython", () => {
  it("returns ok when Python and faster-whisper are importable", async () => {
    const result = await checkPython(ok);
    assertOk(result, "Python + faster-whisper importable");
  });

  it("returns not-ok with a fix when Python check fails", async () => {
    const result = await checkPython(fail);
    assertFail(result, "Python + faster-whisper importable");
  });

  it("returns not-ok with a fix when probe throws", async () => {
    const result = await checkPython(throws);
    assertFail(result, "Python + faster-whisper importable");
  });
});

// ── checkFfmpeg ───────────────────────────────────────────────────────────────

describe("checkFfmpeg", () => {
  it("returns ok when ffmpeg is on PATH", async () => {
    const result = await checkFfmpeg(ok);
    assertOk(result, "ffmpeg on PATH");
  });

  it("returns not-ok with a fix when ffmpeg is missing", async () => {
    const result = await checkFfmpeg(fail);
    assertFail(result, "ffmpeg on PATH");
  });

  it("returns not-ok with a fix when probe throws", async () => {
    const result = await checkFfmpeg(throws);
    assertFail(result, "ffmpeg on PATH");
  });
});

// ── runChecks ─────────────────────────────────────────────────────────────────

describe("runChecks", () => {
  it("runs all checks and returns one result per check", async () => {
    const checks = [() => checkDocker(ok), () => checkComposeServices(ok), () => checkPostgres(ok)];
    const results = await runChecks(checks);
    expect(results).toHaveLength(3);
  });

  it("continues running remaining checks when some fail", async () => {
    const checks = [
      () => checkDocker(fail),
      () => checkComposeServices(ok),
      () => checkRabbitMQ(fail),
    ];
    const results = await runChecks(checks);
    expect(results).toHaveLength(3);
    expect(results[0]!.ok).toBe(false);
    expect(results[1]!.ok).toBe(true);
    expect(results[2]!.ok).toBe(false);
  });

  it("does not throw when a check probe throws — still returns a result", async () => {
    const checks = [() => checkDocker(throws), () => checkComposeServices(ok)];
    // runChecks must never throw; each check catches its own errors
    const results = await runChecks(checks);
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(false);
    expect(results[1]!.ok).toBe(true);
  });

  it("returns empty array for empty checks list", async () => {
    const results = await runChecks([]);
    expect(results).toHaveLength(0);
  });
});
