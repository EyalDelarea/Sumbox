#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import "dotenv/config";
import { loadConfig } from "./config.js";
import { runImport } from "./importer/run-import.js";
import type { JobBus } from "./jobs/job-bus.js";
import { installConsoleGuard } from "./logging/install-console.js";
import { logLifecycle } from "./logging/lifecycle.js";
import { getBaseLogger, getLogger } from "./logging/log.js";

const program = new Command();

program
  .name("sumbox")
  .description("Local-first WhatsApp export importer and summarizer")
  .version("0.1.0");

program
  .command("import")
  .description(
    "Import a WhatsApp export. Single-file: import <path> --name <name>. Bulk: import --folder <dir>",
  )
  .argument("[path]", "Path to exported WhatsApp chat file (.txt or .zip)")
  .option("--name <name>", "Group or chat display name (required for single-file mode)")
  .option("--folder <dir>", "Folder to scan for .txt/.zip exports and enqueue as background jobs")
  .action(async (filePath: string | undefined, options: { name?: string; folder?: string }) => {
    const { folder, name } = options;

    // ── --folder mode ─────────────────────────────────────────────────────
    if (folder !== undefined) {
      // Mutual exclusion: --folder cannot be combined with <path> or --name
      if (filePath !== undefined) {
        process.stderr.write(
          "Error: --folder and a positional <path> are mutually exclusive. Use one or the other.\n",
        );
        process.exit(1);
      }
      if (name !== undefined) {
        process.stderr.write(
          "Error: --folder and --name are mutually exclusive. --name is only for single-file mode.\n",
        );
        process.exit(1);
      }

      // Validate directory exists
      if (!fs.existsSync(folder)) {
        process.stderr.write(`Error: Folder not found: ${folder}\n`);
        process.exit(1);
      }
      if (!fs.statSync(folder).isDirectory()) {
        process.stderr.write(`Error: Not a directory: ${folder}\n`);
        process.exit(1);
      }

      try {
        const { enqueueFolder } = await import("./importer/bulk-import.js");

        // Test-only seam: an in-memory bus discards jobs when the process
        // exits, so it is gated on NODE_ENV=test and can NEVER be activated
        // in production (where it would silently swallow enqueued jobs).
        let bus: JobBus;
        // The RabbitMQ bus records job runs through a Postgres pool; the in-memory
        // test bus has none. Track it so it is closed after the bus — the in-memory
        // branch leaves it null (nothing to end). This is the ONE place that keeps a
        // non-Rabbit bus (the NODE_ENV=test seam), so it stays outside withJobInfra.
        let recorderPool: import("pg").Pool | null = null;
        if (process.env["USE_IN_MEMORY_BUS"] === "1" && process.env["NODE_ENV"] === "test") {
          const { InMemoryJobBus } = await import("./jobs/in-memory-bus.js");
          const { InMemoryJobRunRecorder } = await import("./jobs/job-run-recorder.js");
          bus = new InMemoryJobBus(new InMemoryJobRunRecorder());
        } else {
          const { RabbitMqJobBus } = await import("./jobs/rabbitmq-bus.js");
          const { PostgresJobRunRecorder } = await import("./jobs/job-run-recorder.js");
          const { createDbClient } = await import("./db/client.js");
          const config = loadConfig();
          recorderPool = createDbClient();
          const recorder = new PostgresJobRunRecorder(recorderPool);
          bus = new RabbitMqJobBus({ url: config.broker.url, recorder });
        }

        const result = await enqueueFolder(bus, folder);
        console.log(`Enqueued ${result.enqueued} import jobs.`);
        await bus.close();
        if (recorderPool) await recorderPool.end();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: Failed to enqueue folder: ${message}\n`);
        process.exit(1);
      }
      return;
    }

    // ── Single-file mode (original behaviour, unchanged) ──────────────────
    if (filePath === undefined) {
      process.stderr.write(
        "Error: A file path is required in single-file mode. Use import <path> --name <name>.\n",
      );
      process.exit(1);
    }

    if (name === undefined) {
      process.stderr.write("Error: --name <name> is required in single-file mode.\n");
      process.exit(1);
    }

    // T018 — error: missing file
    if (!fs.existsSync(filePath)) {
      process.stderr.write(`Error: File not found: ${filePath}\n`);
      process.exit(1);
    }

    // T018 — error: unsupported extension
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".txt" && ext !== ".zip") {
      process.stderr.write(
        `Error: Unsupported file type "${ext}". Only .txt and .zip exports are supported.\n`,
      );
      process.exit(1);
    }

    try {
      const result = await runImport({ filePath, name });
      // Contract output: Imported "<name>": <inserted> new, <skipped> duplicate, <media> media files.
      console.log(
        `Imported "${result.groupName}": ${result.inserted} new, ${result.skipped} duplicate, ${result.mediaFiles} media files.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: Import failed: ${message}\n`);
      process.exit(1);
    }
  });

program
  .command("collect")
  .description("Start live WhatsApp message collection (links via QR code on first run)")
  .action(async () => {
    installConsoleGuard();
    logLifecycle("boot", { proc: "collect" });
    const collectorLog = getLogger("collector");
    const nameResolverLog = getLogger("name-resolver");
    const config = loadConfig();
    const authDir = path.join(config.dataDir, "baileys-auth");

    // Import lazily to avoid loading Baileys at startup for non-collect commands.
    const [
      { startSession },
      { attachCollector },
      { RabbitMqJobBus },
      { PostgresJobRunRecorder },
      { createDbClient },
      { setCollectorConnected },
      { makeSummaryCommandDeps },
      { resolveAllGroupNames },
    ] = await Promise.all([
      import("./collector/session.js"),
      import("./service/live-service.js"),
      import("./jobs/rabbitmq-bus.js"),
      import("./jobs/job-run-recorder.js"),
      import("./db/client.js"),
      import("./db/repositories/service-status.js"),
      import("./serve/summary-command-deps.js"),
      import("./collector/name-resolver.js"),
    ]);

    // ONE pool serves the collector, the job-run recorder, and the /סיכום command.
    const pool = createDbClient();
    // The job bus makes captured media transcribable/analyzable in real time —
    // the same enqueue path `serve --collect` uses. `collect` previously had no
    // bus, so its downloaded media was stored but never enqueued (split-dev
    // parity gap). See issue #5.
    const bus = new RabbitMqJobBus({
      url: config.broker.url,
      recorder: new PostgresJobRunRecorder(pool),
    });

    // The /סיכום command's runtime deps. resolveEnabledJids/resolveTrigger read
    // group_command_permissions / user_preferences LIVE, per message — this
    // standalone collector is its own process (split dev), so it has no reload
    // channel from a separate `serve` UI process; reading the DB per message is
    // what makes a toggle in that other process take effect here immediately,
    // with no restart.
    const cmdDeps = makeSummaryCommandDeps(pool, collectorLog);

    // SAFETY BANNER — make the outbound posture unmistakable before linking.
    if (config.whatsapp.allowSend) {
      collectorLog.warn(
        "⚠️  SENDING ENABLED (WHATSAPP_ALLOW_SEND=true): this tool may transmit to WhatsApp.",
      );
    } else {
      collectorLog.info(
        "🔒 Read-only mode: passive observer — will NOT send messages, read receipts, or presence (set WHATSAPP_ALLOW_SEND=true to enable). /סיכום replies still send to groups enabled in group_command_permissions — toggling one on or off takes effect on the next message, no restart.",
      );
    }

    // The outbound guard reads the SAME live DB resolver the matcher uses, per
    // send — never a startup snapshot — so a group toggled on or off in the UI
    // takes effect on the very next message, with no restart.
    const session = await startSession(authDir, config.whatsapp.allowSend, {
      allowlist: cmdDeps.resolveEnabledJids,
    });

    session.on("qr", () => {
      process.stdout.write("Scan the QR code above with WhatsApp to link your account.\n");
    });

    // The collector lifecycle — connect/disconnect status, the 30s heartbeat with
    // reconnect de-dup, per-message crash isolation, media download + job enqueue,
    // and the /סיכום command — is the SAME wiring `serve --collect` uses. Route
    // through attachCollector instead of re-hand-coding it; collect's two connect-
    // time extras (proactive name resolution + a "collecting" log) ride onConnected.
    const handle = attachCollector({
      session,
      pool,
      bus,
      dataDir: config.dataDir,
      log: collectorLog,
      onError: (err) => collectorLog.warn({ err }, "collector message handler error"),
      summaryCommand: cmdDeps,
      onConnected: () => {
        collectorLog.info({ stored: 0 }, "collecting");
        logLifecycle("collector.connected");
        // Proactive name resolution: resolve quiet groups that have never sent a
        // new live message (fire-and-forget; must not block collection startup).
        void resolveAllGroupNames(pool, {
          groupSubject: (jid) => session.groupSubject(jid),
        })
          .then(({ resolved }) => {
            if (resolved > 0) {
              nameResolverLog.info({ resolved }, "resolved group name(s)");
            }
          })
          .catch((err: unknown) => {
            nameResolverLog.error({ err }, "group name resolution error");
          });
      },
    });

    // Graceful shutdown on Ctrl-C. handle.stop() latches teardown, stops the
    // heartbeat, session.stop()s, and fires a best-effort setConnected(false).
    process.on("SIGINT", () => {
      logLifecycle("shutdown", { proc: "collect", signal: "SIGINT" });
      handle.stop();
      collectorLog.info("stopping collector");
      // Await our own setConnected(false) so the shared row is flipped disconnected
      // BEFORE the pool closes (a separate serve UI reflects it immediately, not only
      // after the staleness window), then close the bus + pool and exit.
      void setCollectorConnected(pool, false)
        .catch(() => {})
        .finally(() => {
          void bus
            .close()
            .catch(() => {})
            .finally(() => {
              void pool
                .end()
                .catch(() => {})
                .finally(() => {
                  const exit = () => process.exit(0);
                  try {
                    getBaseLogger().flush(exit);
                  } catch {
                    exit();
                  }
                  setTimeout(exit, 1000).unref();
                });
            });
        });
    });
  });

program
  .command("groups")
  .description("List imported WhatsApp groups and chats")
  .action(async () => {
    const { listGroups } = await import("./db/repositories/groups.js");
    const { createDbClient } = await import("./db/client.js");
    const pool = createDbClient();
    try {
      const groups = await listGroups(pool);
      if (groups.length === 0) {
        console.log("No chats stored yet.");
        return;
      }
      groups.forEach((g, i) => {
        console.log(`${i + 1}. ${g.name} (${g.source}, ${g.messageCount} messages)`);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program
  .command("summarize")
  .description("Summarize an imported WhatsApp group or chat (runs locally via Ollama)")
  .argument("<name>", "Group or chat display name")
  .option("--last <count>", "Summarize the last N messages")
  .option("--since <date>", "Summarize messages since a date (YYYY-MM-DD)")
  .option("--out <file>", "Write the rendered summary to a file")
  .action(async (name: string, options: { last?: string; since?: string; out?: string }) => {
    // Arg validation (FR-023): exactly one of --last / --since; default --last 25.
    if (options.last !== undefined && options.since !== undefined) {
      process.stderr.write("Error: use only one of --last or --since.\n");
      process.exit(1);
    }
    let selection: { last: number } | { since: Date };
    if (options.since !== undefined) {
      const since = new Date(options.since);
      if (Number.isNaN(since.getTime())) {
        process.stderr.write(`Error: invalid --since date "${options.since}". Use YYYY-MM-DD.\n`);
        process.exit(1);
      }
      selection = { since };
    } else {
      const n = options.last !== undefined ? Number(options.last) : 25;
      if (!Number.isInteger(n) || n <= 0) {
        process.stderr.write(`Error: --last must be a positive integer (got "${options.last}").\n`);
        process.exit(1);
      }
      selection = { last: n };
    }

    const { runSummarize } = await import("./summarization/summarize.js");
    const { renderSummary } = await import("./summarization/render.js");
    try {
      const result = await runSummarize({ groupName: name, selection });
      if (result.kind === "empty") {
        console.log("Nothing to summarize for that selection.");
        return;
      }
      const text = renderSummary(result.output);
      if (options.out) {
        const fsp = await import("node:fs/promises");
        await fsp.writeFile(options.out, text + "\n", "utf8");
        console.log(`Saved summary to ${options.out}.`);
      } else {
        console.log(text);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
  });

program
  .command("transcribe")
  .description("Transcribe pending Hebrew voice notes locally (nothing leaves the machine)")
  .option("--group <name>", "Only transcribe voice notes in this group")
  .action(async (options: { group?: string }) => {
    // Lazy import keeps faster-whisper/spawn out of other commands' startup.
    const { runTranscription } = await import("./transcription/run.js");
    try {
      const result = await runTranscription({ groupName: options.group });
      console.log(
        `Transcribed ${result.ok}, failed ${result.failed}, skipped ${result.skipped} voice notes.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: Transcription failed: ${message}\n`);
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Start the local web UI for summarizing (stays on your machine)")
  .option("--port <port>", "Port to listen on")
  .option("--collect", "Also run the always-on live collector (links WhatsApp via QR on first run)")
  .action(async (options: { port?: string; collect?: boolean }) => {
    // Route every console.* line (incl. third-party dumps) through pino before any
    // log-capable code runs in this long-running process — must happen before the
    // bootstrap module graph (and its loggers) are imported.
    installConsoleGuard();
    const { startServe } = await import("./serve/bootstrap.js");
    await startServe(options);
  });

program
  .command("analyze-backlog")
  .description(
    "Enqueue analyze jobs for present visual media that have no completed analysis (includes failed rows)",
  )
  .option("--limit <n>", "Maximum number of messages to enqueue")
  .option("--types <list>", "Comma-separated job types to enqueue", "analyze.image,analyze.video")
  .action(async (options: { limit?: string; types?: string }) => {
    const limit = options.limit !== undefined ? Number(options.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      process.stderr.write(`Error: --limit must be a positive integer (got "${options.limit}").\n`);
      process.exit(1);
    }

    const allowedTypes = new Set(
      (options.types ?? "analyze.image,analyze.video").split(",").map((s) => s.trim()),
    );

    const [{ selectVisualMediaNeedingAnalysis }, { withJobInfra }] = await Promise.all([
      import("./db/repositories/media-analyses.js"),
      import("./jobs/with-job-infra.js"),
    ]);

    await withJobInfra(async ({ pool, bus }) => {
      try {
        const rows = await selectVisualMediaNeedingAnalysis(pool, limit);

        let enqueued = 0;
        for (const { messageId, kind } of rows) {
          const jobType = kind === "video" ? "analyze.video" : "analyze.image";
          if (!allowedTypes.has(jobType)) continue;
          await bus.enqueue(jobType, { messageId: String(messageId) });
          enqueued++;
        }

        console.log(`Enqueued ${enqueued} analyze job(s).`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: analyze-backlog failed: ${message}\n`);
        process.exit(1);
      }
    });
  });

program
  .command("media-backfill")
  .description(
    "Download + analyze media for messages stored without it (deferred backfill). Scans a fresh linked session.",
  )
  .option("--limit <n>", "Max messages to process", "50")
  .option(
    "--auth-dir <dir>",
    "Auth dir for the temporary device (default <dataDir>/baileys-fullsync-auth)",
  )
  .action(async (options: { limit?: string; authDir?: string }) => {
    const limit = Number(options.limit ?? "50");
    if (!Number.isInteger(limit) || limit <= 0) {
      process.stderr.write("Error: --limit must be a positive integer.\n");
      process.exit(1);
    }

    const config = loadConfig();
    const [
      { startSession },
      { runBackfillBatch, MEDIA_EXTENSIONS },
      { proto },
      mediaRepo,
      msgRepo,
      chatScopes,
      fsp,
      nodePath,
      { RabbitMqJobBus },
      { PostgresJobRunRecorder },
      { createDbClient },
    ] = await Promise.all([
      import("./collector/session.js"),
      import("./collector/media-backfill-loop.js"),
      import("@whiskeysockets/baileys"),
      import("./db/repositories/message-media.js"),
      import("./db/repositories/messages.js"),
      import("./db/repositories/chat-scopes.js"),
      import("node:fs/promises"),
      import("node:path"),
      import("./jobs/rabbitmq-bus.js"),
      import("./jobs/job-run-recorder.js"),
      import("./db/client.js"),
    ]);

    // One pool serves both the backfill queries and the job-run recorder.
    const pool = createDbClient();
    const recorder = new PostgresJobRunRecorder(pool);
    const bus = new RabbitMqJobBus({ url: config.broker.url, recorder });
    const authDir = options.authDir ?? path.join(config.dataDir, "baileys-fullsync-auth");
    const session = await startSession(authDir, false, {});

    let failed = false;
    try {
      session.on("qr", () => {
        console.log(
          "\n📲 Scan the QR above: WhatsApp → Settings → Linked Devices → Link a Device.\n",
        );
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error("timed out waiting for WhatsApp connection (scan the QR, or re-auth)"),
            ),
          120_000,
        );
        session.on("connected", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      const total = await runBackfillBatch(
        {
          selectPending: (l) => mediaRepo.selectPendingMedia(pool, l),
          decodeWaMessage: (blob) => proto.WebMessageInfo.decode(blob),
          download: (m) => session.downloadMedia(m as import("@whiskeysockets/baileys").WAMessage),
          writeFile: async (messageId, kind, bytes) => {
            const dir = nodePath.join(config.dataDir, "media", "backfill");
            await fsp.mkdir(dir, { recursive: true });
            const file = nodePath.join(dir, `bf-${messageId}${MEDIA_EXTENSIONS[kind] ?? ".bin"}`);
            await fsp.writeFile(file, bytes);
            return file;
          },
          markPresentMessage: (id, p) => msgRepo.markMessageMediaPresent(pool, id, p),
          markPresentMedia: (id, dp) => mediaRepo.markMediaPresent(pool, id, dp),
          markUnrecoverable: (id, e) => mediaRepo.markMediaUnrecoverable(pool, id, e),
          recordAttempt: (id, e) => mediaRepo.recordMediaAttempt(pool, id, e),
          sweepExpired: () => mediaRepo.markExpiredMediaUnrecoverable(pool),
          enqueue: async (type, payload) => {
            await bus.enqueue(type, payload);
          },
          isGroupIncluded: (gid) => chatScopes.isGroupIncluded(pool, gid),
          // One-shot CLI: surface every level on stdout for interactive feedback.
          log: {
            debug: (m) => void process.stdout.write(`${m}\n`),
            info: (m) => void process.stdout.write(`${m}\n`),
            warn: (m) => void process.stdout.write(`${m}\n`),
          },
        },
        limit,
      );

      console.log(`Backfilled ${total} media file(s); analysis jobs enqueued.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: media-backfill failed: ${message}\n`);
      failed = true;
    } finally {
      session.stop();
      await bus.close();
      await pool.end();
    }
    process.exit(failed ? 1 : 0);
  });

program
  .command("digest-run")
  .description(
    "Manually trigger a scheduled digest run: enqueue summarize.group jobs for all changed groups",
  )
  .option("--all", "Enqueue all groups regardless of whether they have new messages")
  .action(async (options: { all?: boolean }) => {
    const [{ enqueueScheduledRun }, { withJobInfra }] = await Promise.all([
      import("./scheduler/enqueue-run.js"),
      import("./jobs/with-job-infra.js"),
    ]);

    await withJobInfra(async ({ pool, bus }) => {
      try {
        const result = await enqueueScheduledRun(pool, bus, { all: options.all === true });
        console.log(`Enqueued ${result.enqueued} (skipped ${result.skipped})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: digest-run failed: ${message}\n`);
        process.exit(1);
      }
    });
  });

program
  .command("ops-sweep")
  .description("Manually trigger one ops sweep: re-drive dead jobs and record a status snapshot")
  .action(async () => {
    const [{ runOpsSweep }, { DEFAULT_STALENESS_MS }, { withJobInfra }] = await Promise.all([
      import("./ops/sweep.js"),
      import("./service/status.js"),
      import("./jobs/with-job-infra.js"),
    ]);

    await withJobInfra(async ({ pool, bus, config }) => {
      const getQueueDepths = async () => {
        const types = ["import.file", "transcribe.voicenote"] as const;
        const result: Record<string, number> = {};
        await Promise.all(
          types.map(async (type) => {
            try {
              result[type] = await bus.depth(type);
            } catch {
              // broker unreachable for this type — omit so depth stays null
            }
          }),
        );
        return result as Partial<Record<(typeof types)[number], number>>;
      };

      try {
        const snap = await runOpsSweep({
          pool,
          bus,
          getQueueDepths,
          stalenessMs: DEFAULT_STALENESS_MS,
          cap: config.opsSweep.redriveCap,
          logger: undefined,
          now: () => new Date(),
        });
        console.log(
          `Ops sweep complete: re-driven ${snap.redriven}, flagged ${snap.flagged}, dead ${snap.jobsDead} (snapshot ${snap.id}).`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ops-sweep failed: ${message}\n`);
        process.exit(1);
      }
    });
  });

program
  .command("doctor")
  .description("Check every prerequisite and print ✅/❌ per check with fix hints")
  .action(async () => {
    const { defaultChecks, runChecks } = await import("./doctor/checks.js");
    const config = loadConfig();
    const results = await runChecks(defaultChecks(config));
    let allOk = true;
    for (const result of results) {
      if (result.ok) {
        let line = `✅ ${result.name}`;
        if (result.detail) line += ` — ${result.detail}`;
        console.log(line);
      } else if (result.level === "warn") {
        // Advisory — surfaced but not a hard failure (doesn't affect the exit code).
        let line = `⚠️  ${result.name}`;
        if (result.detail) line += ` — ${result.detail}`;
        if (result.fix) line += ` — fix: ${result.fix}`;
        console.log(line);
      } else {
        allOk = false;
        let line = `❌ ${result.name}`;
        if (result.detail) line += ` — ${result.detail}`;
        if (result.fix) line += ` — fix: ${result.fix}`;
        console.log(line);
      }
    }
    if (!allOk) process.exit(1);
  });

program
  .command("ask-embed-backfill")
  .description("Embed all un-embedded messages now (bge-m3) so @Aida can search history")
  .option("--batch <n>", "Messages per batch", "64")
  .action(async (options: { batch?: string }) => {
    const { createDbClient } = await import("./db/client.js");
    const { OllamaEmbedder } = await import("./ask/embedder.js");
    const { embedPendingBatch } = await import("./ask/embedding-sweep.js");
    const config = loadConfig();
    const pool = createDbClient();
    const embedder = new OllamaEmbedder({
      host: config.embedding.ollamaHost,
      model: config.embedding.model,
      dim: config.embedding.dim,
    });
    const batch = Number(options.batch ?? 64);
    try {
      let total = 0;
      let failed = 0;
      for (;;) {
        const r = await embedPendingBatch({ pool, embedder, model: config.embedding.model }, batch);
        total += r.embedded;
        failed += r.failed;
        if (r.embedded || r.failed)
          process.stdout.write(`  embedded ${total} (failed ${failed})\r`);
        if (r.remaining === 0) break; // queue drained
      }
      process.stdout.write(`\nDone. Embedded ${total} messages (${failed} failed).\n`);
    } catch (err) {
      process.stderr.write(`Error: ask-embed-backfill failed: ${(err as Error).message}\n`);
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program
  .command("ask-search")
  .description("Probe: semantic-search a group's history (verifies retrieval + scoping)")
  .argument("<group>", "Group display name")
  .argument("<query>", "Natural-language query")
  .option("--k <n>", "How many messages to retrieve", "8")
  .action(async (groupName: string, query: string, options: { k?: string }) => {
    const { createDbClient } = await import("./db/client.js");
    const { findGroupByName } = await import("./db/repositories/groups.js");
    const { OllamaEmbedder } = await import("./ask/embedder.js");
    const { searchMessagesByEmbedding } = await import("./db/repositories/message-embeddings.js");
    const config = loadConfig();
    const pool = createDbClient();
    try {
      const group = await findGroupByName(pool, groupName);
      if (!group) {
        process.stderr.write(`Error: unknown chat "${groupName}".\n`);
        process.exit(1);
      }
      const embedder = new OllamaEmbedder({
        host: config.embedding.ollamaHost,
        model: config.embedding.model,
        dim: config.embedding.dim,
      });
      const qv = await embedder.embed(query);
      const hits = await searchMessagesByEmbedding(pool, group.id, qv, Number(options.k ?? 8));
      process.stdout.write(`\n${hits.length} matches in "${groupName}" for: ${query}\n\n`);
      for (const h of hits) {
        const ts = h.sentAt.toISOString().slice(0, 16).replace("T", " ");
        process.stdout.write(`  [${ts}] ${h.sender}: ${h.content.slice(0, 160)}\n`);
      }
    } finally {
      await pool.end();
    }
  });

program
  .command("merge-duplicate-chats")
  .description(
    "Merge @lid/@s.whatsapp.net duplicate chats of the same person (dry-run unless --apply)",
  )
  .option("--apply", "Actually perform the merges (default: dry-run, no writes)")
  .action(async (options: { apply?: boolean }) => {
    const config = loadConfig();
    const { createDbClient } = await import("./db/client.js");
    const pool = createDbClient();
    const { startSession } = await import("./collector/session.js");
    const { findMergeCandidates, mergeGroups } = await import("./db/repositories/merge.js");

    const session = await startSession(path.join(config.dataDir, "baileys-auth"), false);
    session.on("qr", () => {
      process.stdout.write("Scan the QR code above with WhatsApp to link your account.\n");
    });

    const run = async () => {
      // Give Baileys' lid<->pn mapping a moment to settle after connect.
      await new Promise((r) => setTimeout(r, 6000));
      const candidates = await findMergeCandidates(pool, {
        lidForPn: (pn) => session.lidForPn(pn),
        pnForLid: (lid) => session.pnForLid(lid),
      });

      if (candidates.length === 0) {
        console.log("No duplicate-chat pairs found.");
      } else {
        console.log(`Found ${candidates.length} duplicate-chat pair(s):`);
        for (const c of candidates) {
          console.log(
            `  "${c.name}"  keep ${c.survivorJid} (${c.survivorMsgs} msgs)  ⟵ merge ${c.dupJid} (${c.dupMsgs} msgs)`,
          );
        }
        // Persist every discovered pairing into the durable identity map so future
        // reconciles (and ingest canonicalization) work without a live session.
        const { recordLink } = await import("./db/repositories/identity-links.js");
        for (const c of candidates) {
          const lid = c.survivorJid.endsWith("@lid") ? c.survivorJid : c.dupJid;
          const pn = c.survivorJid.endsWith("@lid") ? c.dupJid : c.survivorJid;
          if (lid.endsWith("@lid") && pn.endsWith("@s.whatsapp.net")) {
            try {
              await recordLink(pool, { lidJid: lid, pnJid: pn, source: "bridge" });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`  ! could not persist identity link for "${c.name}": ${msg}`);
            }
          }
        }

        if (options.apply) {
          let ok = 0;
          let moved = 0;
          let dropped = 0;
          for (const c of candidates) {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              const res = await mergeGroups(client, {
                survivorId: c.survivorId,
                dupId: c.dupId,
                name: c.name,
              });
              await client.query("COMMIT");
              ok++;
              moved += res.movedMessages;
              dropped += res.deletedDuplicateMessages;
              console.log(
                `  ✓ "${c.name}" — moved ${res.movedMessages}, dropped ${res.deletedDuplicateMessages} dup`,
              );
            } catch (err) {
              await client.query("ROLLBACK").catch(() => {});
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`  ✗ "${c.name}" (${c.survivorJid} ⟵ ${c.dupJid}): ${msg}`);
            } finally {
              client.release();
            }
          }
          console.log(
            `Applied ${ok}/${candidates.length} merge(s); moved ${moved} message(s), dropped ${dropped} duplicate(s).`,
          );
        } else {
          console.log(
            "\nDry-run only — no changes made. Re-run with --apply to perform these merges.",
          );
        }
      }
      session.stop();
      await pool.end();
    };

    await new Promise<void>((resolve) => {
      session.on("connected", () => {
        run()
          .catch(async (err) => {
            console.error("merge-duplicate-chats error:", err);
            session.stop();
            await pool.end().catch(() => {});
          })
          .finally(() => resolve());
      });
    });
    process.exit(0);
  });

program
  .command("full-sync")
  .description(
    "One-time full-history sync via a fresh linked device (scan QR once). " +
      "Persists whitelisted chats (--group) or every chat (--all).",
  )
  .option("--group <list>", "Comma-separated group name(s) or id(s) to keep (whitelist)")
  .option("--all", "Persist EVERY chat — full account backfill (no whitelist)")
  .option(
    "--auth-dir <dir>",
    "Auth dir for the temporary device (default <dataDir>/baileys-fullsync-auth)",
  )
  .action(async (options: { group?: string; all?: boolean; authDir?: string }) => {
    const all = options.all === true;
    if (all && options.group) {
      process.stderr.write("Error: use only one of --all or --group.\n");
      process.exit(1);
    }
    if (!all && !options.group) {
      process.stderr.write("Error: specify --group <list> or --all.\n");
      process.exit(1);
    }

    const config = loadConfig();
    const collectorLog = getLogger("collector");
    const [{ startSession }, { handleIncomingMessage }, { createDbClient }] = await Promise.all([
      import("./collector/session.js"),
      import("./collector/collector.js"),
      import("./db/client.js"),
    ]);
    const pool = createDbClient();

    // whitelist === null → keep ALL chats (--all). Otherwise jid -> display name.
    let whitelist: Map<string, string> | null = null;
    if (!all) {
      whitelist = new Map<string, string>();
      for (const token of (options.group ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const byId = /^\d+$/.test(token);
        const { rows } = await pool.query<{ name: string; whatsapp_id: string | null }>(
          byId
            ? "SELECT name, whatsapp_id FROM groups WHERE id=$1"
            : "SELECT name, whatsapp_id FROM groups WHERE name=$1",
          [byId ? Number(token) : token],
        );
        const row = rows[0];
        if (!row) {
          process.stderr.write(`Warning: no group matching "${token}" — skipping.\n`);
        } else if (!row.whatsapp_id) {
          process.stderr.write(
            `Warning: "${row.name}" has no whatsapp_id (import-only, not a live chat) — skipping.\n`,
          );
        } else {
          whitelist.set(row.whatsapp_id, row.name);
        }
      }
      if (whitelist.size === 0) {
        process.stderr.write("Error: no resolvable live chats in the whitelist.\n");
        await pool.end();
        process.exit(1);
      }
    }

    const authDir = options.authDir ?? path.join(config.dataDir, "baileys-fullsync-auth");
    console.log("🔄 Full-history sync — temporary device.");
    if (all) {
      console.log("   Mode: --all — persisting EVERY chat (full account backfill).");
    } else {
      console.log(
        `   Whitelist (only these are persisted): ${[...whitelist!.values()].join(", ")}`,
      );
    }
    console.log(`   Auth dir: ${authDir}`);

    const session = await startSession(authDir, false, {
      syncFullHistory: true,
      acceptAllHistory: true,
    });

    let kept = 0;
    let seen = 0;
    let lastProgress: number | null = null;
    let reported = false;
    let barTimer: ReturnType<typeof setInterval> | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    // WhatsApp pushes history in phases (RECENT first, then FULL over minutes).
    // `isLatest` fires on the EARLY batch, so it is NOT a "done" signal. Instead
    // declare completion when no new history chunk has arrived for this long.
    const QUIET_MS = 45_000;

    const renderBar = () => {
      const width = 24;
      const pct =
        lastProgress != null ? Math.max(0, Math.min(100, Math.round(lastProgress))) : null;
      const filled = pct != null ? Math.round((pct / 100) * width) : 0;
      const bar = "█".repeat(filled) + "░".repeat(width - filled);
      const pctStr = pct != null ? `${pct}%`.padStart(4) : " ??%";
      process.stdout.write(`\r  [${bar}] ${pctStr} · kept ${kept} · seen ${seen}    `);
    };

    const report = async () => {
      if (reported) return;
      reported = true;
      if (barTimer) clearInterval(barTimer);
      if (quietTimer) clearTimeout(quietTimer);
      process.stdout.write("\n");
      console.log(`📊 Done. Kept ${kept} new message(s); saw ${seen} across all chats.`);
      if (whitelist) {
        for (const [jid, name] of whitelist) {
          const { rows } = await pool.query<{ c: string; oldest: string | null }>(
            "SELECT count(*) AS c, min(sent_at)::text AS oldest FROM messages m JOIN groups g ON g.id=m.group_id WHERE g.whatsapp_id=$1",
            [jid],
          );
          console.log(`   ${name}: ${rows[0]?.c ?? 0} in DB, oldest ${rows[0]?.oldest ?? "none"}`);
        }
      } else {
        const { rows } = await pool.query<{ c: string; g: string; oldest: string | null }>(
          "SELECT count(*) AS c, count(DISTINCT group_id) AS g, min(sent_at)::text AS oldest FROM messages",
        );
        console.log(
          `   All chats: ${rows[0]?.c ?? 0} messages across ${rows[0]?.g ?? 0} chats, oldest ${rows[0]?.oldest ?? "none"}`,
        );
      }
      // Onboarding parity: resolve group display names from WhatsApp's directory
      // so onboarding ends with human names, not JIDs (mirrors collect/serve).
      try {
        const { resolveAllGroupNames } = await import("./collector/name-resolver.js");
        const { resolved } = await resolveAllGroupNames(pool, {
          groupSubject: (jid: string) => session.groupSubject(jid),
        });
        if (resolved > 0) console.log(`[name-resolver] resolved ${resolved} group name(s).`);
      } catch (err) {
        process.stderr.write(
          `[name-resolver] full-sync resolution error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      session.stop();
      await pool.end().catch(() => {});
      process.exit(0);
    };

    session.on("qr", () => {
      console.log(
        "\n📲 Scan the QR above: WhatsApp → Settings → Linked Devices → Link a Device.\n",
      );
    });
    // Declare completion once history has gone quiet for QUIET_MS.
    const resetQuiet = () => {
      if (reported) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        process.stdout.write(`\n✅ No new history for ${QUIET_MS / 1000}s — sync complete.\n`);
        void report();
      }, QUIET_MS);
    };

    session.on("connected", () => {
      console.log(
        "✅ Linked. Receiving history sync… (auto-finishes when it goes quiet; Ctrl-C anytime)\n",
      );
      // Refresh the bar smoothly even between chunk events.
      barTimer = setInterval(renderBar, 500);
      resetQuiet();
    });
    session.on("message", async (msg: import("@whiskeysockets/baileys").WAMessage) => {
      seen++;
      const jid = msg.key?.remoteJid;
      if (!jid) return;
      if (whitelist && !whitelist.has(jid)) {
        // The same person can arrive under their sibling identity (@lid vs
        // @s.whatsapp.net). Admit if EITHER identity is whitelisted, so
        // canonicalization at ingest folds it into the existing chat.
        let admitted = false;
        if (!jid.endsWith("@g.us")) {
          try {
            const sibling = jid.endsWith("@lid")
              ? await session.pnForLid(jid)
              : await session.lidForPn(jid);
            if (sibling && whitelist.has(sibling)) admitted = true;
          } catch {
            // bridge cold — fall through, message is skipped (no worse than before)
          }
        }
        if (!admitted) return;
      }
      // Persist text/metadata only (no media downloads here). Media descriptors
      // are stored so the deferred backfill can fetch media later.
      void handleIncomingMessage(pool, msg, {
        dataDir: config.dataDir,
        lidForPn: (pn) => session.lidForPn(pn),
        pnForLid: (lid) => session.pnForLid(lid),
        persistMediaDescriptor: async (messageId, descriptor, state) => {
          const { upsertMessageMedia, descriptorToUpsertInput } = await import(
            "./db/repositories/message-media.js"
          );
          await upsertMessageMedia(pool, descriptorToUpsertInput(messageId, descriptor, state));
        },
        log: collectorLog,
      })
        .then((stored) => {
          if (stored) kept++;
        })
        .catch((err: unknown) => {
          process.stderr.write(
            `\n[full-sync] persist error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
    });
    session.on("history-progress", (info) => {
      if (info.progress != null) lastProgress = info.progress;
      renderBar();
      // Each chunk keeps the sync "alive"; completion is the absence of new chunks.
      resetQuiet();
    });
    process.on("SIGINT", () => void report());
    process.on("SIGTERM", () => void report());
  });

program.parse();
