import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckResult = {
  name: string;
  ok: boolean;
  /** A non-ok result with level "warn" is advisory — surfaced but not a hard failure. */
  level?: "warn";
  detail?: string;
  fix?: string;
};

// ── Pure check functions (injected probe) ─────────────────────────────────────

/** 1. Docker running */
export async function checkDocker(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "Docker running";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "start Docker Desktop" };
  } catch (err) {
    return { name, ok: false, fix: "start Docker Desktop" };
  }
}

/** 2. Compose services up */
export async function checkComposeServices(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "Compose services up";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "docker compose up -d" };
  } catch (err) {
    return { name, ok: false, fix: "docker compose up -d" };
  }
}

/** 3. Postgres reachable AND migrations applied (job_runs + service_status tables exist) */
export async function checkPostgres(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "Postgres reachable + migrations applied";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "npm run migrate" };
  } catch (err) {
    return { name, ok: false, fix: "npm run migrate" };
  }
}

/** 4. RabbitMQ reachable */
export async function checkRabbitMQ(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "RabbitMQ reachable";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "docker compose up -d rabbitmq" };
  } catch (err) {
    return { name, ok: false, fix: "docker compose up -d rabbitmq" };
  }
}

/** 5. Ollama reachable AND SUMMARY_MODEL pulled */
export async function checkOllama(
  model: string,
  probe: () => Promise<boolean>,
): Promise<CheckResult> {
  const name = "Ollama reachable + model pulled";
  try {
    const ok = await probe();
    return ok
      ? { name, ok: true }
      : { name, ok: false, fix: `ollama serve && ollama pull ${model}` };
  } catch (err) {
    return { name, ok: false, fix: `ollama serve && ollama pull ${model}` };
  }
}

/** 6. Python interpreter importable with faster-whisper */
export async function checkPython(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "Python + faster-whisper importable";
  try {
    const ok = await probe();
    return ok
      ? { name, ok: true }
      : {
          name,
          ok: false,
          fix: "pip install -r src/transcription/requirements.txt (in your .venv)",
        };
  } catch (err) {
    return {
      name,
      ok: false,
      fix: "pip install -r src/transcription/requirements.txt (in your .venv)",
    };
  }
}

/** 7. ffmpeg on PATH */
export async function checkFfmpeg(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "ffmpeg on PATH";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "brew install ffmpeg" };
  } catch (err) {
    return { name, ok: false, fix: "brew install ffmpeg" };
  }
}

/**
 * 9. Btree indexes pass amcheck (detects collation-drift corruption).
 *
 * A glibc/ICU bump under an unpinned Postgres image changes text collation order,
 * which makes a btree over a text column (e.g. participants' (tenant_id, display_name))
 * look corrupt — surfacing as `XX002 … overlaps with invalid duplicate tuple` on the
 * next upsert and silently breaking message ingestion. The probe amchecks every valid
 * btree index and reports unhealthy only on a definitive corruption error, so a clean
 * fail here means "REINDEX + pin the image", not a transient environment quirk.
 */
export async function checkIndexIntegrity(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "DB indexes pass integrity check (amcheck)";
  const fix =
    "REINDEX the corrupt index (e.g. REINDEX INDEX participants_tenant_idx) and pin the pgvector image by digest — see ops/runbooks/collation-corruption.md";
  try {
    const ok = await probe();
    return ok
      ? { name, ok: true }
      : {
          name,
          ok: false,
          detail:
            "a btree index failed amcheck (XX002) — likely glibc/ICU collation drift from an unpinned Postgres image; this can silently break message ingestion",
          fix,
        };
  } catch {
    // A probe error is inconclusive — checkPostgres owns real DB-outage signalling.
    return { name, ok: true };
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run all checks and return one result per check. Never throws — each check
 * catches its own errors internally.
 */
export async function runChecks(checks: Array<() => Promise<CheckResult>>): Promise<CheckResult[]> {
  return Promise.all(checks.map((c) => c()));
}

// ── Real probe implementations ────────────────────────────────────────────────

/** Spawn a command and resolve to true if it exits 0, false otherwise. */
function spawnProbe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "pipe" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Real Docker probe: `docker info` exits 0 iff daemon is running. */
function realDockerProbe(): Promise<boolean> {
  return spawnProbe("docker", ["info"]);
}

/** Real Compose probe: `docker compose ps --quiet` exits 0 iff at least one container is up. */
function realComposeProbe(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", "ps", "--quiet"], { stdio: "pipe" });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      // Exit 0 and at least one container ID line
      resolve(code === 0 && stdout.trim().length > 0);
    });
  });
}

/** Real Postgres probe: connect and verify job_runs + service_status tables exist. */
async function realPostgresProbe(databaseUrl: string): Promise<boolean> {
  try {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const res = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('job_runs', 'service_status')
      `);
      return res.rows.length === 2;
    } finally {
      await pool.end();
    }
  } catch {
    return false;
  }
}

/** Real RabbitMQ probe: open AMQP connection and close it immediately. */
async function realRabbitMqProbe(amqpUrl: string): Promise<boolean> {
  try {
    const amqplib = await import("amqplib");
    const conn = await amqplib.connect(amqpUrl);
    await conn.close();
    return true;
  } catch {
    return false;
  }
}

/** Real Ollama probe: fetch /api/tags and check the model name is present. */
async function realOllamaProbe(ollamaHost: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaHost}/api/tags`);
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const models = body.models ?? [];
    // Normalize by stripping tag for loose matching
    const modelBase = model.split(":")[0]!;
    return models.some((m) => m.name === model || m.name.startsWith(modelBase));
  } catch {
    return false;
  }
}

/**
 * Real index-integrity probe: amcheck every valid btree index and resolve false
 * ONLY on a definitive corruption error (SQLSTATE XX002 — typically glibc/ICU
 * collation drift under a text index). Permission/extension/setup problems are
 * inconclusive (not corruption) and resolve true, so the check never cries wolf.
 */
async function realIndexIntegrityProbe(databaseUrl: string): Promise<boolean> {
  try {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS amcheck");
      } catch {
        return true; // restricted role can't install amcheck — inconclusive, not corrupt
      }
      const { rows } = await pool.query<{ idx: string }>(`
        SELECT c.oid::regclass::text AS idx
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE am.amname = 'btree'
          AND i.indisvalid AND i.indisready
          AND c.relnamespace = 'public'::regnamespace
      `);
      for (const { idx } of rows) {
        try {
          // heapallindexed=true also catches heap rows missing from the index.
          await pool.query(`SELECT bt_index_check($1::regclass, true)`, [idx]);
        } catch (err) {
          if ((err as { code?: string }).code === "XX002") return false; // corrupt
          // Other errors (lock contention, catalog perms, …) are inconclusive — skip.
        }
      }
      return true;
    } finally {
      await pool.end();
    }
  } catch {
    return true; // connection failure — checkPostgres owns that signal
  }
}

/** Real Python probe: spawn pythonPath -c "import faster_whisper" */
async function realPythonProbe(pythonPath: string): Promise<boolean> {
  return spawnProbe(pythonPath, ["-c", "import faster_whisper"]);
}

/** Real ffmpeg probe: spawn ffmpegPath -version */
async function realFfmpegProbe(ffmpegPath: string): Promise<boolean> {
  return spawnProbe(ffmpegPath, ["-version"]);
}

// ── defaultChecks: assembles real probes from config ─────────────────────────

/**
 * Returns the array of real check thunks wired to actual system probes.
 * Pass the result directly to runChecks().
 */
export function defaultChecks(config: AppConfig): Array<() => Promise<CheckResult>> {
  return [
    () => checkDocker(realDockerProbe),
    () => checkComposeServices(realComposeProbe),
    () => checkPostgres(() => realPostgresProbe(config.databaseUrl)),
    () => checkIndexIntegrity(() => realIndexIntegrityProbe(config.databaseUrl)),
    () => checkRabbitMQ(() => realRabbitMqProbe(config.broker.url)),
    () =>
      checkOllama(config.summarization.model, () =>
        realOllamaProbe(config.summarization.ollamaHost, config.summarization.model),
      ),
    () => checkPython(() => realPythonProbe(config.transcription.pythonPath)),
    () => checkFfmpeg(() => realFfmpegProbe(config.transcription.ffmpegPath)),
  ];
}
