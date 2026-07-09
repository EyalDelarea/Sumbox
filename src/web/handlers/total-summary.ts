import type http from "node:http";
import { insertTotalSummary } from "../../db/repositories/total-summaries.js";
import { generateTotalSummary } from "../../summarization/total-summary.js";
import { sseFrame } from "../sse.js";
import type { ServerDeps } from "./context.js";

export async function handleTotalSummary(
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
    // since defaults to the last 24h when absent/invalid.
    const sinceRaw = url.searchParams.get("since");
    let since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (sinceRaw != null) {
      const d = new Date(sinceRaw);
      if (!Number.isNaN(d.getTime())) since = d;
    }

    const start = Date.now();
    const output = await generateTotalSummary(
      {
        pool: deps.pool,
        summarizeStream: (prompt, o) => deps.summarizer.summarizeStream(prompt, o),
        tokenBudget: deps.tokenBudget,
      },
      { since },
      {
        signal: ac.signal,
        onChatStart: (info) =>
          send("status", { phase: "chat", index: info.index, total: info.total, name: info.name }),
        onHighlightToken: (delta) => send("token", { delta }),
      },
    );

    // Client disconnected mid-stream → do not persist a partial result.
    if (ac.signal.aborted) return;

    const summaryId = await insertTotalSummary(deps.pool, {
      rangeKind: "since",
      parameters: { since: since.toISOString() },
      output,
      model: deps.model,
    });

    deps.logger?.info(
      {
        evt: "total-summary",
        op: "summary",
        durationMs: Date.now() - start,
        chats: output.perChat.length,
      },
      "total summary done",
    );

    send("done", {
      summaryId,
      elapsedMs: Date.now() - start,
      highlights: output.highlights,
      perChat: output.perChat,
    });
    res.end();
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
    res.end();
  }
}
