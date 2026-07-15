import type pg from "pg";
import {
  selectUnembeddedContentMessages,
  upsertMessageEmbedding,
} from "../db/repositories/message-embeddings.js";
import type { Embedder } from "./embedder.js";

export type EmbeddingSweepDeps = {
  pool: pg.Pool;
  embedder: Embedder;
  /** Model label stored on each row (e.g. "bge-m3"). */
  model: string;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
};

export type SweepResult = { embedded: number; failed: number; remaining: number };

/**
 * Embed one batch of the oldest-unembedded messages.
 *
 * This is the ONE mechanism that keeps embeddings current: it drains both the
 * stale historical gap (messages embedded once, long ago) and every newly
 * ingested message, because both are simply "content messages with no embedding
 * row". No hook in the hot ingest path, no separate backfill script.
 *
 * A single message that fails to embed (transient Ollama error, odd content) is
 * logged and skipped — it must not abort the batch or wedge the sweep, and it
 * will be retried on the next pass since it stays unembedded. Returns counts so
 * the caller (a loop, or the backfill CLI) can decide whether to continue.
 */
export async function embedPendingBatch(
  deps: EmbeddingSweepDeps,
  batchSize: number,
): Promise<SweepResult> {
  const pending = await selectUnembeddedContentMessages(deps.pool, batchSize);
  let embedded = 0;
  let failed = 0;
  for (const msg of pending) {
    try {
      const embedding = await deps.embedder.embed(msg.content);
      await upsertMessageEmbedding(deps.pool, { messageId: msg.id, embedding, model: deps.model });
      embedded++;
    } catch (err) {
      failed++;
      deps.log?.warn({ err, messageId: msg.id }, "embedding sweep: failed one message, skipping");
    }
  }
  // `remaining` is a lower bound: batchSize when the batch was full (more to do),
  // else 0. Lets a backfill loop stop when the queue drains without an extra query.
  const remaining = pending.length === batchSize ? batchSize : 0;
  return { embedded, failed, remaining };
}

export type EmbeddingSweepHandle = { stop: () => void };

/**
 * Run {@link embedPendingBatch} on an interval until stopped. Overlap-safe: a
 * slow batch (bge-m3 over a big backlog) can outlast the interval, so a re-entry
 * guard skips a tick already in progress rather than stacking runs.
 */
export function startEmbeddingSweep(
  deps: EmbeddingSweepDeps,
  opts: { intervalMs: number; batchSize: number },
): EmbeddingSweepHandle {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await embedPendingBatch(deps, opts.batchSize);
      if (r.embedded || r.failed) {
        deps.log?.info({ ...r }, "embedding sweep: batch done");
      }
    } catch (err) {
      deps.log?.warn({ err }, "embedding sweep: batch threw");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref?.();
  void tick(); // kick off immediately rather than waiting a full interval
  return { stop: () => clearInterval(timer) };
}
