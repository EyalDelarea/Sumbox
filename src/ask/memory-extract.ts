/**
 * memory-extract.ts — the write path for @Aida's memory (shadow phase).
 *
 * Runs off the answering path entirely, after a summary. Nothing here can slow
 * down or change a reply.
 *
 * The extractor is an LLM reading untrusted chat, so this module is built around
 * the assumption that it will sometimes be wrong or actively fooled. Two lines
 * of defence:
 *
 *   1. SELECTION (`selectCandidates`) — the D7 cold-start exclusions. Messages
 *      addressed to her and her own output never reach the extractor at all.
 *      This is what kills the plant vector: to teach her something durable you
 *      would have to say it to the GROUP as ordinary conversation, not to her.
 *      Measured on the 2026-08-19 incident: every turn of that jailbreak was
 *      either `@אידה`-addressed or her own reply, so the whole exchange is
 *      excluded by construction.
 *   2. VALIDATION (`validateCandidate`) — the model's output is checked against
 *      the messages it was actually shown. An invented id, or an id from another
 *      group, is dropped and counted rather than repaired.
 *
 * Rejects are a signal, not an error: the reject rate tells us whether the
 * extractor is good enough for the read path to ever ship.
 */
import type pg from "pg";
import { matchAskTrigger } from "../collector/ask-trigger.js";

/** One message the extractor may read. */
export type CandidateMessage = {
  messageId: number;
  sender: string;
  content: string;
  sentAt: Date;
};

/**
 * Messages eligible to be learned from, for one group and window.
 *
 * Excludes, per D7:
 * - her own output (`aida_messages`, which covers both @Aida replies and summary
 *   posts) — an agent that learns from itself reinforces whatever it said last,
 *   which is exactly how one hedged invention became a ten-turn certainty.
 * - anything addressed to her — filtered in SQL by the same `@אידה`/`@aida`
 *   shape the trigger uses, then re-checked in TS with the real matcher.
 * - system messages and empty text.
 *
 * `from_me` is deliberately NOT excluded: measured on group 70 it covers 3405 of
 * the owner's own messages against 185 bot replies, so dropping it would blind
 * her to the most active person in the room.
 */
export async function selectCandidates(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  since: Date,
  until: Date,
): Promise<CandidateMessage[]> {
  const { rows } = await client.query<{
    id: string;
    sender: string | null;
    content: string;
    sent_at: Date;
  }>(
    `
    SELECT m.id, p.display_name AS sender, m.text_content AS content, m.sent_at
    FROM messages m
    LEFT JOIN participants p ON p.id = m.participant_id
    LEFT JOIN aida_messages a
      ON a.group_id = m.group_id AND a.external_id = m.external_id
    WHERE m.group_id = $1
      AND m.sent_at >= $2 AND m.sent_at < $3
      AND m.message_type = 'text'
      AND btrim(coalesce(m.text_content, '')) <> ''
      AND a.external_id IS NULL              -- not hers
      AND m.text_content !~* '@(אידה|aida)'  -- not addressed to her
      AND m.participant_id IS NOT NULL
    ORDER BY m.sent_at
    `,
    [groupId, since, until],
  );
  return (
    rows
      .map((r) => ({
        messageId: Number(r.id),
        sender: r.sender ?? "",
        content: r.content,
        sentAt: r.sent_at,
      }))
      // Belt and braces: the SQL pattern is a cheap pre-filter, the real matcher is
      // Unicode-aware and is what the collector actually trusts.
      .filter((m) => matchAskTrigger(m.content) === null)
  );
}

/** What the extractor is asked to produce, per message. */
export type Candidate = { sourceMessageId: number; content: string };

export type Rejection = { candidate: unknown; reason: string };

/**
 * Check one extractor candidate against the messages it was shown.
 *
 * Returns the accepted candidate or a reason. The reasons are deliberately
 * specific — "invented id" and "empty content" are different extractor bugs and
 * conflating them would hide which one is happening.
 */
export function validateCandidate(
  raw: unknown,
  shown: ReadonlyMap<number, CandidateMessage>,
): {
  ok: Candidate | null;
  reason?: string;
} {
  if (typeof raw !== "object" || raw === null) return { ok: null, reason: "not-an-object" };
  const c = raw as { sourceMessageId?: unknown; content?: unknown };
  const id = typeof c.sourceMessageId === "number" ? c.sourceMessageId : Number(c.sourceMessageId);
  if (!Number.isInteger(id)) return { ok: null, reason: "bad-id" };
  // The single most important check: the model may only cite what it was shown.
  // Anything else is invented, and an invented id could point into another group.
  if (!shown.has(id)) return { ok: null, reason: "invented-id" };
  const content = typeof c.content === "string" ? c.content.trim() : "";
  if (content.length === 0) return { ok: null, reason: "empty-content" };
  if (content.length > 300) return { ok: null, reason: "too-long" };
  return { ok: { sourceMessageId: id, content } };
}

/**
 * Parse the extractor's raw text into candidates.
 *
 * Tolerates the model wrapping JSON in prose or a code fence, which small models
 * do constantly — but never "repairs" the content itself. A response we cannot
 * parse yields nothing, which is the safe direction: a missed observation costs
 * nothing, an invented one is what this whole module exists to prevent.
 */
export function parseCandidates(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The extraction prompt. Kept here so it versions alongside the validator. */
export function buildExtractionPrompt(messages: CandidateMessage[]): string {
  const lines = messages
    .map((m) => `[${m.messageId}] ${m.sender}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return [
    "Below are messages from a group chat, each prefixed with its id in [brackets].",
    "",
    "Extract durable facts that a person STATED ABOUT THEMSELVES — their job, where",
    "they live, what they own, a plan they have, something they like or dislike.",
    "",
    "Rules:",
    "- Only what the speaker said about THEMSELVES. Never about another person.",
    "- Never an opinion, a judgement, an insult, or a guess about anyone.",
    "- Only if it is still true later. Skip one-off chatter and jokes.",
    "- Every item MUST cite the id of the single message it came from.",
    "- If nothing qualifies, return [].",
    "",
    'Reply with ONLY a JSON array: [{"sourceMessageId": 123, "content": "..."}]',
    "",
    lines,
  ].join("\n");
}
