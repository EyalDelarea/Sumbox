import type { SummaryPrompt } from "./summarizer.js";
import type { PerChatSummary } from "./total-types.js";

const REDUCE_INSTRUCTIONS = [
  "You are given several per-chat summaries from different WhatsApp chats.",
  "Produce ONE short Hebrew markdown section titled exactly:",
  "",
  "## דורש תשומת לב",
  "",
  "Under it, a bulleted list of ONLY the things that need the reader's personal",
  "attention across ALL the chats:",
  "- action items the reader must do,",
  "- decisions waiting on the reader,",
  "- direct questions/mentions aimed at the reader,",
  "- time-sensitive items (deadlines, events).",
  "",
  "Rules:",
  "- Prefix EVERY bullet with its source chat in square brackets, e.g. `- [Work] ...`.",
  "- Be specific: include the concrete detail (who, what, when) from the chat summary.",
  "- Include a bullet ONLY when it genuinely needs attention. Routine chatter is omitted.",
  "- Do NOT invent anything; use only what the per-chat summaries state.",
  "- Write in Hebrew. Reply with the `## דורש תשומת לב` heading and bullets only —",
  "  no preamble, and do NOT repeat the per-chat summaries themselves.",
  "- If nothing across all chats needs attention, reply with the heading and a single",
  "  line: `- אין פריטים שדורשים תשומת לב מיוחדת.`",
].join("\n");

/** Render one chat's contribution for the reduce prompt. */
function renderChat(c: PerChatSummary): string {
  return `[${c.name}] (${c.messageCount} הודעות)\n${c.summary}`;
}

/**
 * Build the reduce prompt: from per-chat summaries, extract the cross-cutting
 * "needs attention" highlights. Pure function.
 */
export function buildTotalPrompt(perChat: PerChatSummary[]): SummaryPrompt {
  const body = perChat.map(renderChat).join("\n\n---\n\n");
  return {
    system: REDUCE_INSTRUCTIONS,
    user: `Per-chat summaries:\n\n${body}`,
  };
}
