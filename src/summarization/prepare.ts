import type pg from "pg";
import { findGroupByName } from "../db/repositories/groups.js";
import { buildPrompt, estimateTokens } from "./prompt.js";
import { type Selection, selectMessages } from "./select.js";
import type { SummaryPrompt } from "./summarizer.js";

export type PreparedSummary =
  | { kind: "empty" }
  | {
      kind: "ready";
      groupId: number;
      prompt: SummaryPrompt;
      /** line-index → messages.id, for resolving the model's `^N` source markers. */
      indexMap: Map<number, number>;
      summaryType: "last_n" | "since";
      parameters: Record<string, unknown>;
      messageCount: number;
    };

/**
 * Shared first half of summarization (used by the CLI and the web server):
 * resolve the group, select messages, apply the over-budget guard, build the
 * prompt. Throws on unknown chat / over-budget (same messages as before).
 */
export async function prepareSummary(
  client: pg.Pool | pg.PoolClient,
  groupName: string,
  selection: Selection,
  tokenBudget: number,
): Promise<PreparedSummary> {
  const group = await findGroupByName(client, groupName);
  if (!group) {
    throw new Error(`Unknown chat "${groupName}". Run 'groups' to list.`);
  }
  return prepareSummaryForGroup(client, group.id, selection, tokenBudget);
}

/**
 * Same as {@link prepareSummary} but keyed on a caller-verified `groupId` — no
 * name re-resolution. Callers that already resolved the group (e.g. by JID on a
 * tenant-scoped pool) MUST use this: resolving by name would cross groups on a
 * name collision (and cross tenants on the RLS-bypassing pool).
 */
export async function prepareSummaryForGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  selection: Selection,
  tokenBudget: number,
): Promise<PreparedSummary> {
  const messages = await selectMessages(client, groupId, selection);
  if (messages.length === 0) return { kind: "empty" };

  const prompt = buildPrompt(messages);
  const tokens = estimateTokens(prompt.system + prompt.user);
  if (tokens > tokenBudget) {
    throw new Error(
      `Selection too large (~${tokens} tokens > budget ${tokenBudget}); narrow it with a smaller --last or a more recent --since.`,
    );
  }

  const summaryType = "last" in selection ? "last_n" : "since";
  const parameters =
    "last" in selection
      ? { n: selection.last }
      : { since: selection.since.toISOString().slice(0, 10) };

  return {
    kind: "ready",
    groupId,
    prompt,
    indexMap: prompt.indexMap,
    summaryType,
    parameters,
    messageCount: messages.length,
  };
}
