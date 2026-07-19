/**
 * live-service.ts — T042: testable wiring between a CollectorSession,
 * the job bus, service_status heartbeat, and crash-isolation.
 *
 * `attachCollector` is a pure dependency-injection function:
 * - on session 'connected' → setCollectorConnected(pool, true) + start heartbeat
 * - on session 'disconnected' → setCollectorConnected(pool, false)
 * - on session 'message' → handleMessage; errors are caught, logged, and forwarded
 *   to onError — NEVER propagated (crash isolation).
 * - stop() → stop heartbeat + session.stop() + set disconnected
 *
 * The real `handleIncomingMessage` from collector.ts and the real
 * `setCollectorConnected` / `recordHeartbeat` from service-status / heartbeat
 * are the defaults; override them in unit tests via deps.
 */

import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import type { CollectorSession } from "../collector/session.js";
import type { JobBus } from "../jobs/job-bus.js";
import type { Logger } from "../logging/logger.js";
import { type HeartbeatHandle, startHeartbeat } from "./heartbeat.js";

// ---------------------------------------------------------------------------
// Injectable function types (for unit testing)
// ---------------------------------------------------------------------------

export type SetConnectedFn = (pool: pg.Pool | pg.PoolClient, connected: boolean) => Promise<void>;

export type RecordHeartbeatFn = (pool: pg.Pool | pg.PoolClient) => Promise<void>;

export type HandleMessageFn = (
  pool: pg.Pool | pg.PoolClient,
  msg: WAMessage,
  opts: {
    dataDir: string;
    bus: JobBus;
    downloadVoiceNote?: (m: WAMessage) => Promise<Buffer>;
    downloadImage?: (m: WAMessage) => Promise<Buffer>;
    downloadVideo?: (m: WAMessage) => Promise<Buffer>;
    groupSubject?: (jid: string) => Promise<string>;
    lidForPn?: (pn: string) => Promise<string | null>;
    pnForLid?: (lid: string) => Promise<string | null>;
    persistMediaDescriptor?: (
      messageId: number,
      descriptor: import("../collector/media-descriptor.js").MediaDescriptor,
      state: "pending" | "present",
    ) => Promise<void>;
    log?: Logger;
  },
) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AttachCollectorDeps = {
  session: CollectorSession;
  pool: pg.Pool | pg.PoolClient;
  bus: JobBus;
  dataDir: string;
  /** Called on error inside a 'message' handler. Default: console.error */
  onError?: (err: unknown) => void;
  /** Structured logger forwarded to handleIncomingMessage so the collector's
   *  per-message diagnostics (media-download failures, descriptor persists)
   *  are logged with correlation context. Optional; collector no-ops without it. */
  log?: Logger;
  /** Heartbeat interval in ms. Default: 30_000 (30 s). */
  heartbeatMs?: number;
  /**
   * Optional hook fired on each session 'connected' (after the heartbeat is
   * (re)started), and never after stop(). The standalone `collect` CLI uses it
   * for its connect-time extras — proactive group-name resolution + a
   * "collecting" log — that have no home in the shared lifecycle. Fire-and-forget
   * from attachCollector's perspective: throwing/rejecting here is the hook's own
   * responsibility (it must not break the connect path).
   */
  onConnected?: () => void;
  /** Injectable override — defaults to real setCollectorConnected. */
  setConnected?: SetConnectedFn;
  /** Injectable override — defaults to real recordHeartbeat. */
  recordHeartbeat?: RecordHeartbeatFn;
  /** Injectable override — defaults to real handleIncomingMessage. */
  handleMessage?: HandleMessageFn;
  /**
   * Optional `/סיכום` command reply. `resolveEnabledJids`/`resolveTrigger` are
   * called PER MESSAGE (behind the matcher's own cheap pre-gate) so a group
   * toggle or trigger edit in the UI takes effect on the very next message, no
   * restart needed — there is no in-memory snapshot to hot-reload. See
   * src/serve/summary-command-deps.ts.
   */
  summaryCommand?: {
    resolveEnabledJids: () => Promise<ReadonlySet<string>>;
    resolveTrigger: () => Promise<string>;
    /** Per-group in-flight lock, owned by the caller so it survives across messages. */
    inFlight: Set<number>;
    /** Per-user memory of the last summary sent (key `${groupId}:${participantId}`). */
    lastSummaryByGroup: Map<number, WAMessage>;
  };
  /**
   * Optional @Aida (@אידה) in-group Q&A. Same allowlist as summaryCommand,
   * resolved per message for the same live-toggle reason. Its own in-flight lock,
   * separate from the summary command's (the two features can run concurrently
   * on one group; the lock only serializes repeated @Aida calls to that group).
   */
  askCommand?: {
    resolveEnabledJids: () => Promise<ReadonlySet<string>>;
    inFlight: Set<number>;
  };
  /**
   * Opt-in Langfuse observability for the agentic @Aida loop (LANGFUSE_ENABLED).
   * Present ⇒ enabled: attachCollector starts a local OpenTelemetry exporter
   * once (the heavy OTel deps are dynamic-imported, so they never load on the
   * default path) and flushes it on stop(). The endpoint is pinned and refused
   * if non-local. See src/observability/langfuse.ts and
   * ops/runbooks/langfuse-observability.md.
   */
  telemetry?: { baseUrl: string; publicKey: string; secretKey: string };
};

export type LiveServiceHandle = {
  stop: () => void;
};

/**
 * Attach lifecycle wiring to an already-started CollectorSession.
 *
 * Returns a handle whose `stop()` tears everything down cleanly.
 * A collector error inside the 'message' handler is ALWAYS caught and never
 * throws out of the event listener (crash isolation).
 */
export function attachCollector(deps: AttachCollectorDeps): LiveServiceHandle {
  const {
    session,
    pool,
    bus,
    dataDir,
    onError = (err) => {
      console.error("[live-service] message handler error:", err);
    },
    log,
    heartbeatMs = 30_000,
  } = deps;

  // Resolve injectable overrides (lazy to keep real imports out of tests)
  let _setConnected: SetConnectedFn;
  let _recordHeartbeat: RecordHeartbeatFn;
  let _handleMessage: HandleMessageFn;

  if (deps.setConnected) {
    _setConnected = deps.setConnected;
  } else {
    // Lazy-loaded real implementation — do NOT import at module top level or
    // else the test environment would need the real DB module.
    // This is resolved on first event; safe because events don't fire until
    // the session connects.
    _setConnected = async (p, c) => {
      const { setCollectorConnected } = await import("../db/repositories/service-status.js");
      await setCollectorConnected(p, c);
    };
  }

  if (deps.recordHeartbeat) {
    _recordHeartbeat = deps.recordHeartbeat;
  } else {
    _recordHeartbeat = async (p) => {
      const { recordHeartbeat } = await import("../db/repositories/service-status.js");
      await recordHeartbeat(p);
    };
  }

  if (deps.handleMessage) {
    _handleMessage = deps.handleMessage;
  } else {
    _handleMessage = async (p, msg, opts) => {
      const { handleIncomingMessage } = await import("../collector/collector.js");
      return handleIncomingMessage(p, msg, opts);
    };
  }

  // Heartbeat handle — initialized on 'connected', torn down on stop()
  let heartbeatHandle: HeartbeatHandle | null = null;

  // Once stop() runs we are tearing down: stopping the Baileys session makes it
  // emit a final 'disconnected' on a LATER tick, by which point the shutdown
  // sequence has already ended the pool. Reacting to it (another setConnected
  // write) would hit the closed pool — "Cannot use a pool after calling end".
  // So after stop() the live service ignores all further session events.
  let stopped = false;

  // ── Event handlers ─────────────────────────────────────────────────────────

  const onConnected = () => {
    if (stopped) return;
    // Mark DB row as connected
    void _setConnected(pool, true).catch((err) => {
      console.error("[live-service] setConnected(true) failed:", err);
    });

    // Start heartbeat loop. The session re-emits 'connected' on every auto-reconnect,
    // so stop any prior interval first — otherwise each reconnect orphans the previous
    // timer and they accumulate, all writing heartbeats concurrently.
    heartbeatHandle?.stop();
    heartbeatHandle = startHeartbeat({
      pool: pool as pg.Pool,
      intervalMs: heartbeatMs,
      recordHeartbeat: _recordHeartbeat,
    });

    // Caller's connect-time extras (e.g. collect's name resolution + log).
    deps.onConnected?.();
  };

  const onDisconnected = () => {
    if (stopped) return;
    // Stop the heartbeat while disconnected — it resumes on the next 'connected'.
    heartbeatHandle?.stop();
    heartbeatHandle = null;

    void _setConnected(pool, false).catch((err) => {
      console.error("[live-service] setConnected(false) failed:", err);
    });
  };

  const onMessage = (msg: WAMessage) => {
    if (stopped) return;
    // Crash-isolation: errors inside the handler must NEVER escape the listener.
    void _handleMessage(pool, msg, {
      dataDir,
      bus,
      downloadVoiceNote: (m) => session.downloadMedia(m),
      downloadImage: (m) => session.downloadMedia(m),
      downloadVideo: (m) => session.downloadMedia(m),
      groupSubject: (jid) => session.groupSubject(jid),
      lidForPn: (pn) => session.lidForPn(pn),
      pnForLid: (lid) => session.pnForLid(lid),
      persistMediaDescriptor: async (messageId, descriptor, state) => {
        const { upsertMessageMedia, descriptorToUpsertInput } = await import(
          "../db/repositories/message-media.js"
        );
        await upsertMessageMedia(pool, descriptorToUpsertInput(messageId, descriptor, state));
      },
      log,
    })
      .then((_stored) => {
        // stored can be used for logging; intentionally unused here.
      })
      .catch((err: unknown) => {
        onError(err);
      });

    // Allowlisted-group /סיכום reply — separate best-effort path, isolated from ingest.
    // Always attempt when wired: the matcher's own pre-gate + DB resolvers handle
    // "nothing enabled" / "not the trigger" cheaply — there is no snapshot to
    // check here, and gating on one would just reintroduce a stale-cache bug.
    const sc = deps.summaryCommand;
    if (sc) {
      void (async () => {
        const { maybeHandleSummaryCommand } = await import("../collector/summary-command.js");
        const p = pool as pg.Pool;
        const [
          { getSummaryOutputById },
          { upsertParticipant },
          { getSummaryGroupMark, upsertSummaryGroupMark },
          { runSummarizeOnPool },
        ] = await Promise.all([
          import("../db/repositories/summaries.js"),
          import("../db/repositories/participants.js"),
          import("../db/repositories/summary-group-marks.js"),
          import("../summarization/summarize.js"),
        ]);
        return maybeHandleSummaryCommand(msg, {
          pool: p,
          resolveEnabledJids: sc.resolveEnabledJids,
          resolveTrigger: sc.resolveTrigger,
          sendText: (jid, text, opts) => session.sendText(jid, text, opts),
          react: (jid, key, emoji) => session.react(jid, key, emoji),
          inFlight: sc.inFlight,
          lastSummaryByGroup: sc.lastSummaryByGroup,
          makeQuoted: (jid, waId, text) => session.quotedFrom(jid, waId, text),
          resolvePn: (lid) => session.pnForLid(lid),
          runSummarize: ({ groupId, selection, requesterId }) =>
            runSummarizeOnPool(p, groupId, selection, { requesterId }),
          marks: {
            resolveParticipantId: (name) => upsertParticipant(p, name),
            getMark: (groupId) => getSummaryGroupMark(p, groupId),
            setMark: (m) => upsertSummaryGroupMark(p, m),
            getSummaryOutput: (id) => getSummaryOutputById(p, id),
          },
          log,
        });
      })().catch((err: unknown) => onError(err));
    }

    // @Aida (@אידה) in-group Q&A — separate best-effort path, isolated from
    // ingest exactly like the summary command. Its matcher's own "@"-pre-gate +
    // allowlist resolve handle "not a mention" / "not enabled" cheaply.
    const ac = deps.askCommand;
    if (ac) {
      void (async () => {
        const { maybeHandleAskCommand } = await import("../collector/ask-command.js");
        const { answerQuestion } = await import("../ask/answer.js");
        const { answerAida } = await import("../ask/answer-dispatch.js");
        const { answerAgentic } = await import("../ask/agentic-answer.js");
        const { makeAgenticModel } = await import("../ask/ai-model.js");
        const { OllamaEmbedder } = await import("../ask/embedder.js");
        const { OllamaSummarizer } = await import("../summarization/summarizer.js");
        const { loadConfig } = await import("../config.js");
        const cfg = loadConfig();
        const p = pool as pg.Pool;
        const embedder = new OllamaEmbedder({
          host: cfg.embedding.ollamaHost,
          model: cfg.embedding.model,
          dim: cfg.embedding.dim,
        });
        // Reuse the summarizer as the generic gemma "prompt → text" LLM.
        const summarizer = new OllamaSummarizer({
          host: cfg.summarization.ollamaHost,
          model: cfg.summarization.model,
          numCtx: cfg.summarization.numCtx,
          temperature: cfg.summarization.temperature,
          repeatPenalty: cfg.summarization.repeatPenalty,
          numPredict: cfg.summarization.numPredict,
        });
        return maybeHandleAskCommand(msg, {
          pool: p,
          resolveEnabledJids: ac.resolveEnabledJids,
          sendText: (jid, text, opts) => session.sendText(jid, text, opts),
          react: (jid, key, emoji) => session.react(jid, key, emoji),
          inFlight: ac.inFlight,
          resolvePn: (lid) => session.pnForLid(lid),
          makeQuoted: (jid, waId, text, author) => session.quotedFrom(jid, waId, text, author),
          answer: ({ groupId, question }) =>
            answerAida(
              {
                agentic: cfg.ask.agentic,
                runAgentic: (i) =>
                  answerAgentic(
                    {
                      pool: p,
                      embedder,
                      model: makeAgenticModel({
                        host: cfg.summarization.ollamaHost,
                        model: cfg.summarization.model,
                      }),
                      telemetry: cfg.langfuse.enabled,
                      // Group a chat's @Aida turns; tag as live vs sandbox runs.
                      trace: { sessionId: `group:${i.groupId}`, tags: ["aida", "live"] },
                    },
                    i,
                  ),
                runSingleShot: (i) =>
                  answerQuestion(
                    {
                      pool: p,
                      embedder,
                      llm: {
                        answer: (prompt) => summarizer.summarize(prompt).then((o) => o.overview),
                      },
                      // The fallback path answers through the summarizer, which
                      // has no LanguageModel; attribution needs one of its own.
                      attributionModel: makeAgenticModel({
                        host: cfg.summarization.ollamaHost,
                        model: cfg.summarization.model,
                      }),
                    },
                    i,
                  ),
                log,
              },
              { groupId, question },
            ),
          log,
        });
      })().catch((err: unknown) => onError(err));
    }
  };

  // Register listeners
  session.on("connected", onConnected);
  session.on("disconnected", onDisconnected);
  // EventEmitter uses `message` as a plain string event; WAMessage is the arg.
  session.on("message", onMessage as (...args: unknown[]) => void);

  // ── Langfuse telemetry (opt-in) ──────────────────────────────────────────
  // Start the local OTel exporter ONCE for this collector process. Dynamic
  // import keeps the heavy OTel deps off the default path. Best-effort: a
  // failure here must never break ingest, and stop() flushes on the way out.
  let telemetry: { shutdown: () => Promise<void> } | null = null;
  const telemetryEndpoint = deps.telemetry;
  if (telemetryEndpoint) {
    void (async () => {
      const { createLangfuseTelemetry, defaultLangfuseDeps } = await import(
        "../observability/langfuse.js"
      );
      // defaultLangfuseDeps throws on a non-local baseUrl (privacy guard).
      const t = createLangfuseTelemetry({
        ...defaultLangfuseDeps(telemetryEndpoint),
        log: log ? (m) => log.info(m) : undefined,
      });
      // If stop() already ran while we were importing, don't start an exporter
      // nothing will flush; just skip.
      if (stopped) return;
      t.start();
      telemetry = t;
    })().catch((err: unknown) => onError(err));
  }

  // ── Handle ─────────────────────────────────────────────────────────────────

  return {
    stop() {
      // Flush any pending trace batch (best-effort; the process exits shortly
      // after, matching the rest of this teardown's best-effort style).
      void telemetry?.shutdown().catch(() => {});
      // Latch teardown first so the session's own 'disconnected' (emitted by
      // session.stop() below, on a later tick) is ignored instead of racing the
      // pool that the shutdown sequence is about to close.
      stopped = true;

      // Stop heartbeat timer
      heartbeatHandle?.stop();
      heartbeatHandle = null;

      // Mark disconnected in DB (best-effort)
      void _setConnected(pool, false).catch(() => {});

      // Stop the Baileys session
      session.stop();
    },
  };
}
