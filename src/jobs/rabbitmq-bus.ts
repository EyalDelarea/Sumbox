import { randomUUID } from "node:crypto";
import * as amqplib from "amqplib";
import type { JobBus } from "./job-bus.js";
import type { JobRunRecorder } from "./job-run-recorder.js";
import type { ConsumeOptions, Job, JobPayloads, JobType } from "./job-types.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2_000;

export interface RabbitMqJobBusOptions {
  url: string;
  recorder: JobRunRecorder;
  idGenerator?: () => string;
}

/**
 * RabbitMqJobBus implements JobBus backed by RabbitMQ (amqplib).
 *
 * Retry mechanism: On handler throw, if attempts < maxAttempts we
 * **republish** the message to the main queue with an incremented `attempts`
 * header, then `ack` the original. This is bounded and deterministic — the
 * message is re-enqueued exactly (maxAttempts - 1) times, terminating because
 * we only republish when `attempts < maxAttempts`. When attempts === maxAttempts
 * we `nack(requeue=false)` so RabbitMQ routes the message to the DLX/DLQ via
 * the queue's `x-dead-letter-exchange` binding. We do NOT use nack-requeue for
 * retries because that would lose the attempt counter and potentially cause
 * infinite redeliveries.
 */
export class RabbitMqJobBus implements JobBus {
  private readonly url: string;
  private readonly recorder: JobRunRecorder;
  private readonly idGenerator: () => string;

  // amqplib v0.10 returns a ChannelModel from connect()
  private model: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private closed = false;
  /** Mutex: prevents duplicate connections when multiple consume() calls race at startup. */
  private connectingPromise: Promise<amqplib.Channel> | null = null;

  // Track which queues+exchanges we have already asserted so we don't repeat.
  private readonly assertedTypes = new Set<JobType>();

  constructor(opts: RabbitMqJobBusOptions) {
    this.url = opts.url;
    this.recorder = opts.recorder;
    this.idGenerator = opts.idGenerator ?? randomUUID;
  }

  // ── connection lifecycle ────────────────────────────────────────────────────

  private async connect(): Promise<amqplib.Channel> {
    if (this.channel) return this.channel;

    // Mutex: if a connect is already in flight, return the same promise so
    // concurrent consume() calls at startup share a single connection.
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = (async () => {
      try {
        const model = await amqplib.connect(this.url);
        this.model = model;

        // Auto-reconnect on unexpected close
        model.on("close", () => {
          if (!this.closed) {
            this.model = null;
            this.channel = null;
            this.connectingPromise = null;
            this.assertedTypes.clear();
            console.warn("[RabbitMqJobBus] connection closed unexpectedly; reconnecting...");
            void this.scheduleReconnect();
          }
        });

        model.on("error", (err: Error) => {
          console.error("[RabbitMqJobBus] connection error:", err.message);
        });

        const ch = await model.createChannel();

        ch.on("error", (err: Error) => {
          console.error("[RabbitMqJobBus] channel error:", err.message);
        });

        this.channel = ch;
        return ch;
      } catch (err) {
        // Clear mutex on failure so a subsequent call can retry.
        this.connectingPromise = null;
        throw err;
      }
    })();
    return this.connectingPromise;
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.closed) return;
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    if (!this.closed) {
      try {
        await this.connect();
      } catch (err) {
        console.error("[RabbitMqJobBus] reconnect failed:", (err as Error).message);
        void this.scheduleReconnect();
      }
    }
  }

  // ── topology: assert exchange + queues for a job type ──────────────────────

  private async assertTopology(ch: amqplib.Channel, type: JobType): Promise<void> {
    if (this.assertedTypes.has(type)) return;

    const mainQueue = `jobs.${type}`;
    const dlxName = `jobs.${type}.dlx`;
    const deadQueue = `jobs.${type}.dead`;

    // Dead-letter exchange (fanout keeps it simple for a single dead queue)
    await ch.assertExchange(dlxName, "fanout", { durable: true });

    // Dead queue bound to DLX
    await ch.assertQueue(deadQueue, { durable: true });
    await ch.bindQueue(deadQueue, dlxName, "");

    // Main durable queue with DLX configured
    await ch.assertQueue(mainQueue, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": dlxName,
      },
    });

    this.assertedTypes.add(type);
  }

  // ── JobBus interface ────────────────────────────────────────────────────────

  async enqueue<T extends JobType>(
    type: T,
    payload: JobPayloads[T],
    opts?: { maxAttempts?: number },
  ): Promise<{ id: string }> {
    const ch = await this.connect();
    const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const id = this.idGenerator();

    const job: Job<T> = { id, type, payload, attempts: 0, maxAttempts };

    await this.assertTopology(ch, type);
    await this.recorder.recordEnqueued(job, maxAttempts);

    const content = Buffer.from(JSON.stringify(payload));
    ch.sendToQueue(`jobs.${type}`, content, {
      persistent: true,
      headers: { id, attempts: 0, maxAttempts },
    });

    return { id };
  }

  async consume<T extends JobType>(
    type: T,
    handler: (job: Job<T>) => Promise<void>,
    opts: ConsumeOptions,
  ): Promise<void> {
    const ch = await this.connect();
    await this.assertTopology(ch, type);

    await ch.prefetch(opts.prefetch);
    const mainQueue = `jobs.${type}`;

    await ch.consume(mainQueue, (msg) => {
      if (!msg) return; // consumer cancelled

      void (async () => {
        // If we're shutting down, leave the message unacked — RabbitMQ redelivers it on
        // the next connection. Touching a closing channel (ack/sendToQueue/nack) throws
        // IllegalOperationError, which in this fire-and-forget callback would surface as
        // an unhandled rejection and crash the worker on Ctrl-C.
        if (this.closed) return;

        const headers = msg.properties.headers as Record<string, unknown>;
        const id = headers["id"] as string;
        const attempts = ((headers["attempts"] as number) ?? 0) + 1;
        const maxAttempts = (headers["maxAttempts"] as number) ?? DEFAULT_MAX_ATTEMPTS;

        const payload = JSON.parse(msg.content.toString()) as JobPayloads[T];
        const job: Job<T> = { id, type, payload, attempts, maxAttempts };

        await this.recorder.recordStatus(id, "running");

        try {
          await handler(job);
          if (this.closed) return; // shutdown raced the handler — skip ack, let it redeliver
          await this.recorder.recordStatus(id, "done");
          ch.ack(msg);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);

          if (this.closed) return; // shutdown raced a failing handler — skip ack/republish
          if (attempts < maxAttempts) {
            // Retryable — republish with incremented attempts header, then ack original
            await this.recorder.recordStatus(id, "failed", errorMessage);
            const content = Buffer.from(JSON.stringify(payload));
            ch.sendToQueue(mainQueue, content, {
              persistent: true,
              headers: { id, attempts, maxAttempts },
            });
            ch.ack(msg);
          } else {
            // Exhausted — dead-letter via nack(requeue=false)
            await this.recorder.recordStatus(id, "dead", errorMessage);
            ch.nack(msg, false, false);
          }
        }
      })().catch((err) => {
        // Safety net: close() can still race between a `this.closed` guard above and the
        // channel call (the channel flips to "closing" in between). The message stays
        // unacked and is redelivered, so log and move on — never let this fire-and-forget
        // task become an unhandled rejection that takes the process down.
        console.warn(
          `[RabbitMqJobBus] in-flight ${type} handling aborted (channel closing?): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });
  }

  async depth(type: JobType): Promise<number> {
    const ch = await this.connect();
    await this.assertTopology(ch, type);
    const info = await ch.checkQueue(`jobs.${type}`);
    return info.messageCount;
  }

  /** Depth of the dead-letter queue for a given type (exposed for testing). */
  async deadDepth(type: JobType): Promise<number> {
    const ch = await this.connect();
    await this.assertTopology(ch, type);
    const info = await ch.checkQueue(`jobs.${type}.dead`);
    return info.messageCount;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
    } catch {
      // ignore close errors
    }
    try {
      if (this.model) {
        await this.model.close();
        this.model = null;
      }
    } catch {
      // ignore close errors
    }
  }
}
