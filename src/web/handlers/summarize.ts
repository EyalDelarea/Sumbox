import type http from "node:http";
import { findGroupByName } from "../../db/repositories/groups.js";
import { countInFlightMediaJobs } from "../../db/repositories/job-runs.js";
import { countReadableByGroup, getOldestSentAt } from "../../db/repositories/messages.js";
import { upsertWatermark } from "../../db/repositories/read-watermarks.js";
import { insertSummary } from "../../db/repositories/summaries.js";
import { normalizeSummaryOutput } from "../../summarization/normalize.js";
import { prepareSummary } from "../../summarization/prepare.js";
import { prepareRegenerate } from "../../summarization/prepare-regenerate.js";
import { prepareSumbox } from "../../summarization/prepare-sumbox.js";
import { estimateTokens } from "../../summarization/prompt.js";
import { persistSumboxResult, streamSummary } from "../../summarization/run-summary.js";
import type { Selection } from "../../summarization/select.js";
import type { GenUsage } from "../../summarization/summarizer.js";
import { withGenUsage } from "../../summarization/usage-parameters.js";
import { sseFrame } from "../sse.js";
import { type ServerDeps, SUMBOX_FALLBACK_N } from "./context.js";

export async function handleSummarize(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const ac = new AbortController();
  const abortOnClose = () => ac.abort();
  req.on("close", abortOnClose);
  res.on("close", abortOnClose);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => res.write(sseFrame(event, data));
  try {
    const group = url.searchParams.get("group");
    const last = url.searchParams.get("last");
    const sinceRaw = url.searchParams.get("since");
    const mode = url.searchParams.get("mode");
    if (!group) {
      send("error", { message: "Missing group." });
      res.end();
      return;
    }

    // Parse since early so the backfill step can use it.
    let sinceDate: Date | null = null;
    if (sinceRaw != null) {
      const d = new Date(sinceRaw);
      if (!Number.isNaN(d.getTime())) sinceDate = d;
    }
    // Keep the alias used by the rest of the handler.
    const since = sinceRaw;

    // --- backfill step (runs before any mode branch) ---
    const liveness = deps.getLiveness?.();
    const stale = liveness ? !liveness.healthy : false;
    let fetchMs = 0,
      fetched = 0,
      backfillPartial = false;
    if (deps.backfill && deps.getLiveness && liveness?.healthy) {
      const grp = await findGroupByName(deps.pool, group);
      if (grp) {
        const window = deps.backfillTargetWindow ?? 25;
        const held = await countReadableByGroup(deps.pool, grp.id);
        const underWindow = held < window;
        // Check if requested since-cutoff predates our oldest stored message.
        let sinceOutrangesHistory = false;
        if (!underWindow && sinceDate != null) {
          const oldest = await getOldestSentAt(deps.pool, grp.id);
          sinceOutrangesHistory = oldest == null || sinceDate < oldest;
        }
        if (underWindow || sinceOutrangesHistory) {
          send("syncing", { phase: "start" });
          const r = await deps.backfill(grp.id);
          fetchMs = r.durationMs;
          fetched = r.fetched;
          backfillPartial = r.partial;
          send("syncing", { phase: "done", fetched, fetchMs, partial: backfillPartial });
          deps.logger?.info(
            { evt: "backfill", group, groupId: grp.id, fetched, fetchMs, partial: backfillPartial },
            "backfill",
          );
        }
      }
    }

    // --- sumbox path ---
    if (mode === "sumbox") {
      if (last || since) {
        send("error", { message: "Use only one of sumbox, last, or since." });
        res.end();
        return;
      }
      // --- regenerate branch (reason-tuned re-run over the rated summary's range) ---
      const regenerateRaw = url.searchParams.get("regenerate");
      const reasonRaw = url.searchParams.get("reason");
      if (regenerateRaw) {
        const REGEN_REASONS = new Set(["missed", "inaccurate", "too_long", "too_short"]);
        const ratedId = Number(regenerateRaw);
        const adjust =
          reasonRaw && REGEN_REASONS.has(reasonRaw)
            ? (reasonRaw as "missed" | "inaccurate" | "too_long" | "too_short")
            : null;
        if (!Number.isInteger(ratedId) || ratedId <= 0 || !adjust) {
          send("error", { message: "Invalid regenerate request." });
          res.end();
          return;
        }
        const regen = await prepareRegenerate(deps.pool, ratedId, adjust, deps.tokenBudget);
        if (regen.kind === "not-found") {
          send("error", { message: "Unknown summary." });
          res.end();
          return;
        }
        if (regen.kind === "empty") {
          send("empty", {});
          res.end();
          return;
        }
        const mediaJobsAhead = await countInFlightMediaJobs(deps.pool);
        send("status", {
          messages: regen.messageCount,
          usedFallback: false,
          stale,
          mediaJobsAhead,
        });
        const startRegen = Date.now();
        let regenUsage: GenUsage | undefined;
        const result = await streamSummary({
          tokens: deps.summarizer.summarizeStream(regen.prompt, {
            signal: ac.signal,
            onUsage: (u) => {
              regenUsage = u;
            },
          }),
          indexMap: regen.indexMap,
          signal: ac.signal,
          onToken: (delta) => send("token", { delta }),
          // Insert only (NOT persistSumboxResult) so the read-watermark stays put.
          persist: (output) =>
            insertSummary(deps.pool, {
              groupId: regen.groupId,
              summaryType: regen.summaryType,
              parameters: withGenUsage(regen.parameters, {
                genMs: Date.now() - startRegen,
                usage: regenUsage,
                estimatedTokens: estimateTokens(regen.prompt.system + regen.prompt.user),
              }),
              output,
              model: deps.model,
              regeneratedFromId: regen.regeneratedFromId,
            }),
        });
        if (result.aborted) return;
        const { output: structuredRegen, summaryId: regenSummaryId } = result;
        deps.logger?.info(
          {
            evt: "summarize",
            op: "summary",
            durationMs: Date.now() - startRegen,
            messages: regen.messageCount,
            mode: "sumbox",
            regenerated: true,
          },
          "summary done",
        );
        send("done", {
          summaryId: regenSummaryId,
          summary: normalizeSummaryOutput(structuredRegen),
          elapsedMs: Date.now() - startRegen,
          messageCount: regen.messageCount,
          regenerated: true,
          summarizeMs: Date.now() - startRegen,
          stale,
        });
        res.end();
        return;
      }
      const prepared = await prepareSumbox(deps.pool, group, SUMBOX_FALLBACK_N, deps.tokenBudget);
      if (prepared.kind === "empty") {
        send("empty", {});
        res.end();
        return;
      }
      if (prepared.kind === "cache-hit") {
        // Same normalized shape as the `done` event below, so the client renders
        // the structured §3 card (not the legacy markdown card) on a cache hit.
        send("cached", {
          summaryId: prepared.summaryId,
          summary: normalizeSummaryOutput(prepared.summary),
          generatedAt: prepared.generatedAt.toISOString(),
        });
        res.end();
        return;
      }
      // kind === "ready"
      const mediaJobsAhead = await countInFlightMediaJobs(deps.pool);
      send("status", {
        messages: prepared.messageCount,
        usedFallback: prepared.usedFallback,
        stale,
        mediaJobsAhead,
      });
      const start = Date.now();
      let genUsage: GenUsage | undefined;
      const result = await streamSummary({
        tokens: deps.summarizer.summarizeStream(prepared.prompt, {
          signal: ac.signal,
          onUsage: (u) => {
            genUsage = u;
          },
        }),
        indexMap: prepared.indexMap,
        signal: ac.signal,
        onToken: (delta) => send("token", { delta }),
        // Commit only after a successful stream — summary row first, watermark
        // second (no partial state), via the shared sumbox commit helper.
        persist: (output) =>
          persistSumboxResult({
            pool: deps.pool,
            groupId: prepared.groupId,
            summaryType: prepared.summaryType,
            parameters: withGenUsage(prepared.parameters, {
              genMs: Date.now() - start,
              usage: genUsage,
              estimatedTokens: estimateTokens(prepared.prompt.system + prepared.prompt.user),
            }),
            output,
            model: deps.model,
            newWatermark: prepared.newWatermark,
            insertSummary,
            updateWatermark: upsertWatermark,
          }),
      });
      // Guard: if the client disconnected, do NOT commit partial summary or advance watermark.
      if (result.aborted) return;
      const { output: structured, summaryId } = result;
      deps.logger?.info(
        {
          evt: "summarize",
          op: "summary",
          durationMs: Date.now() - start,
          messages: prepared.messageCount,
          mode: "sumbox",
        },
        "summary done",
      );
      send("done", {
        summaryId,
        summary: normalizeSummaryOutput(structured),
        elapsedMs: Date.now() - start,
        messageCount: prepared.messageCount,
        usedFallback: prepared.usedFallback,
        fetchMs,
        summarizeMs: Date.now() - start,
        fetched,
        partial: backfillPartial,
        stale,
      });
      res.end();
      return;
    }

    // --- existing last/since path ---
    if (last && since) {
      send("error", { message: "Use only one of last or since." });
      res.end();
      return;
    }

    let selection: Selection;
    if (since) {
      const d = new Date(since);
      if (Number.isNaN(d.getTime())) {
        send("error", { message: `Invalid since date "${since}".` });
        res.end();
        return;
      }
      selection = { since: d };
    } else {
      const n = last ? Number(last) : 25;
      if (!Number.isInteger(n) || n <= 0) {
        send("error", { message: "last must be a positive integer." });
        res.end();
        return;
      }
      selection = { last: n };
    }

    const prepared = await prepareSummary(deps.pool, group, selection, deps.tokenBudget);
    if (prepared.kind === "empty") {
      send("empty", {});
      res.end();
      return;
    }

    const mediaJobsAhead = await countInFlightMediaJobs(deps.pool);
    send("status", { messages: prepared.messageCount, stale, mediaJobsAhead });
    const start = Date.now();
    let genUsage: GenUsage | undefined;
    const result = await streamSummary({
      tokens: deps.summarizer.summarizeStream(prepared.prompt, {
        signal: ac.signal,
        onUsage: (u) => {
          genUsage = u;
        },
      }),
      indexMap: prepared.indexMap,
      signal: ac.signal,
      onToken: (delta) => send("token", { delta }),
      persist: (output) =>
        insertSummary(deps.pool, {
          groupId: prepared.groupId,
          summaryType: prepared.summaryType,
          parameters: withGenUsage(prepared.parameters, {
            genMs: Date.now() - start,
            usage: genUsage,
            estimatedTokens: estimateTokens(prepared.prompt.system + prepared.prompt.user),
          }),
          output,
          model: deps.model,
        }),
    });
    // Guard: if the client disconnected, do NOT commit partial summary.
    if (result.aborted) return;
    const { output: structured, summaryId } = result;
    deps.logger?.info(
      {
        evt: "summarize",
        op: "summary",
        durationMs: Date.now() - start,
        messages: prepared.messageCount,
        mode: since ? "since" : "last",
      },
      "summary done",
    );
    send("done", {
      summaryId,
      summary: normalizeSummaryOutput(structured),
      elapsedMs: Date.now() - start,
      fetchMs,
      summarizeMs: Date.now() - start,
      fetched,
      partial: backfillPartial,
      stale,
    });
    res.end();
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
    res.end();
  }
}
