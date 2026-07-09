import "dotenv/config";
import { startReconcileLoop } from "../collector/identity-reconcile-loop.js";
import { DEFAULT_TENANT_ID, runWithTenantContext } from "../db/tenant-context.js";
import type { JobBus } from "../jobs/job-bus.js";
import type { Job, JobType } from "../jobs/job-types.js";
import { installConsoleGuard } from "../logging/install-console.js";
import { logLifecycle } from "../logging/lifecycle.js";
import { getLogger } from "../logging/log.js";
import type { Logger } from "../logging/logger.js";
import { makeFairShareDispatcher } from "./fair-share.js";

export type HandlerMap = {
  [T in JobType]?: (job: Job<T>) => Promise<void>;
};

export type BuildWorkerOptions = {
  bus: JobBus;
  handlers: HandlerMap;
  concurrency: number;
  /** Optional logger; defaults to no-op so tests produce no output. */
  logger?: Logger;
  /**
   * T3 fair-share: when set, slow (PREFETCH_ONE) job types consume with THIS prefetch
   * and run through a per-type round-robin-by-tenant dispatcher, so one tenant's
   * backlog cannot starve another's single job. Unset (single-user mode) = exact
   * pre-T3 behavior.
   */
  fairShareWindow?: number;
  /**
   * Cross-tenant check that a job's tenant still exists. When provided and it
   * returns false for a non-default tenant, the job is acked and dropped instead
   * of run — so a stale job for a hard-deleted tenant can't wedge the worker in a
   * poison-loop against the `tenant_id` foreign keys. Omitted (tests / single-user)
   * = no check, exact prior behavior.
   */
  tenantExists?: (tenantId: string) => Promise<boolean>;
};

/** A no-op logger used in tests so worker test output stays clean. */
const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
  level: "silent",
  silent: () => {},
  isLevelEnabled: () => false,
} as unknown as Logger;

/**
 * Job types that must always use prefetch=1 for backpressure (slow jobs).
 * Transcription, vision analysis, and group summarization are GPU/LLM-bound
 * and can take seconds to minutes per item, so we never pre-fetch more than
 * one at a time regardless of --concurrency.
 */
const PREFETCH_ONE_TYPES = new Set<JobType>([
  "transcribe.voicenote",
  "analyze.image",
  "analyze.video",
  "summarize.group",
  "summarize.total",
]);

/**
 * Job types that call Ollama directly (LLM or vision model).
 * These share a single serialization gate so they never send concurrent
 * requests to Ollama — concurrent requests force a model-swap that can
 * exceed the socket timeout and trigger RabbitMQ consumer_timeout.
 * transcribe.voicenote is excluded (uses faster-whisper, not Ollama).
 */
const OLLAMA_JOB_TYPES = new Set<JobType>([
  "analyze.image",
  "analyze.video",
  "summarize.group",
  "summarize.total",
]);

/**
 * Normalize a job type to a coarse operation label for metrics/dashboards.
 * (Summaries log op="summary" from the web server; not a worker job.)
 */
export function opForJobType(type: JobType): string {
  switch (type) {
    case "transcribe.voicenote":
      return "audio";
    case "analyze.image":
      return "image";
    case "analyze.video":
      return "video";
    case "import.file":
      return "import";
    case "summarize.group":
      return "summary";
    case "summarize.total":
      return "summary";
    default:
      return type;
  }
}

/**
 * Testable worker wiring: registers each handler in the map via bus.consume.
 *
 * Prefetch policy:
 * - `transcribe.voicenote` → always prefetch=1 (slow, CPU/GPU-bound)
 * - all other types → prefetch=concurrency (from --concurrency / config)
 *
 * Returns a close function for graceful shutdown.
 * The returned promise rejects if any consumer registration fails at startup.
 */
export async function buildWorker(
  opts: BuildWorkerOptions,
): Promise<{ close: () => Promise<void> }> {
  const { bus, handlers, concurrency } = opts;
  const log = opts.logger ?? noopLogger;

  // Shared Ollama serialization gate: only one OLLAMA_JOB_TYPES job runs at a time.
  // Prevents concurrent model-swap timeouts and the resulting RabbitMQ consumer_timeout.
  // ponytail: process-local — serializes this worker's prefetch fan-out (the real
  // source of the timeouts). Multiple worker processes each hold their own gate; add a
  // distributed lock only if we ever run >1 worker against one Ollama.
  let _ollamaTail: Promise<void> = Promise.resolve();
  const withOllamaSlot = (fn: () => Promise<void>): Promise<void> => {
    const result = _ollamaTail.then(fn);
    _ollamaTail = result.then(
      () => {},
      () => {},
    ); // keep chain alive on error
    return result;
  };

  // Collect all consume() promises so a failed registration surfaces loudly.
  const registerPromises: Promise<void>[] = [];

  // Register each handler type with correlated per-job logging
  for (const [type, handler] of Object.entries(handlers) as Array<
    [JobType, (job: Job) => Promise<void>]
  >) {
    if (handler) {
      const isSlow = PREFETCH_ONE_TYPES.has(type);
      const prefetch = isSlow ? (opts.fairShareWindow ?? 1) : concurrency;

      // Tenant context is established here — at EXECUTION time — so a job parked in a
      // fair-share lane still runs under its own tenant, not the dispatcher caller's.
      const runInTenant = async (job: Job): Promise<void> => {
        const p = job.payload as Record<string, unknown>;
        const t = typeof p["tenantId"] === "string" ? (p["tenantId"] as string) : DEFAULT_TENANT_ID;
        // Drop (ack) jobs whose tenant was hard-deleted — otherwise they fail the
        // tenant_id foreign key forever and poison-loop. Only checked for non-default
        // tenants (the default always exists) and only when a checker is wired.
        if (t !== DEFAULT_TENANT_ID && opts.tenantExists && !(await opts.tenantExists(t))) {
          log.warn(
            { tenantId: t, jobType: job.type, jobId: job.id },
            "skipping job for a tenant that no longer exists (acked, dropped)",
          );
          return;
        }
        return runWithTenantContext(t, () => handler(job));
      };
      const fairShareOrDirect =
        isSlow && opts.fairShareWindow ? makeFairShareDispatcher(runInTenant) : runInTenant;
      const execute = OLLAMA_JOB_TYPES.has(type)
        ? (job: Job) => withOllamaSlot(() => fairShareOrDirect(job))
        : fairShareOrDirect;

      const wrappedHandler = async (job: Job): Promise<void> => {
        // Build correlation context: common fields + payload-specific ids
        const payload = job.payload as Record<string, unknown>;
        const ctx: Record<string, unknown> = {
          jobId: job.id,
          jobType: job.type,
        };
        if (typeof payload["messageId"] === "string") ctx["messageId"] = payload["messageId"];
        if (typeof payload["filePath"] === "string") ctx["filePath"] = payload["filePath"];

        // T2: each job runs inside its tenant's context (see runInTenant above —
        // jobs enqueued before T2 carry no tenantId → default tenant).
        const tenantId =
          typeof payload["tenantId"] === "string" ? payload["tenantId"] : DEFAULT_TENANT_ID;
        ctx["tenantId"] = tenantId;

        const child = log.child(ctx);
        child.info("job received");
        const startedAt = Date.now();
        const op = opForJobType(job.type);
        try {
          await execute(job);
          child.info({ durationMs: Date.now() - startedAt, op }, "job done");
        } catch (err) {
          child.error({ err, durationMs: Date.now() - startedAt, op }, "job failed");
          throw err; // rethrow so the bus can retry / dead-letter
        }
      };

      registerPromises.push(
        bus.consume(type, wrappedHandler as (job: Job<typeof type>) => Promise<void>, { prefetch }),
      );
    }
  }

  // Await all registrations: a failed consumer surfaces loudly instead of being swallowed.
  await Promise.all(registerPromises);

  return {
    close: () => bus.close(),
  };
}

// ── Production entrypoint ────────────────────────────────────────────────────

/**
 * main() wires production dependencies and starts consuming the requested
 * job types (passed via --types).
 */
async function main(): Promise<void> {
  // Route every console.* line (incl. third-party dumps) through pino with a
  // timestamp + source, and drop/redact secret material — before anything logs.
  installConsoleGuard();
  logLifecycle("boot", { proc: "worker" });
  const [
    { loadConfig },
    { RabbitMqJobBus },
    { PostgresJobRunRecorder },
    { createDbClient },
    { makeImportFileHandler },
    { makeTranscribeVoicenoteHandler },
    { makeAnalyzeMediaHandler },
    { listUntranscribedVoiceNoteIdsByGroup, hasTranscript },
    { hasAnalysis, getVisualMediaPath, insertMediaAnalysis },
    { runImport },
    { transcribeOneNote },
    { analyzeMediaOne, normalizeImageWithFfmpeg },
    { analyzeVideo, extractFramesWithFfmpeg, extractAudioWithFfmpeg, fileSizeMbSync },
    { OllamaVisionAnalyzer },
    { IvritWhisperTranscriber },
    { pruneMediaFile },
    { resetStaleRunningJobs },
    { scopedPool, currentTenantId },
  ] = await Promise.all([
    import("../config.js"),
    import("../jobs/rabbitmq-bus.js"),
    import("../jobs/job-run-recorder.js"),
    import("../db/client.js"),
    import("./handlers/import-file.js"),
    import("./handlers/transcribe-voicenote.js"),
    import("./handlers/analyze-media.js"),
    import("../db/repositories/transcripts.js"),
    import("../db/repositories/media-analyses.js"),
    import("../importer/run-import.js"),
    import("../transcription/run.js"),
    import("../vision/run.js"),
    import("../vision/analyze-video.js"),
    import("../vision/ollama-analyzer.js"),
    import("../transcription/ivrit-whisper.js"),
    import("../media/prune.js"),
    import("../db/repositories/job-runs.js"),
    import("../db/tenant-context.js"),
  ]);

  // Parse CLI args
  const args = process.argv.slice(2);
  const typesIdx = args.indexOf("--types");
  const concurrencyIdx = args.indexOf("--concurrency");

  const config = loadConfig();
  const logger = getLogger("worker");
  const concurrency =
    concurrencyIdx !== -1 ? Number(args[concurrencyIdx + 1]) : config.worker.concurrency;

  // Admin pool: migrations-grade maintenance + job-run recording only. Cross-tenant by
  // design (stale-job reset spans tenants; job_runs rows auto-attribute via the GUC
  // default — to the job's tenant when recorded in context, else the default tenant).
  const dbClient = createDbClient();
  const recorder = new PostgresJobRunRecorder(dbClient);

  const bus = new RabbitMqJobBus({
    url: config.broker.url,
    recorder,
  });

  // T2 cutover: ALL handler data access runs on the RLS-enforced catchapp_app pool,
  // scoped per query to the active job's tenant (carried by AsyncLocalStorage — see
  // buildWorker). Isolation is enforced by Postgres, not by handler discipline.
  const { createAppPool } = await import("../db/client.js");
  const appPool = createAppPool();
  const pool = scopedPool(appPool, currentTenantId);

  // On startup, reset any orphaned 'running' rows from a previous crash/restart.
  // Admin connection: this maintenance legitimately spans all tenants.
  const staleReset = await resetStaleRunningJobs(dbClient);
  if (staleReset > 0) {
    logger.warn(
      { staleReset },
      `Reset ${staleReset} stale 'running' job(s) to 'failed' on startup.`,
    );
  }

  const importFileHandler = makeImportFileHandler({
    runImport,
    listUntranscribed: async (result) => {
      return listUntranscribedVoiceNoteIdsByGroup(pool, result.groupName);
    },
    bus,
  });

  // Determine which types to register
  const requestedTypes: string[] =
    typesIdx !== -1 ? args[typesIdx + 1].split(",") : ["import.file"];

  const handlers: HandlerMap = {};
  if (requestedTypes.includes("import.file")) {
    handlers["import.file"] = importFileHandler;
  }
  if (requestedTypes.includes("transcribe.voicenote")) {
    const transcribeVoicenoteHandler = makeTranscribeVoicenoteHandler({
      isAlreadyTranscribed: (messageId) => hasTranscript(pool, messageId),
      transcribeOne: (messageId) =>
        transcribeOneNote(messageId, {
          pool, // tenant-scoped app pool (T2) — instead of a private owner pool
          databaseUrl: config.databaseUrl,
          transcriber: new IvritWhisperTranscriber({
            pythonPath: config.transcription.pythonPath,
            model: config.transcription.model,
            ffmpegPath: config.transcription.ffmpegPath,
          }),
          engine: config.transcription.model,
          ffmpegPath: config.transcription.ffmpegPath,
          convert: true,
          retainMedia: config.retainMedia,
          pruneMediaFile: (id) =>
            pruneMediaFile(pool, Number(id), { retainMedia: config.retainMedia }),
        }),
    });
    handlers["transcribe.voicenote"] = transcribeVoicenoteHandler;
  }
  if (requestedTypes.includes("analyze.image") || requestedTypes.includes("analyze.video")) {
    const ollamaAnalyzer = new OllamaVisionAnalyzer({
      host: config.summarization.ollamaHost,
      model: config.vision.model,
      numCtx: config.vision.numCtx,
    });
    // Video may use a different model (e.g. Gemma 4 multimodal) than image analysis.
    const videoAnalyzer =
      config.vision.videoModel === config.vision.model
        ? ollamaAnalyzer
        : new OllamaVisionAnalyzer({
            host: config.summarization.ollamaHost,
            model: config.vision.videoModel,
            numCtx: config.vision.numCtx,
          });
    const ffmpegPath = config.transcription.ffmpegPath;

    // Build a shared transcriber for video audio extraction.
    // open()/close() are called per analyzeVideo invocation via the injected function.
    const buildTranscribeAudio =
      () =>
      async (audioPath: string): Promise<string> => {
        const transcriber = new IvritWhisperTranscriber({
          pythonPath: config.transcription.pythonPath,
          model: config.transcription.model,
          ffmpegPath,
        });
        await transcriber.open();
        try {
          const { text } = await transcriber.transcribe(audioPath);
          return text;
        } finally {
          await transcriber.close();
        }
      };

    const analyzeMediaHandler = makeAnalyzeMediaHandler({
      hasAnalysis: (messageId) => hasAnalysis(pool, messageId),
      analyzeOne: (messageId, kind) =>
        analyzeMediaOne(messageId, kind, {
          pool,
          getVisualMediaPath: (id) => getVisualMediaPath(pool, id),
          visionAnalyzer: ollamaAnalyzer,
          normalizeImage: (imagePath) => normalizeImageWithFfmpeg(ffmpegPath, imagePath),
          insertMediaAnalysis: (input) => insertMediaAnalysis(pool, input),
          engineLabel: config.vision.model,
          // Video deps
          analyzeVideo: (input) =>
            analyzeVideo(
              {
                visionAnalyzer: videoAnalyzer,
                transcribeAudio: buildTranscribeAudio(),
                extractFrames: async (videoPath) => {
                  const { frames, dir } = await extractFramesWithFfmpeg(ffmpegPath, videoPath, {
                    fps: config.vision.videoFps,
                    maxFrames: config.vision.videoMaxFrames,
                  });
                  return { frames, dir };
                },
                extractAudio: (videoPath) => extractAudioWithFfmpeg(ffmpegPath, videoPath),
                maxVideoMb: config.vision.maxVideoMb,
                fileSizeMb: fileSizeMbSync,
              },
              input,
            ),
          getThumbnailPath: (_messageId) => Promise.resolve(null),
          retainMedia: config.retainMedia,
          pruneMediaFile: (id) => pruneMediaFile(pool, id, { retainMedia: config.retainMedia }),
        }),
    });

    if (requestedTypes.includes("analyze.image")) {
      handlers["analyze.image"] = (job) => analyzeMediaHandler(job, "analyze.image");
    }
    if (requestedTypes.includes("analyze.video")) {
      handlers["analyze.video"] = (job) => analyzeMediaHandler(job, "analyze.video");
    }
  }

  // summarize.group — handler wired in next phase (T009: topology registered here).
  // The job type, queues (jobs.summarize.group + .dead), and PREFETCH_ONE policy
  // are registered; the full handler implementation follows in the job-handler phase.
  if (requestedTypes.includes("summarize.group")) {
    const { makeSummarizeGroupHandler } = await import("./handlers/summarize-group.js");
    const { prepareSumbox } = await import("../summarization/prepare-sumbox.js");
    const { insertSummary } = await import("../db/repositories/summaries.js");
    const { upsertWatermark } = await import("../db/repositories/read-watermarks.js");
    const { OllamaSummarizer } = await import("../summarization/summarizer.js");
    const ollamaSummarizer = new OllamaSummarizer({
      host: config.summarization.ollamaHost,
      model: config.summarization.model,
      numCtx: config.summarization.numCtx,
      temperature: config.summarization.temperature,
      repeatPenalty: config.summarization.repeatPenalty,
      numPredict: config.summarization.numPredict,
    });
    handlers["summarize.group"] = makeSummarizeGroupHandler({
      pool,
      prepareSumbox,
      summarize: async (prompt) => {
        const result = await ollamaSummarizer.summarize(prompt);
        return result.overview;
      },
      insertSummary,
      updateWatermark: upsertWatermark,
      model: config.summarization.model,
      tokenBudget: config.summarization.tokenBudget,
    });
  }

  if (requestedTypes.includes("summarize.total")) {
    const { makeSummarizeTotalHandler } = await import("./handlers/summarize-total.js");
    const { generateTotalSummary } = await import("../summarization/total-summary.js");
    const { insertTotalSummary } = await import("../db/repositories/total-summaries.js");
    const { OllamaSummarizer } = await import("../summarization/summarizer.js");
    const totalSummarizer = new OllamaSummarizer({
      host: config.summarization.ollamaHost,
      model: config.summarization.model,
      numCtx: config.summarization.numCtx,
      temperature: config.summarization.temperature,
      repeatPenalty: config.summarization.repeatPenalty,
      numPredict: config.summarization.numPredict,
    });
    handlers["summarize.total"] = makeSummarizeTotalHandler({
      pool,
      generateTotalSummary: (range) =>
        generateTotalSummary(
          {
            pool,
            summarizeStream: (prompt, o) => totalSummarizer.summarizeStream(prompt, o),
            tokenBudget: config.summarization.tokenBudget,
          },
          range,
        ),
      insertTotalSummary,
      model: config.summarization.model,
    });
  }

  const worker = await buildWorker({
    bus,
    handlers,
    concurrency,
    logger,
    // Cross-tenant existence check on the admin (owner) pool — drops stale jobs
    // whose tenant was hard-deleted instead of poison-looping the FK.
    tenantExists: async (tenantId) => {
      const { rows } = await dbClient.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId]);
      return rows.length > 0;
    },
  });

  // Periodically reconcile lid/phone duplicate chats from the durable identity
  // map (session-independent; runs once now, then hourly). Uses the REAL appPool
  // (not the per-query scopedPool, which has no connect()) — reconcileIdentities
  // opens its own withTenant transaction, setting the tenant GUC under RLS.
  const reconcile = startReconcileLoop({
    pool: appPool,
    tenantId: DEFAULT_TENANT_ID,
    intervalMs: 60 * 60 * 1000,
    onError: (err) => logger.warn({ err }, "identity reconcile tick failed"),
  });

  // Graceful shutdown (both SIGINT and SIGTERM)
  let shuttingDown = false;
  const gracefulShutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    reconcile.stop();
    logLifecycle("shutdown", { proc: "worker", signal });
    void worker.close().then(() => {
      void appPool.end();
      void dbClient.end();
      // Flush the shutdown event before exiting, with a safety timeout.
      const exit = () => process.exit(0);
      try {
        logger.flush(exit);
      } catch {
        exit();
      }
      setTimeout(exit, 1000).unref();
    });
  };
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  logger.info(
    { concurrency, types: Object.keys(handlers) },
    `Worker started (concurrency=${concurrency}, types=${Object.keys(handlers).join(",")})`,
  );
  logLifecycle("ready", { proc: "worker", concurrency });
}

// Only run main when this file is the entrypoint
if (
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("worker.ts") || process.argv[1].endsWith("worker.js"))
) {
  main().catch((err) => {
    console.error("[worker] fatal error:", err);
    process.exit(1);
  });
}
