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
 *   1. SELECTION (`selectCandidates`) — the D7 cold-start exclusions, plus the
 *      author rule. Messages addressed to her, her own output, and anything whose
 *      author is not an identifiable person never reach the extractor at all.
 *      The first raises the cost of the plant vector: to teach her something
 *      durable you would have to say it to the GROUP as ordinary conversation.
 *      Measured on the 2026-08-19 incident, every turn of that jailbreak was
 *      either `@אידה`-addressed or her own reply — though that generalises less
 *      far than it looks, since the tag rule needs a LITERAL `@` and people
 *      replying to her mid-conversation do not retype it (#83).
 *      The author rule is the harder guarantee: a message she cannot attribute
 *      to a person is one she cannot form a belief from.
 *   2. VALIDATION (`validateCandidate`) — the model's output is checked against
 *      the messages it was actually shown. An invented id, or an id from another
 *      group, is dropped and counted rather than repaired.
 *
 * Rejects are a signal, not an error: the reject rate tells us whether the
 * extractor is good enough for the read path to ever ship.
 */
import type pg from "pg";
import { matchAskTrigger } from "../collector/ask-trigger.js";

/**
 * Most messages handed to the extractor in one pass.
 *
 * A context-window bound, not a preference. Measured on group 70: 1077 messages
 * over 30 days is 42k characters of Hebrew, and with the `[id] sender: ` prefixes
 * the prompt reaches roughly 28k tokens against a numCtx of 32768. An unbounded
 * window would silently truncate on a busier group — and a truncated prompt fails
 * INVISIBLY, producing fewer observations rather than an error.
 *
 * Trimming also bounds the GPU cost of a job that runs on every digest.
 */
export const MAX_CANDIDATES = 300;

/** One message the extractor may read. */
export type CandidateMessage = {
  messageId: number;
  sender: string;
  /**
   * The author's WhatsApp identity, when the ingest path captured one.
   *
   * Nullable, because the column is. A later slice attributes a memory's subject
   * to this rather than to `sender`: display names are self-chosen and two people
   * sharing one collapse into a single participant row, so a name is not an
   * identity. A null here is NOT a reason to drop the message — an author with a
   * resolved display name is a real person whether or not a jid was recorded.
   */
  senderJid: string | null;
  content: string;
  sentAt: Date;
};

/** Candidates for one window, with what the window cost to produce them. */
export type CandidateSelection = {
  candidates: CandidateMessage[];
  /** Messages the window held after the D7 exclusions, before the author rule. */
  windowTotal: number;
  /** Of those, how many were dropped because their author is not a person. */
  unattributable: number;
};

/**
 * Is this display name a person we can attribute a belief to?
 *
 * The same three tests as `listGroupParticipants`' predicate, so the roster and
 * the extractor hold one idea of who is in the room. That repository is the
 * source of truth for the wording; {@link AUTHOR_IS_A_PERSON} is its SQL copy,
 * character-for-character, and this is its TypeScript twin, kept pure so the
 * re-check beside the SQL is directly testable.
 *
 * A copy with a promise attached would drift the moment either side is edited,
 * so the promise is pinned by a test instead: `agrees with the roster on who is
 * a person` fails if the two ever disagree.
 *
 * One deliberate asymmetry: SQL compares `'Unknown'` untrimmed, this trims first,
 * so a padded `" Unknown "` passes there and is dropped here. The re-check runs
 * after the query and may be stricter than it, never looser — a placeholder with
 * whitespace round it is still a placeholder.
 *
 * A JID-shaped name is the failure this exists for. When a group message arrives
 * with neither a pushName nor a per-message participant key, the ingest path
 * falls back to the CHAT'S OWN jid as the sender's name, and participants are
 * keyed on display_name alone — so every such message, from every such sender,
 * lands on one row. Measured on group 70 over 30 days: 259 messages on one row,
 * 159 `from_me` and 100 from a hundred different real people.
 */
export function isIdentifiableAuthor(displayName: string | null | undefined): boolean {
  const name = (displayName ?? "").trim();
  if (name === "") return false;
  if (name.includes("@")) return false;
  return name !== "Unknown";
}

/**
 * The D7 exclusions, as SQL. Shared between the candidate query and the count
 * query so the two can never disagree about what the window held.
 */
const D7_EXCLUSIONS = `
      m.group_id = $1
      AND m.sent_at >= $2 AND m.sent_at < $3
      AND m.message_type = 'text'
      AND btrim(coalesce(m.text_content, '')) <> ''
      AND a.external_id IS NULL              -- not hers
      AND m.text_content !~* '@(אידה|aida)'  -- not addressed to her
      AND m.participant_id IS NOT NULL`;

/**
 * The author rule, as SQL. Character-for-character `listGroupParticipants`'.
 *
 * It lives in the WHERE clause and not in the extraction prompt on purpose: a
 * safety property written as a prompt rule can be argued with by a model reading
 * untrusted chat, and the two sensitive third-party memories measured on #83 were
 * extracted by a prompt that already forbade them in words.
 */
const AUTHOR_IS_A_PERSON = `
      btrim(coalesce(p.display_name, '')) <> ''
      AND p.display_name NOT LIKE '%@%'
      AND p.display_name <> 'Unknown'`;

const FROM_WINDOW = `
    FROM messages m
    LEFT JOIN participants p ON p.id = m.participant_id
    LEFT JOIN aida_messages a
      ON a.group_id = m.group_id AND a.external_id = m.external_id`;

/**
 * Messages eligible to be learned from, for one group and window.
 *
 * Excludes, per D7:
 * - her own output (`aida_messages`) — an agent that learns from itself reinforces
 *   whatever it said last, which is exactly how one hedged invention became a
 *   ten-turn certainty.
 * - anything addressed to her — filtered in SQL by the same `@אידה`/`@aida`
 *   shape the trigger uses, then re-checked in TS with the real matcher.
 * - system messages and empty text.
 *
 * And, per #88, anything whose author is not an identifiable person. That rule
 * also closes the historical digest hole for free: `aida_messages` covers her
 * replies but only 5 of 9 digest posts in group 70, because posts predating
 * 2026-08-19 were never marked — and every digest lands on a JID-shaped
 * participant, so the author rule catches them all with no content heuristic and
 * no backfill.
 *
 * This is a NARROWING, by roughly 100 real messages a month in the busiest group,
 * and that is the correct trade. An unattributable message is one she cannot
 * honestly form a belief from, and a memory attributed to the wrong person is not
 * recoverable by revoking it — the belief was already wrong about someone.
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
  limit = MAX_CANDIDATES,
): Promise<CandidateSelection> {
  const { rows } = await client.query<{
    id: string;
    sender: string | null;
    sender_jid: string | null;
    content: string;
    sent_at: Date;
  }>(
    `
    SELECT * FROM (
    SELECT m.id, p.display_name AS sender, m.sender_jid, m.text_content AS content, m.sent_at
    ${FROM_WINDOW}
    WHERE ${D7_EXCLUSIONS}
      AND ${AUTHOR_IS_A_PERSON}
    -- Newest first for the cap, then flipped back to chronological below: if a
    -- window has to be trimmed, losing the OLDEST messages is the right loss.
    ORDER BY m.sent_at DESC
    LIMIT $4
    ) w ORDER BY w.sent_at
    `,
    [groupId, since, until, limit],
  );

  // Counted separately rather than with a window function, because a window that
  // is ENTIRELY unattributable returns no rows to hang a count on — and that is
  // precisely the case worth seeing. Deliberately un-capped and pre-re-check, so
  // the pair stays comparable run to run.
  const { rows: counts } = await client.query<{ window_total: string; unattributable: string }>(
    `
    SELECT count(*) AS window_total,
           count(*) FILTER (WHERE NOT (${AUTHOR_IS_A_PERSON})) AS unattributable
    ${FROM_WINDOW}
    WHERE ${D7_EXCLUSIONS}
    `,
    [groupId, since, until],
  );

  const candidates = rows
    .map((r) => ({
      messageId: Number(r.id),
      sender: r.sender ?? "",
      senderJid: r.sender_jid,
      content: r.content,
      sentAt: r.sent_at,
    }))
    // Belt and braces on both SQL filters: the `@aida` pattern is a cheap
    // pre-filter whose real matcher is Unicode-aware, and the author rule is
    // re-asserted here so a future edit to the WHERE clause cannot quietly
    // reopen the bucket without this failing.
    .filter((m) => matchAskTrigger(m.content) === null && isIdentifiableAuthor(m.sender));

  return {
    candidates,
    windowTotal: Number(counts[0]?.window_total ?? 0),
    unattributable: Number(counts[0]?.unattributable ?? 0),
  };
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

/**
 * The extraction prompt. Lives beside the validator so the two version together.
 *
 * Every rule below is here because the previous version got it wrong on the real
 * group-70 corpus (986 messages, 20 accepted), not because it seemed prudent:
 *
 * - It answered in ENGLISH about a Hebrew corpus. A translated memory does not
 *   match the language she speaks or the words the group used, and this project
 *   copies names and places verbatim everywhere else.
 * - 14 of 20 were ephemeral — "I am at gate 11", "taxi is on the way", "I am not
 *   at home". "Still true later" was too abstract to bite, so the rule is now
 *   stated as a concrete test with the actual failures as counter-examples.
 * - One row was third-person about someone else's interaction with her, which the
 *   "about THEMSELVES" rule already forbade in the abstract. Naming the failure
 *   shape works better than restating the principle.
 */
export function buildExtractionPrompt(messages: CandidateMessage[]): string {
  const lines = messages
    .map((m) => `[${m.messageId}] ${m.sender}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return [
    "Below are messages from a group chat, each prefixed with its id in [brackets].",
    "",
    "Extract only DURABLE facts a person stated ABOUT THEMSELVES — things that will",
    "still be true in six months.",
    "",
    "THE TEST: would this still be true in six months? If not, skip it.",
    "  KEEP:  a job, where they live, a relationship, something they own, a",
    "         long-running hobby, a recurring commitment.",
    "  SKIP:  where they are right now, what they are doing today, travel in",
    "         progress, an errand, a plan for this week, a mood, a joke.",
    "  Examples of what to SKIP: 'I am at gate 11', 'taxi is on the way',",
    "  'I am not at home', 'arriving at 13:00', 'I am returning soon'.",
    "",
    "HARD RULES:",
    "- Write the fact in the SAME LANGUAGE as the message. Never translate.",
    "  Copy names, places and numbers exactly as written.",
    "- Only what the speaker said about THEMSELVES. If it is about another person,",
    "  or about this bot, skip it entirely — no exceptions.",
    "- Never an opinion, a judgement, an insult, or a guess about anyone.",
    "- Every item MUST cite the id of the single message it came from.",
    "- Most windows contain NOTHING durable. Returning [] is the normal, correct",
    "  answer — do not pad.",
    "",
    'Reply with ONLY a JSON array: [{"sourceMessageId": 123, "content": "..."}]',
    "",
    lines,
  ].join("\n");
}
