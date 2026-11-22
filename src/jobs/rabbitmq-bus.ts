import { randomUUID } from "node:crypto";
import * as amqplib from "amqplib";
import type { JobBus } from "./job-bus.js";
import type { JobRunRecorder } from "./job-run-recorder.js";
import type { ConsumeOptions, Job, JobPayloads, JobType } from "./job-types.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2_000;

/** One consume() call, kept so it can be replayed on a new channel. */
interface ConsumerRegistration {
  type: JobType;
  handler: (job: Job) => Promise<void>;
  opts: ConsumeOptions;
}

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

  /**
   * Every consumer registered so far. A consumer lives on a channel, so when the
   * channel or connection dies the broker forgets it; connect() replays this list
   * on each new channel so a worker keeps consuming across a reconnect.
   */
  private readonly consumers: ConsumerRegistration[] = [];

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
      let model: amqplib.ChannelModel | null = null;
      try {
        // A new connection may face a broker that came back empty, so re-assert
        // every queue on it instead of trusting what the last connection saw.
        this.assertedTypes.clear();

        model = await amqplib.connect(this.url);
        model.on("error", (err: Error) => {
          console.error("[RabbitMqJobBus] connection error:", err.message);
        });

        const ch = await model.createChannel();
        ch.on("error", (err: Error) => {
          console.error("[RabbitMqJobBus] channel error:", err.message);
        });

        // Re-subscribe everything registered so far. Empty on the first connect.
        for (const reg of this.consumers) await this.startConsumer(ch, reg);

        // Watch for loss only once fully up: a failure above is handled by the
        // catch below, and must not also schedule a reconnect from here.
        const live = model;
        live.on("close", () => this.onConnectionLost(live, "connection closed"));
        ch.on("close", () => this.onConnectionLost(live, "channel closed"));

        this.model = live;
        this.channel = ch;
        if (this.consumers.length > 0) {
          console.warn(
            `[RabbitMqJobBus] reconnected; re-subscribed ${this.consumers.length} consumer(s)`,
          );
        }
        return ch;
      } catch (err) {
        // Clear mutex on failure so a subsequent call can retry.
        this.connectingPromise = null;
        await model?.close().catch(() => {});
        throw err;
      }
    })();
    return this.connectingPromise;
  }

  /**
   * The connection or the channel died without close() being called. Either way
   * the broker has dropped our consumers, so discard both and rebuild: connect()
   * opens a fresh connection and re-subscribes every registered consumer.
   *
   * A channel-only close (a channel error, or a broker `consumer_timeout`) leaves
   * the connection up; closing it here sends both cases down one recovery path.
   * The identity check turns the second event of a pair (a channel closes along
   * with its connection) and events from a superseded connection into no-ops.
   */
  private onConnectionLost(model: amqplib.ChannelModel, reason: string): void {
    if (this.closed || this.model !== model) return;
    this.model = null;
    this.channel = null;
    this.connectingPromise = null;
    console.warn(`[RabbitMqJobBus] ${reason} unexpectedly; reconnecting...`);
    void model.close().catch(() => {}); // a no-op error when the connection already dropped
    void this.scheduleReconnect();
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
    const reg = { type, handler, opts } as ConsumerRegistration;
    const ch = await this.connect();
    await this.startConsumer(ch, reg);
    // Registered only once it is live, so the connect() above can't replay it a
    // second time. From here on, every reconnect re-subscribes it.
    this.consumers.push(reg);
  }

  /** Subscribe one consumer on `ch`. consume() and every reconnect both use it. */
  private async startConsumer(ch: amqplib.Channel, reg: ConsumerRegistration): Promise<void> {
    const { type, handler, opts } = reg;
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

        const payload = JSON.parse(msg.content.toString()) as JobPayloads[JobType];
        const job = { id, type, payload, attempts, maxAttempts } as Job;

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
        // Safety net: the channel can close between a guard above and the channel call,
        // on shutdown (close() flips it to "closing") or because the broker dropped it.
        // Either way the message stays unacked and is redelivered (after a drop, to the
        // re-subscribed consumer), so log and move on — never let this fire-and-forget
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

  /**
   * Ready messages and attached consumers for a type's main queue. Note that
   * `ready` excludes messages delivered to a live consumer and not yet acked.
   */
  async queueStats(type: JobType): Promise<{ ready: number; consumers: number }> {
    const ch = await this.connect();
    await this.assertTopology(ch, type);
    const info = await ch.checkQueue(`jobs.${type}`);
    return { ready: info.messageCount, consumers: info.consumerCount };
  }

  /**
   * Re-send a job whose job_runs row already exists, under that row's id. Unlike
   * `enqueue` it mints no id and records nothing: the startup requeue uses it to
   * restore a message the broker lost, and a fresh id would orphan the original
   * row (still non-terminal) and get it re-sent again on every restart.
   */
  async republish(job: Job): Promise<void> {
    const ch = await this.connect();
    await this.assertTopology(ch, job.type);
    ch.sendToQueue(`jobs.${job.type}`, Buffer.from(JSON.stringify(job.payload)), {
      persistent: true,
      headers: { id: job.id, attempts: job.attempts, maxAttempts: job.maxAttempts },
    });
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
