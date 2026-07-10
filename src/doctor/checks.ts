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

// ── Check entry + runner ──────────────────────────────────────────────────────

/**
 * One doctor check as data: a name, a remediation `fix` hint, and an async
 * `probe` that resolves true when healthy. Two optional knobs capture the only
 * real variation across checks:
 *  - `detail`: extra context surfaced on a non-ok result (never on ok).
 *  - `onProbeError`: what a *probe throw* means. "fail" (default) → not-ok;
 *    "pass" → ok — the probe couldn't reach a verdict and another check owns the
 *    real signal (e.g. index-integrity defers DB-outage to the Postgres check).
 */
export type CheckEntry = {
  name: string;
  fix: string;
  detail?: string;
  onProbeError?: "fail" | "pass";
  probe: () => Promise<boolean>;
};

/**
 * Run one check entry. Never throws: a probe rejection becomes a not-ok result
 * (or an ok result when `onProbeError` is "pass"). A definitive false is always
 * a failure regardless of `onProbeError` — that flag only governs *throws*.
 */
export async function runCheck(entry: CheckEntry): Promise<CheckResult> {
  const { name } = entry;
  let healthy: boolean;
  try {
    healthy = await entry.probe();
  } catch {
    if (entry.onProbeError === "pass") return { name, ok: true };
    healthy = false;
  }
  if (healthy) return { name, ok: true };
  return entry.detail
    ? { name, ok: false, detail: entry.detail, fix: entry.fix }
    : { name, ok: false, fix: entry.fix };
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run all checks and return one result per check. Never throws — each check
 * catches its own errors internally (via runCheck).
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

// ── Check table → real probes ─────────────────────────────────────────────────

/**
 * The doctor check table: each row is one check wired to a real system probe.
 * Adding a check = one row here. Order is the display order. The Ollama `fix`
 * interpolates the configured model; index-integrity opts into the
 * inconclusive-probe policy (a probe throw is not treated as corruption — see
 * realIndexIntegrityProbe for why glibc/ICU collation drift is the real signal).
 */
export function checkEntries(config: AppConfig): CheckEntry[] {
  return [
    { name: "Docker running", fix: "start Docker Desktop", probe: realDockerProbe },
    { name: "Compose services up", fix: "docker compose up -d", probe: realComposeProbe },
    {
      name: "Postgres reachable + migrations applied",
      fix: "npm run migrate",
      probe: () => realPostgresProbe(config.databaseUrl),
    },
    {
      name: "DB indexes pass integrity check (amcheck)",
      fix: "REINDEX the corrupt index (e.g. REINDEX INDEX participants_tenant_idx) and pin the pgvector image by digest — see ops/runbooks/collation-corruption.md",
      detail:
        "a btree index failed amcheck (XX002) — likely glibc/ICU collation drift from an unpinned Postgres image; this can silently break message ingestion",
      onProbeError: "pass",
      probe: () => realIndexIntegrityProbe(config.databaseUrl),
    },
    {
      name: "RabbitMQ reachable",
      fix: "docker compose up -d rabbitmq",
      probe: () => realRabbitMqProbe(config.broker.url),
    },
    {
      name: "Ollama reachable + model pulled",
      fix: `ollama serve && ollama pull ${config.summarization.model}`,
      probe: () => realOllamaProbe(config.summarization.ollamaHost, config.summarization.model),
    },
    {
      name: "Python + faster-whisper importable",
      fix: "pip install -r src/transcription/requirements.txt (in your .venv)",
      probe: () => realPythonProbe(config.transcription.pythonPath),
    },
    {
      name: "ffmpeg on PATH",
      fix: "brew install ffmpeg",
      probe: () => realFfmpegProbe(config.transcription.ffmpegPath),
    },
  ];
}

/**
 * Returns the array of real check thunks wired to actual system probes.
 * Pass the result directly to runChecks().
 */
export function defaultChecks(config: AppConfig): Array<() => Promise<CheckResult>> {
  return checkEntries(config).map((entry) => () => runCheck(entry));
}
