import fs from "node:fs";
import path from "node:path";
import { backfillGroup } from "../collector/backfill.js";
import { recoverOnReconnect } from "../collector/reconnect-recovery.js";
import { SingleTenantOnboardingAdapter } from "../collector/single-tenant-onboarding.js";
import { loadConfig } from "../config.js";
import { createAppPool, createDbClient, createOperatorPool } from "../db/client.js";
import { countReadableSince, getNewestReadableSentAt } from "../db/repositories/messages.js";
import { getLastRun, recordRun } from "../db/repositories/scheduler-state.js";
import { getServiceStatus, isStale } from "../db/repositories/service-status.js";
import { getTenantDigestTimes } from "../db/repositories/user-preferences.js";
import { DEFAULT_TENANT_ID, scopedPool } from "../db/tenant-context.js";
import { PostgresJobRunRecorder } from "../jobs/job-run-recorder.js";
import { RabbitMqJobBus } from "../jobs/rabbitmq-bus.js";
import { logLifecycle } from "../logging/lifecycle.js";
import { getBaseLogger, getLogger } from "../logging/log.js";
import { enqueueScheduledRun } from "../scheduler/enqueue-run.js";
import { startScheduler } from "../scheduler/runner.js";
import { parseTimes, resolveDigestTimes } from "../scheduler/schedule.js";
import { getLastHeartbeatAt, isHealthy } from "../service/liveness.js";
import { selectActiveGroups } from "../summarization/select-active-groups.js";
import { OllamaSummarizer } from "../summarization/summarizer.js";
import { createServer } from "../web/server.js";
import { makeSummaryCommandDeps } from "./summary-command-deps.js";

/**
 * The `serve` composition root, extracted from cli.ts so the CLI action stays a thin
 * wrapper and the (large) startup graph lives in one testable place. Behavior is identical
 * to the previous inline action — the only change is that the heavy collaborators that were
 * lazy-loaded via a top-level Promise.all are now plain static imports (the whole module is
 * still loaded lazily, via `await import("./serve/bootstrap.js")` in cli.ts, so `serve`
 * never pulls this graph into lighter commands like `ask` or `groups`).
 *
 * NOTE: installConsoleGuard() runs in the CLI action BEFORE this module is imported, to
 * preserve its "before any log-capable code" invariant.
 */
export async function startServe(options: { port?: string; collect?: boolean }): Promise<void> {
  logLifecycle("boot", { proc: "serve" });
  const config = loadConfig();
  const port = options.port ? Number(options.port) : config.web.port;
  if (!Number.isInteger(port) || port <= 0) {
    process.stderr.write(`Error: invalid --port "${options.port}".\n`);
    process.exit(1);
  }
  const webLogger = getBaseLogger();
  const log = {
    scheduler: getLogger("scheduler"),
    collector: getLogger("collector"),
    nameResolver: getLogger("name-resolver"),
    reconnect: getLogger("reconnect-sync"),
    cli: getLogger("cli"),
  };
  // T2 cutover: this process talks to Postgres as the RLS-enforced catchapp_app role.
  // The web server scopes each request to its session's tenant; everything else here
  // (schedulers, collector, backfill, reconnect recovery) is default-tenant work and
  // runs through a default-scoped adapter — identical local behavior, now attributed.
  const appPool = createAppPool();
  const pool = scopedPool(appPool, () => DEFAULT_TENANT_ID);
  const operatorPool = createOperatorPool();
  const summarizer = new OllamaSummarizer({
    host: config.summarization.ollamaHost,
    model: config.summarization.model,
    numCtx: config.summarization.numCtx,
    temperature: config.summarization.temperature,
    repeatPenalty: config.summarization.repeatPenalty,
    numPredict: config.summarization.numPredict,
  });
  // Build a RabbitMQ bus for best-effort queue depth queries.
  // When --collect is active this same bus is reused for enqueuing transcription
  // jobs so we never create a second connection.
  const dbClient = createDbClient();
  const recorder = new PostgresJobRunRecorder(dbClient);
  const brokerBus = new RabbitMqJobBus({ url: config.broker.url, recorder });
  const getQueueDepths = async () => {
    const types = ["import.file", "transcribe.voicenote"] as const;
    const result: Record<string, number> = {};
    await Promise.all(
      types.map(async (type) => {
        try {
          result[type] = await brokerBus.depth(type);
        } catch {
          // broker unreachable for this type — omit so depth stays null
        }
      }),
    );
    return result as Partial<Record<(typeof types)[number], number>>;
  };

  // liveSession is set after startSession succeeds (in the --collect block below).
  // Typed as `any` to avoid a circular import with CollectorSession.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let liveSession: any = null;

  /**
   * The /סיכום command's runtime deps. The DB (group_command_permissions /
   * user_preferences) is the ONLY source of truth (D2 — an env-configured group
   * used to be un-removable from the UI); `resolveEnabledJids`/`resolveTrigger`
   * read it live, per candidate message, so there is no in-memory snapshot to
   * hot-reload and no restart needed for a UI toggle to take effect (D1). Built
   * unconditionally — construction can't fail (no DB read happens here); a DB
   * read failure at message time makes the matcher fail closed (no send),
   * logged rather than swallowed (D3).
   */
  const cmdDeps = makeSummaryCommandDeps(pool, log.collector);

  const collectDeps = options.collect
    ? {
        getLiveness: () => ({
          healthy: isHealthy(60_000),
          lastHeartbeatAt: getLastHeartbeatAt() != null ? new Date(getLastHeartbeatAt()!) : null,
        }),
        backfillTargetWindow: 25,
        backfill: async (groupId: number) => {
          if (!liveSession) return { fetched: 0, durationMs: 0, partial: true };
          const { rows } = await pool.query<{ whatsapp_id: string }>(
            "SELECT whatsapp_id FROM groups WHERE id=$1",
            [groupId],
          );
          const jid = rows[0]?.whatsapp_id;
          if (!jid) return { fetched: 0, durationMs: 0, partial: true };
          return backfillGroup({
            pool,
            groupId,
            dataDir: config.dataDir,
            targetWindow: 25,
            maxFetch: 200,
            timeoutMs: 10_000,
            log: log.collector,
            fetchHistory: (
              c: number,
              a: import("../collector/backfill.js").AnchorKey,
              ts: number,
            ) => liveSession.fetchMessageHistory(c, a, ts),
            awaitHistory: (toMs: number) => liveSession.awaitHistorySync(jid, toMs),
            downloadVoiceNote: (m: import("@whiskeysockets/baileys").WAMessage) =>
              liveSession.downloadMedia(m),
            lidForPn: (pn: string) => liveSession.lidForPn(pn),
            pnForLid: (l: string) => liveSession.pnForLid(l),
            persistMediaDescriptor: async (messageId, descriptor, state) => {
              const { upsertMessageMedia, descriptorToUpsertInput } = await import(
                "../db/repositories/message-media.js"
              );
              await upsertMessageMedia(pool, descriptorToUpsertInput(messageId, descriptor, state));
            },
          });
        },
      }
    : {};

  // Single-user QR-link onboarding, backed by the legacy --collect session. Whenever
  // --collect runs it owns the default tenant's WhatsApp session, so expose
  // /api/onboarding/* over it. Built here because createServer reads deps.onboarding at
  // construction; the live session is bridged in below once the --collect block starts it.
  let singleUserOnboarding: SingleTenantOnboardingAdapter | null = null;
  if (options.collect) {
    const authDir = path.join(config.dataDir, "baileys-auth");
    singleUserOnboarding = new SingleTenantOnboardingAdapter({
      initiallyLinked: fs.existsSync(path.join(authDir, "creds.json")),
    });
  }

  const server = createServer({
    pool: appPool, // raw app pool — createServer scopes it per request
    summarizer,
    tokenBudget: config.summarization.tokenBudget,
    model: config.summarization.model,
    getQueueDepths,
    // Expose the broker bus enqueue so the scopes handler can trigger analysis
    // for already-downloaded media when a chat is flipped to included.
    enqueue: async (type, payload) => {
      await brokerBus.enqueue(type, payload);
    },
    logger: webLogger,
    onboarding: singleUserOnboarding ?? undefined,
    ...collectDeps,
  });
  server.on("error", (err: Error) => {
    process.stderr.write(`Error: could not start server on port ${port}: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(port, () => {
    log.cli.info({ port }, `Web UI running at http://localhost:${port}  (Ctrl-C to stop)`);
    logLifecycle("ready", { proc: "serve", port });
  });

  // ── Scheduled digest runner ──────────────────────────────────────────────
  let schedulerHandle: { stop: () => void } = { stop: () => {} };
  try {
    // Per-tenant digest times (S5): prefer the default tenant's saved
    // user_preferences.digest_times, falling back to the env DIGEST_TIMES default.
    // Read via the operator pool so it works regardless of run mode. Changes take
    // effect on restart; live-on-PUT + multi-tenant per-tenant loops are follow-ups.
    let storedDigestTimes: string | null = null;
    try {
      storedDigestTimes = await getTenantDigestTimes(operatorPool, DEFAULT_TENANT_ID);
    } catch (err) {
      log.scheduler.error({ err }, "reading saved digest times failed; using env default");
    }
    const parsedTimes = resolveDigestTimes(storedDigestTimes, config.digest.times);
    schedulerHandle = startScheduler({
      pool,
      bus: brokerBus,
      times: parsedTimes,
      enabled: config.digest.enabled,
      now: () => new Date(),
      setTimer: (cb, ms) => setTimeout(cb, ms),
      getLastRun,
      recordRun,
      enqueueRun: enqueueScheduledRun,
    });
    if (config.digest.enabled) {
      log.scheduler.info(
        { times: parsedTimes, source: storedDigestTimes ? "preferences" : "env" },
        "digest scheduler started",
      );
    }
  } catch (err) {
    // Scheduler startup failure must NOT crash the web server
    log.scheduler.error({ err }, "digest scheduler startup error (web server continues)");
  }

  // ── Ops-sweep scheduler ──────────────────────────────────────────────────
  let opsSweepHandle: { stop: () => void } = { stop: () => {} };
  try {
    const { runOpsSweep } = await import("../ops/sweep.js");
    const { DEFAULT_STALENESS_MS } = await import("../service/status.js");
    const parsedOpsTimes = parseTimes(config.opsSweep.times);
    opsSweepHandle = startScheduler({
      pool,
      bus: brokerBus,
      times: parsedOpsTimes,
      enabled: config.opsSweep.enabled,
      now: () => new Date(),
      setTimer: (cb, ms) => setTimeout(cb, ms),
      getLastRun,
      recordRun,
      slotKeyPrefix: "ops",
      enqueueRun: async (poolArg, busArg) => {
        await runOpsSweep({
          pool: poolArg,
          bus: busArg,
          getQueueDepths,
          stalenessMs: DEFAULT_STALENESS_MS,
          cap: config.opsSweep.redriveCap,
          logger: webLogger,
          now: () => new Date(),
        });
      },
    });
    if (config.opsSweep.enabled) {
      log.scheduler.info({ times: config.opsSweep.times }, "ops-sweep scheduler started");
    }
  } catch (err) {
    // Ops-sweep scheduler startup failure must NOT crash the web server
    log.scheduler.error({ err }, "ops-sweep scheduler startup error (web server continues)");
  }

  // ── Retention sweep ──────────────────────────────────────────────────────
  // Auto-purge of dormant unselected chats. Configured via the RETENTION_DAYS env var
  // (default OFF → no-op), so single-user zero-config is unaffected. There is no settings
  // UI, so the env var is the only source: when set, it applies to the single default
  // tenant. Runs on the operator pool.
  const retentionDays = Number(process.env["RETENTION_DAYS"]) || 0;
  let retentionHandle: { stop: () => void } = { stop: () => {} };
  try {
    const { startRetentionSweep } = await import("./retention-sweep.js");
    const { purgeUnselectedChats, unlinkMediaFiles } = await import(
      "../db/repositories/data-deletion.js"
    );
    retentionHandle = startRetentionSweep(
      {
        listTenants: async () =>
          retentionDays > 0 ? [{ tenantId: DEFAULT_TENANT_ID, retentionDays }] : [],
        purgeChats: (tenantId, olderThanDays) =>
          purgeUnselectedChats(operatorPool, tenantId, { olderThanDays }),
        unlink: (paths) => unlinkMediaFiles(paths),
        log: {
          info: (msg) => log.scheduler.info(msg),
          warn: (msg) => log.scheduler.warn(msg),
        },
      },
      { intervalMs: Number(process.env["RETENTION_SWEEP_INTERVAL_MS"]) || 6 * 3_600_000 },
    );
  } catch (err) {
    // Retention sweep startup failure must NOT crash the web server.
    log.scheduler.error({ err }, "retention sweep startup error (web server continues)");
  }

  // ── --collect mode: start live collector in the same process ──────────────
  let liveHandle: { stop: () => void } | null = null;
  let backfillHandle: { stop: () => void } | null = null;
  let mediaPurgeHandle: { stop: () => void } | null = null;

  if (options.collect) {
    // Safety banner (same wording as the standalone `collect` command)
    if (config.whatsapp.allowSend) {
      log.collector.warn(
        "⚠️  SENDING ENABLED (WHATSAPP_ALLOW_SEND=true): this tool may transmit to WhatsApp.",
      );
    } else {
      log.collector.info(
        "🔒 Read-only mode: passive observer — will NOT send messages, read receipts, or presence (set WHATSAPP_ALLOW_SEND=true to enable). /סיכום replies to groups enabled at startup still send — see group_command_permissions; a group enabled after startup needs a restart before its first reply can send.",
      );
    }

    // Keep the collector alive when a media-download HTTP/2 stream aborts.
    // Such aborts surface as an unhandled 'error' event on a raw undici stream
    // (an uncaughtException), which bypasses the per-message handler's .catch
    // and would otherwise kill the whole process. The guard swallows only
    // transient stream/network aborts; real bugs still crash fast.
    const { installMediaStreamCrashGuard } = await import("../collector/crash-guard.js");
    installMediaStreamCrashGuard();

    // Start collector — errors must not take down the web server
    try {
      const { startSession } = await import("../collector/session.js");
      const { attachCollector } = await import("../service/live-service.js");

      // One-shot startup snapshot for the outbound guard's own allowlist (see
      // outbound-guard.ts — unchanged, unrelated to the matcher). This is NOT a
      // cache the matcher reads: maybeHandleSummaryCommand always re-resolves
      // per message via cmdDeps.resolveEnabledJids, so toggling a group OFF (or
      // editing the trigger) takes effect immediately with no restart — that is
      // this task's guarantee. Toggling a group ON in read-only mode is NOT
      // instant: the guard only permits sends to JIDs in THIS startup snapshot,
      // and (per the brief) nothing re-applies it after connect — so a brand
      // new group enabled after boot needs a restart before its first reply can
      // actually send (the matcher will match and try, but sendText throws,
      // caught and logged as a failure). Pre-existing behavior, out of this
      // task's scope; see the report's uncertainties.
      const authDir = path.join(config.dataDir, "baileys-auth");
      const session = await startSession(authDir, config.whatsapp.allowSend, {
        allowlist: [...(await cmdDeps.resolveEnabledJids())],
      });
      liveSession = session;

      // 021 — light up the web QR + scan-progress streams for single-user onboarding.
      singleUserOnboarding?.attachSession(session);

      // Snapshot the heartbeat BEFORE the collector connects (the heartbeat loop
      // writes a fresh value immediately on connect). A stale value means the
      // server was genuinely down → run boot-time gap recovery once.
      const bootStatus = await getServiceStatus(pool);
      const bootWasStale = bootStatus ? isStale(bootStatus, 90_000) : true;
      let recoveryRan = false;

      // Capture each active group's newest-stored timestamp NOW, before connecting —
      // i.e. the pre-outage state. Recovery pages backward to this frozen value and
      // measures messages newer than it. Must be read before the passive sync raises
      // the newest, or the active fetch's anchor and stop would be identical (no-op).
      const bootSnapshots: Array<{ id: number; name: string; tLast: Date | null }> = [];
      if (bootWasStale) {
        const activeSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const activeGroups = await selectActiveGroups(pool, { since: activeSince });
        for (const g of activeGroups) {
          // Newest READABLE message (any source) — the correct measurement baseline.
          // (The active fetch uses its own external_id anchor inside backfillGroup.)
          const tLast = await getNewestReadableSentAt(pool, g.id);
          bootSnapshots.push({ id: g.id, name: g.name, tLast });
        }
        log.reconnect.info(
          { groups: bootSnapshots.length },
          "armed: snapshotted active group(s) (pre-boot heartbeat stale)",
        );
        logLifecycle("reconnect.armed", { groups: bootSnapshots.length });
      }

      // Gap-mode backfill: fill a single group's history backward to a timestamp.
      const gapFillGroup = async (groupId: number, stopAtSentAt: Date) => {
        if (!liveSession) return { fetched: 0, durationMs: 0, partial: true };
        const { rows } = await pool.query<{ whatsapp_id: string }>(
          "SELECT whatsapp_id FROM groups WHERE id=$1",
          [groupId],
        );
        const jid = rows[0]?.whatsapp_id;
        if (!jid) return { fetched: 0, durationMs: 0, partial: true };
        return backfillGroup({
          pool,
          groupId,
          dataDir: config.dataDir,
          targetWindow: 25, // unused in gap-mode but required by the type
          maxFetch: 500,
          timeoutMs: 20_000,
          stopAtSentAt,
          log: log.collector,
          fetchHistory: (c: number, a: import("../collector/backfill.js").AnchorKey, ts: number) =>
            liveSession.fetchMessageHistory(c, a, ts),
          awaitHistory: (toMs: number) => liveSession.awaitHistorySync(jid, toMs),
          downloadVoiceNote: (m: import("@whiskeysockets/baileys").WAMessage) =>
            liveSession.downloadMedia(m),
          lidForPn: (pn: string) => liveSession.lidForPn(pn),
          pnForLid: (l: string) => liveSession.pnForLid(l),
          persistMediaDescriptor: async (messageId, descriptor, state) => {
            const { upsertMessageMedia, descriptorToUpsertInput } = await import(
              "../db/repositories/message-media.js"
            );
            await upsertMessageMedia(pool, descriptorToUpsertInput(messageId, descriptor, state));
          },
        });
      };

      session.on("qr", () => {
        process.stdout.write("Scan the QR code above with WhatsApp to link your account.\n");
      });
      session.on("connected", () => {
        log.collector.info("connected");
        logLifecycle("collector.connected");
        // Proactive name resolution on connect (fire-and-forget).
        import("../collector/name-resolver.js")
          .then(({ resolveAllGroupNames }) =>
            resolveAllGroupNames(pool, {
              groupSubject: (jid) => session.groupSubject(jid),
            }),
          )
          .then(({ resolved }) => {
            if (resolved > 0) {
              log.nameResolver.info({ resolved }, "resolved group name(s)");
            }
          })
          .catch((err: unknown) => {
            log.nameResolver.error({ err }, "group name resolution error");
          });

        // Boot-time gap recovery: once per process, only if the pre-boot heartbeat
        // was stale (a real outage). Give the passive recent-sync (append /
        // history-set) ~8s to land a fresh top anchor before extending backward.
        if (!recoveryRan && bootWasStale) {
          recoveryRan = true;
          void (async () => {
            await new Promise((r) => setTimeout(r, 8000));
            const result = await recoverOnReconnect({
              snapshots: bootSnapshots,
              gapFill: gapFillGroup,
              countReadableSince: (groupId, since) => countReadableSince(pool, groupId, since),
              logger: webLogger,
            });
            log.reconnect.info(
              { recovered: result.recovered, groups: result.groups },
              "done: recovered message(s) across group(s)",
            );
            logLifecycle("reconnect.done", {
              recovered: result.recovered,
              groups: result.groups,
            });
          })().catch((err: unknown) => {
            log.reconnect.error({ err }, "reconnect recovery error");
          });
        }
      });
      session.on("disconnected", () => {
        // During graceful shutdown stop() ends the socket, which emits a final
        // 'disconnected' that will NOT reconnect — logging "will auto-reconnect"
        // there is misleading noise (the shutdown lifecycle event already covers it).
        if (session.isStopped) return;
        log.collector.warn("disconnected (will auto-reconnect)");
        logLifecycle("collector.disconnected");
      });

      // Resolve chat/contact display names from WhatsApp's directory (the only
      // source for saved contact names and for groups we can't fetch a subject
      // for). Fire-and-forget; failures must never disturb collection.
      session.on("contacts", (contacts) => {
        void import("../collector/name-resolver.js")
          .then(({ resolveContactNames }) =>
            resolveContactNames(pool, contacts, {
              pnForLid: (lid) => session.pnForLid(lid),
            }),
          )
          .catch((err: unknown) => {
            log.nameResolver.error({ err }, "contacts resolution error");
          });
      });
      session.on("chats", (chats) => {
        void import("../collector/name-resolver.js")
          .then(({ resolveChatNames }) => resolveChatNames(pool, chats))
          .catch((err: unknown) => {
            log.nameResolver.error({ err }, "chats resolution error");
          });
      });

      liveHandle = attachCollector({
        session,
        pool,
        bus: brokerBus,
        dataDir: config.dataDir,
        log: log.collector,
        onError: (err) => {
          log.collector.error({ err }, "message handler error (web server continues)");
        },
        // cmdDeps carries resolveEnabledJids/resolveTrigger — read live, per message,
        // by maybeHandleSummaryCommand (D1: unconditionally wired, even with nothing
        // enabled yet).
        summaryCommand: cmdDeps,
      });

      // ── Deferred media backfill loop ─────────────────────────────────────
      const { startBackfillLoop, MEDIA_EXTENSIONS } = await import(
        "../collector/media-backfill-loop.js"
      );
      const { proto } = await import("@whiskeysockets/baileys");
      const mediaRepo = await import("../db/repositories/message-media.js");
      const msgRepo = await import("../db/repositories/messages.js");
      const chatScopes = await import("../db/repositories/chat-scopes.js");
      const fsp = await import("node:fs/promises");
      const nodePath = await import("node:path");

      backfillHandle = startBackfillLoop(
        {
          selectPending: (limit) => mediaRepo.selectPendingMedia(pool, limit),
          decodeWaMessage: (blob) => proto.WebMessageInfo.decode(blob),
          download: (waMessage) =>
            liveSession.downloadMedia(waMessage as import("@whiskeysockets/baileys").WAMessage),
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
            await brokerBus.enqueue(type, payload);
          },
          isGroupIncluded: (gid) => chatScopes.isGroupIncluded(pool, gid),
          // Leveled so expected CDN-gone failures are debug, not info spam; only
          // transient retries (info) and infra failures (warn) stay visible.
          log: {
            debug: (m) => log.collector.debug(m),
            info: (m) => log.collector.info(m),
            warn: (m) => log.collector.warn(m),
          },
        },
        {
          intervalMs: Number(process.env["MEDIA_BACKFILL_INTERVAL_MS"]) || 15_000,
          batchSize: Number(process.env["MEDIA_BACKFILL_BATCH"]) || 3,
        },
      );

      // ── Auto-purge loop for unselected media ────────────────────────────
      // Deletes the bytes (but keeps the descriptor) for media in chats the
      // user has not included, once they are older than the grace window.
      const { startMediaPurgeLoop } = await import("../collector/media-purge-loop.js");
      const mediaPurgeRepo = await import("../db/repositories/message-media.js");

      mediaPurgeHandle = startMediaPurgeLoop(
        {
          selectMinimizable: (olderThanMs) =>
            mediaPurgeRepo.selectMinimizableMedia(pool, olderThanMs),
          unlinkFile: async (filePath) => {
            try {
              await fsp.unlink(filePath);
            } catch (err) {
              // ENOENT is expected (file already gone) — swallow it silently.
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            }
          },
          markMinimized: (id) => mediaPurgeRepo.markMinimized(pool, id),
          log: {
            debug: (m) => log.collector.debug(m),
            info: (m) => log.collector.info(m),
            warn: (m) => log.collector.warn(m),
          },
        },
        {
          intervalMs: config.mediaPurge.intervalMs,
          olderThanMs: config.mediaPurge.unselectedDays * 86_400_000,
        },
      );

      log.collector.info("started — web server and collector running together");
    } catch (err) {
      // Collector startup failure must NOT exit (web server keeps running)
      log.collector.error({ err }, "startup error (web server continues)");
    }
  }

  // ── Graceful shutdown (SIGINT + SIGTERM) ─────────────────────────────────
  let shuttingDown = false;
  const gracefulShutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logLifecycle("shutdown", { proc: "serve", signal });
    // Stop schedulers first (prevents new enqueue calls)
    schedulerHandle.stop();
    opsSweepHandle.stop();
    retentionHandle.stop();
    // Stop collector wiring (if started)
    liveHandle?.stop();
    backfillHandle?.stop();
    mediaPurgeHandle?.stop();
    server.close();
    brokerBus.close().catch(() => {});
    dbClient.end().catch(() => {});
    operatorPool.end().catch(() => {});
    appPool
      .end()
      .catch(() => {})
      // Flush the shutdown event + any batched lines before exiting, with a
      // safety timeout so a stalled transport can never hang shutdown.
      .finally(() => {
        const exit = () => process.exit(0);
        try {
          webLogger.flush(exit);
        } catch {
          exit();
        }
        setTimeout(exit, 1000).unref();
      });
  };
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}
