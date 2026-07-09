/** One chat's contribution to a total summary (the "map" output). */
export type PerChatSummary = {
  groupId: number;
  name: string;
  messageCount: number;
  /** Hebrew structured markdown — the existing per-chat summary. */
  summary: string;
};

/** The assembled total summary stored in total_summaries.output. */
export type TotalSummaryOutput = {
  /** Cross-cutting "needs attention" markdown (the "reduce" output). */
  highlights: string;
  perChat: PerChatSummary[];
};
