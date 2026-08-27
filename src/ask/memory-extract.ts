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
import { resolveSenderName } from "../summarization/sender-name.js";

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
  /**
   * Is {@link senderJid} really THIS author's identity?
   *
   * False for the owner's own messages in a 1:1 chat, where the ingest path has no
   * per-message participant key and falls back to the chat's remote JID — the
   * OTHER person's. See {@link AUTHOR_IS_NOT_THE_OTHER_PARTY} for the measurement.
   *
   * Carried rather than filtered, because under the four-type extractor the two
   * are no longer the same fix. Dropping the message would take it away from
   * `episodic` memories too, whose subject is nullable and which can hold it
   * honestly; and the damage is no longer confined to a memory citing this row —
   * one poisoned jid entering the window's name index would misattribute every
   * belief naming that person. So the message stays, and
   * {@link buildSubjectIndex} takes identities only from rows where this is true.
   */
  jidIsAuthors: boolean;
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
  /**
   * Of the messages an identifiable person wrote, how many carry no `sender_jid`.
   *
   * Reported whether or not the caller narrowed, because it measures how far a
   * historical gap has closed, not what this run did: capture landed mid-July
   * 2026, and on group 70 the share without one went 100% → 55% → 17% over three
   * months.
   */
  withoutAuthorIdentity: number;
  /**
   * How many the 1:1 self-message guard excludes — see
   * {@link AUTHOR_IS_NOT_THE_OTHER_PARTY}.
   *
   * Counted separately from {@link withoutAuthorIdentity} because it is a
   * different thing and does not close over time. Reported at all because
   * `requireAuthorIdentity` narrows on BOTH, and a caller printing only the first
   * would understate what it left out — the same disagreement between the skip
   * line and the run that this whole predicate rework existed to fix.
   */
  misattributedSelfMessages: number;
  /**
   * The window held more than the cap allowed, so the oldest were dropped.
   *
   * Worth reporting because the cap inverts the operator's intent in the very
   * case they reach for it: the newest are kept, so widening the window to catch
   * a backlog drops the older part an earlier run did not cover.
   */
  truncated: boolean;
};

/** How to narrow a window beyond the D7 exclusions and the author rule. */
export type SelectOptions = {
  /** Most messages to hand the extractor in one pass. */
  limit?: number;
  /**
   * Keep only messages whose author can be named — see
   * {@link AUTHOR_HAS_IDENTITY} and {@link AUTHOR_IS_NOT_THE_OTHER_PARTY}.
   *
   * OFF BY DEFAULT, and it has to be: a missing jid is not a reason to disbelieve
   * a message (#88), and slice 4's episodic memories have a nullable subject, so
   * those messages are usable there. Only a caller storing something whose subject
   * is NOT NULL needs this, and asks for it explicitly.
   *
   * A WHERE clause rather than a stored mark: the gap is closing, so a persisted
   * skip-list would go stale the moment a message gained a jid.
   */
  requireAuthorIdentity?: boolean;
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

/**
 * Does this message carry a usable author identity? {@link hasAuthorIdentity} is
 * the TypeScript twin; the two must agree, since three predicates that disagreed
 * is the bug this shape exists to prevent.
 *
 * THE EMPTY STRING IS NOT AN IDENTITY, and here it is the common case, not an
 * edge one: a 1:1 chat has no per-message participant key, so those rows land
 * with `''`. Measured live, 2157 messages carry one, every one in a 1:1 chat. A
 * predicate written as `IS NOT NULL` narrows nothing on more than half the chats.
 */
const AUTHOR_HAS_IDENTITY = `btrim(coalesce(m.sender_jid, '')) <> ''`;

/**
 * In a 1:1 chat, is this message's `sender_jid` actually somebody else's?
 *
 * Yes, for every message the owner sent. A 1:1 chat has no per-message
 * participant key, so `message-mapper.ts` falls back to the chat's remote JID —
 * the OTHER person. Measured over messages carrying a real jid: group chats hold
 * 1 distinct jid across 783 `from_me` rows (the owner, correct); 1:1 chats hold
 * 36 across 923. Attributing on those would file what the owner said about
 * themselves against whoever they were talking to — the one error the design says
 * revoking cannot undo, so the rows are refused rather than repaired.
 *
 * The author rule already drops them today, but by a correlation in Baileys'
 * behaviour rather than an invariant, which is why this does not rely on it.
 * Group chats are untouched; there the fallback never fires.
 *
 * `from_me` is NULLABLE, hence the COALESCE: `NOT (NULL AND true)` is NULL, the
 * row fails the WHERE, and every direction-less message vanishes silently.
 */
const AUTHOR_IS_NOT_THE_OTHER_PARTY = `NOT (coalesce(m.from_me, false) AND coalesce(g.whatsapp_id, '') NOT LIKE '%@g.us')`;

/**
 * The TypeScript twin of {@link AUTHOR_HAS_IDENTITY}, kept pure so the two can be
 * tested against the same cases.
 */
export function hasAuthorIdentity(senderJid: string | null | undefined): boolean {
  return (senderJid ?? "").trim() !== "";
}

const FROM_WINDOW = `
    FROM messages m
    JOIN groups g ON g.id = m.group_id
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
  opts: SelectOptions = {},
): Promise<CandidateSelection> {
  const limit = opts.limit ?? MAX_CANDIDATES;
  // Both clauses apply only to a caller that will ATTRIBUTE the message to its
  // author. The dry run keeps the wider corpus for slice 4, whose episodic
  // memories have a nullable subject and can hold what this drops.
  const identityClause = opts.requireAuthorIdentity
    ? `AND ${AUTHOR_HAS_IDENTITY} AND ${AUTHOR_IS_NOT_THE_OTHER_PARTY}`
    : "";
  const { rows } = await client.query<{
    id: string;
    sender: string | null;
    sender_jid: string | null;
    jid_is_authors: boolean;
    content: string;
    sent_at: Date;
  }>(
    `
    SELECT * FROM (
    SELECT m.id, p.display_name AS sender, m.sender_jid, m.text_content AS content, m.sent_at,
           ${AUTHOR_IS_NOT_THE_OTHER_PARTY} AS jid_is_authors
    ${FROM_WINDOW}
    WHERE ${D7_EXCLUSIONS}
      AND ${AUTHOR_IS_A_PERSON}
      ${identityClause}
    -- Newest first for the cap, then flipped back to chronological below: if a
    -- window has to be trimmed, losing the OLDEST messages is the right loss.
    --
    -- One MORE than the cap, so that "the window held more than we took" can be
    -- told apart from "the window held exactly the cap". Comparing the row count
    -- to the limit cannot: a window holding exactly the cap lost nothing and
    -- would still report itself truncated, sending the operator off to narrow a
    -- window that was already whole.
    ORDER BY m.sent_at DESC
    LIMIT $4 + 1
    ) w ORDER BY w.sent_at
    `,
    [groupId, since, until, limit],
  );
  const truncated = rows.length > limit;
  // Ascending by now, so the surplus is at the FRONT — drop the oldest.
  const capped = truncated ? rows.slice(rows.length - limit) : rows;

  // Counted separately rather than with a window function, because a window that
  // is ENTIRELY unattributable returns no rows to hang a count on — and that is
  // precisely the case worth seeing. Deliberately un-capped and pre-re-check, so
  // the pair stays comparable run to run.
  const { rows: counts } = await client.query<{
    window_total: string;
    unattributable: string;
    without_identity: string;
    misattributed_self: string;
  }>(
    `
    SELECT count(*) AS window_total,
           count(*) FILTER (WHERE NOT (${AUTHOR_IS_A_PERSON})) AS unattributable,
           count(*) FILTER (WHERE (${AUTHOR_IS_A_PERSON}) AND NOT (${AUTHOR_HAS_IDENTITY}))
             AS without_identity,
           count(*) FILTER (WHERE (${AUTHOR_IS_A_PERSON}) AND (${AUTHOR_HAS_IDENTITY})
                              AND NOT (${AUTHOR_IS_NOT_THE_OTHER_PARTY}))
             AS misattributed_self
    ${FROM_WINDOW}
    WHERE ${D7_EXCLUSIONS}
    `,
    [groupId, since, until],
  );

  const candidates = capped
    .map((r) => ({
      messageId: Number(r.id),
      sender: r.sender ?? "",
      senderJid: r.sender_jid,
      jidIsAuthors: r.jid_is_authors,
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
    withoutAuthorIdentity: Number(counts[0]?.without_identity ?? 0),
    misattributedSelfMessages: Number(counts[0]?.misattributed_self ?? 0),
    truncated,
  };
}

// ── The window's name-space ───────────────────────────────────────────────

/**
 * A person a belief may be about: the label the extractor saw, and the
 * identities that spoke under it.
 */
export type SubjectIdentity = {
  /**
   * The label exactly as {@link buildExtractionPrompt} rendered it — that is,
   * `resolveSenderName`'s name-space, the same one `buildGroupRoster` and the
   * transcript use. Three name-spaces that disagreed is how #67's guardrail bugs
   * shipped, so there is one here and it is borrowed rather than invented.
   */
  name: string;
  /**
   * Distinct `sender_jid`s observed under that label, from messages whose jid is
   * really their author's.
   *
   * MAY BE EMPTY, and empty is not the same as absent: a person with a resolved
   * display name and no captured jid has spoken in this room without leaving an
   * identity behind. They are a real subject for an `episodic` memory, and not a
   * storable one for a `semantic` or `relational` belief, whose subject is NOT
   * NULL. Two different refusals, so two different states.
   */
  jids: string[];
};

/** Every label that spoke in the window, keyed by {@link subjectKey}. */
export type SubjectIndex = ReadonlyMap<string, SubjectIdentity>;

/**
 * The lookup key for a name the model returned.
 *
 * Insensitive to case and to internal whitespace, because the model RETYPES the
 * label into its JSON rather than copying the bytes it was shown, and a subject
 * refused over a doubled space would be counted as an out-of-room person — the
 * one refusal reason this slice reports as a safety property.
 *
 * Deliberately nothing more than that. No prefix match, no fuzzy match: "Royi"
 * and "Roy" are two people until proven otherwise, and the whole point of rule
 * one is that a name matching nobody is a refusal rather than a near miss.
 */
export function subjectKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Who spoke in this window, and under which identities.
 *
 * The first of #99's two containment rules is built on this map: a subject the
 * model names must resolve here, or the belief is refused. A person reconstructed
 * from others talking about them — a relative, a colleague, an ex — has no entry
 * and cannot be the subject of anything.
 *
 * IDENTITIES COME ONLY FROM ROWS WHERE THE JID IS THE AUTHOR'S. In a 1:1 chat the
 * owner's own messages carry the other party's jid, and one such row would file
 * every belief naming the owner against whoever he was talking to. The row still
 * puts its author's NAME in the index — they did speak — it just contributes no
 * identity.
 *
 * `aliases` is injectable for tests; the default is the operator's `NAME_ALIASES`,
 * because the prompt renders names through the same map and the two must agree.
 * Two members aliased to one preferred name legitimately collapse into one entry
 * carrying both jids, which the write path then has to resolve or refuse.
 */
export function buildSubjectIndex(
  messages: Iterable<CandidateMessage>,
  aliases?: Map<string, string>,
): SubjectIndex {
  const index = new Map<string, SubjectIdentity>();
  for (const m of messages) {
    const name = aliases ? resolveSenderName(m.sender, aliases) : resolveSenderName(m.sender);
    const key = subjectKey(name);
    if (key === "") continue;
    const entry = index.get(key) ?? { name, jids: [] };
    const jid = (m.senderJid ?? "").trim();
    if (m.jidIsAuthors && jid !== "" && !entry.jids.includes(jid)) entry.jids.push(jid);
    index.set(key, entry);
  }
  return index;
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
