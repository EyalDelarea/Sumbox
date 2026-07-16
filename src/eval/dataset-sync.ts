/**
 * dataset-sync.ts — push the golden set into the LOCAL Langfuse as a dataset.
 *
 * Why a Langfuse dataset at all, when the JSONL is right there: only
 * dataset-BACKED runs produce a dataset run object, and only a dataset run gives
 * the UI's run-to-run comparison. A local-data experiment emits traces and
 * nothing to diff them against — which would defeat the entire "improve as we go"
 * goal. The JSONL stays the git-diffable local mirror; Langfuse holds the run
 * history.
 *
 * ── PRIVACY — this module ships chat content ─────────────────────────────────
 * Golden items quote real group messages. @langfuse/client reads LANGFUSE_BASEURL
 * from the environment and will POST wherever it points — it does NOT go through
 * the exporter's isLocalLangfuseUrl check in observability/langfuse.ts. A remote
 * baseUrl here would put message content on someone else's server, which is the
 * one thing GOVERNANCE calls absolute. So this module re-asserts the SAME guard
 * before any write. Do not remove it on the grounds that "the exporter already
 * checks" — the exporter is a different code path and cannot see this one.
 */

import { isLocalLangfuseUrl } from "../observability/langfuse.js";
import type { GoldenItem } from "./golden.js";

/**
 * The slice of Langfuse this module needs, as a structural type. Narrow on
 * purpose: it keeps syncDataset testable with an injected fake instead of a live
 * server, per the repo's inject-probes-not-mock-globals convention.
 */
export type DatasetApi = {
  /** Idempotent: create the dataset, or no-op when it exists. */
  ensureDataset: (name: string, description: string) => Promise<void>;
  /** Idempotent on `id`: same id updates rather than inserts. */
  upsertItem: (item: {
    datasetName: string;
    id: string;
    input: unknown;
    expectedOutput: unknown;
    metadata: unknown;
  }) => Promise<void>;
};

/**
 * Map a golden item onto Langfuse's shape.
 *
 * `expectedOutput` carries ASSERTIONS, not an answer string — free-form Hebrew
 * has unbounded valid phrasings, so a golden answer would be unmatchable. See
 * golden.ts.
 */
export function toDatasetItem(datasetName: string, item: GoldenItem) {
  return {
    datasetName,
    id: item.id,
    input: { question: item.question, groupId: item.groupId },
    expectedOutput: {
      goldExternalIds: item.goldExternalIds,
      mustNotRefuse: item.mustNotRefuse,
      expectedToolCalls: item.expectedToolCalls ?? [],
    },
    metadata: { slice: item.slice, provenance: item.provenance },
  };
}

export type SyncResult = { dataset: string; synced: number };

/**
 * Sync every item. Upsert-by-id, so re-running is safe and an edited JSONL line
 * updates its item rather than forking a duplicate — which would silently double
 * the item's weight in the aggregate.
 */
export async function syncDataset(
  api: DatasetApi,
  opts: { baseUrl: string; datasetName: string; description?: string },
  items: GoldenItem[],
): Promise<SyncResult> {
  assertLocal(opts.baseUrl);
  await api.ensureDataset(
    opts.datasetName,
    opts.description ?? "@Aida golden set — real group content, local only",
  );
  for (const item of items) await api.upsertItem(toDatasetItem(opts.datasetName, item));
  return { dataset: opts.datasetName, synced: items.length };
}

/**
 * Refuse to sync anywhere but this device. Fails CLOSED and loudly: a silent skip
 * would look like a working harness with an empty dataset, and a warning would be
 * scrolled past.
 */
export function assertLocal(baseUrl: string): void {
  if (!isLocalLangfuseUrl(baseUrl)) {
    throw new Error(
      `refusing to sync the golden set to a non-local Langfuse (${baseUrl}): golden items quote real group messages, and message content must never leave the device`,
    );
  }
}

/** Minimal shape of @langfuse/client that the adapter drives. */
type LangfuseLike = {
  api: { datasets: { create: (b: { name: string; description?: string }) => Promise<unknown> } };
  dataset: { createItem: (b: Record<string, unknown>) => Promise<unknown> };
};

/**
 * Adapt @langfuse/client to {@link DatasetApi}.
 *
 * `datasets.create` is idempotent server-side (it upserts by name), so ensure is
 * just a create. `dataset.createItem` with an explicit `id` updates in place.
 */
export function langfuseDatasetApi(lf: LangfuseLike): DatasetApi {
  return {
    ensureDataset: async (name, description) => {
      await lf.api.datasets.create({ name, description });
    },
    upsertItem: async (item) => {
      await lf.dataset.createItem(item as unknown as Record<string, unknown>);
    },
  };
}
