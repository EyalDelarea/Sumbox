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
import type { MemoryType, SelfStateFacet } from "../db/repositories/aida-memory.js";
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
/**
 * The label a message's author appears under — the one the prompt renders and the
 * one the index is keyed on. Shared so the two can never be computed differently.
 */
function labelOf(m: CandidateMessage, aliases?: Map<string, string>): string {
  return aliases ? resolveSenderName(m.sender, aliases) : resolveSenderName(m.sender);
}

export function buildSubjectIndex(
  messages: Iterable<CandidateMessage>,
  aliases?: Map<string, string>,
): SubjectIndex {
  const index = new Map<string, SubjectIdentity>();
  for (const m of messages) {
    const name = labelOf(m, aliases);
    const key = subjectKey(name);
    if (key === "") continue;
    const entry = index.get(key) ?? { name, jids: [] };
    const jid = (m.senderJid ?? "").trim();
    if (m.jidIsAuthors && jid !== "" && !entry.jids.includes(jid)) entry.jids.push(jid);
    index.set(key, entry);
  }
  return index;
}

/**
 * One window, in the shape the validator needs it.
 *
 * The two halves are built together and travel together on purpose: an index
 * built over a different set of messages than `shown` would refuse subjects that
 * did speak, or accept subjects that did not, and nothing downstream could tell.
 */
export type ExtractionWindow = {
  /** The messages the model was shown, by id. */
  shown: ReadonlyMap<number, CandidateMessage>;
  /** Who spoke in them — see {@link buildSubjectIndex}. */
  subjects: SubjectIndex;
  /** The operator's name overrides, when a caller is injecting them. */
  aliases?: Map<string, string> | undefined;
};

export function buildExtractionWindow(
  candidates: readonly CandidateMessage[],
  aliases?: Map<string, string>,
): ExtractionWindow {
  return {
    shown: new Map(candidates.map((m) => [m.messageId, m])),
    subjects: buildSubjectIndex(candidates, aliases),
    aliases,
  };
}

/**
 * One belief the extractor proposed, after validation: a type, who it is about,
 * what it says, and the messages behind it.
 *
 * `subjects` is resolved rather than as-named — every entry spoke in this window.
 * It is empty for `self_state` (a belief about @Aida has no subject in the room)
 * and may be empty for `episodic` (an event about the group is about nobody).
 */
export type ValidatedCandidate = {
  memoryType: MemoryType;
  /** `self_state` only, where it decides knowledge from a rule of behaviour. */
  facet?: SelfStateFacet;
  subjects: SubjectIdentity[];
  content: string;
  /** At least one, every one shown, deduped. */
  citations: number[];
};

/**
 * Why a candidate was refused. Every one is counted separately, because they are
 * different things happening: an invented citation is the model hallucinating, an
 * unknown subject is it reaching outside the room, and an uncorroborated one is it
 * repeating what one person said about another.
 */
export type RejectReason =
  | "not-an-object"
  | "bad-type"
  | "bad-facet"
  | "bad-id"
  | "invented-id"
  | "no-citations"
  | "empty-content"
  | "too-long"
  | "unknown-subject"
  | "wrong-subject-count"
  | "uncorroborated";

/**
 * The longest belief that may be stored.
 *
 * Raised from the shipped 300 deliberately. That bound was sized for one-line
 * self-statements ("works at X", "lives in Y"); an inferred `semantic` pattern or
 * a `relational` one is a sentence about behaviour and is simply wordier. Left at
 * 300 the four-type extractor would have its best output silently refused, and
 * the run this slice has to report would read as model misbehaviour.
 *
 * Still bounded, because content is shown in a UI and a model that starts
 * narrating has stopped extracting.
 */
export const MAX_CONTENT = 500;

/**
 * Check one extractor candidate against the window it was shown, and against
 * #99's two containment rules.
 *
 * THE ORDER OF THE CHECKS IS PART OF THE OUTPUT. A candidate can fail several at
 * once — an invented citation naming an out-of-room subject is one the real
 * corpus produced — and the first failure is the one counted. Citations are
 * checked FIRST so that the citation-hallucination rate stays comparable to the
 * number measured on #83, then subjects, then corroboration. That makes every
 * rate downstream of it a floor rather than a total, which is the honest
 * direction and worth stating rather than discovering.
 *
 * Neither containment rule claims to detect harm. They raise the evidentiary cost
 * of reaching beyond the speaker — a property of the citations, not of the words,
 * and so not something the chat being read can talk its way around. That is the
 * whole reason they live here and not in the prompt: the probe prompt measured on
 * #83 forbade both sensitive rows in words and produced them anyway.
 */
export function validateCandidate(
  raw: unknown,
  window: ExtractionWindow,
): { ok: ValidatedCandidate | null; reason?: RejectReason } {
  if (typeof raw !== "object" || raw === null) return { ok: null, reason: "not-an-object" };
  const c = raw as {
    type?: unknown;
    facet?: unknown;
    subjects?: unknown;
    content?: unknown;
    sourceMessageIds?: unknown;
  };

  const memoryType = readType(c.type);
  if (memoryType === null) return { ok: null, reason: "bad-type" };
  const facet = memoryType === "self_state" ? readFacet(c.facet) : undefined;
  if (memoryType === "self_state" && facet === undefined) return { ok: null, reason: "bad-facet" };

  // ── Citations. First, and first on purpose — see above.
  //
  // An ABSENT field is no citations, not a bad one. Both are refusals, but the
  // counters are the output of this slice: a model that stopped citing at all
  // must not read as a model citing something unparseable.
  const cited = c.sourceMessageIds;
  if (cited === undefined || cited === null) return { ok: null, reason: "no-citations" };
  const rawIds = Array.isArray(cited) ? cited : [cited];
  const ids: number[] = [];
  for (const value of rawIds) {
    const id = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(id)) return { ok: null, reason: "bad-id" };
    // The single most important check: the model may only cite what it was shown.
    // Anything else is invented, and an invented id could point into another group.
    if (!window.shown.has(id)) return { ok: null, reason: "invented-id" };
    // Deduped BEFORE anything counts them. Two citations of one message is one
    // message, and the corroboration bar below would otherwise be cleared by the
    // model repeating an id — the cheapest possible way around it.
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return { ok: null, reason: "no-citations" };

  const content = typeof c.content === "string" ? c.content.trim() : "";
  if (content.length === 0) return { ok: null, reason: "empty-content" };
  if (content.length > MAX_CONTENT) return { ok: null, reason: "too-long" };

  // ── Rule one: a subject must be someone who has spoken in this group.
  const named = readSubjects(c.subjects);
  const subjects: SubjectIdentity[] = [];
  // A `self_state` memory is about @Aida, and its table has no subject column, so
  // any name the model attached to one describes nobody it could be filed against.
  // Dropped rather than refused: the belief is still hers, and rule two below
  // still holds it to two voices.
  if (memoryType !== "self_state") {
    for (const name of named) {
      const resolved = window.subjects.get(subjectKey(name));
      if (resolved === undefined) return { ok: null, reason: "unknown-subject" };
      if (!subjects.some((s) => subjectKey(s.name) === subjectKey(resolved.name))) {
        subjects.push(resolved);
      }
    }
  }
  if (!subjectCountFits(memoryType, subjects.length)) {
    return { ok: null, reason: "wrong-subject-count" };
  }

  // ── Rule two: the evidence bar scales with how far the claim reaches.
  if (needsCorroboration(memoryType, subjects, ids, window) && !isCorroborated(ids, window)) {
    return { ok: null, reason: "uncorroborated" };
  }

  return {
    ok: { memoryType, ...(facet ? { facet } : {}), subjects, content, citations: ids },
  };
}

const MEMORY_TYPES: readonly MemoryType[] = ["episodic", "semantic", "relational", "self_state"];

function readType(value: unknown): MemoryType | null {
  const t =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, "_")
      : "";
  return (MEMORY_TYPES as readonly string[]).includes(t) ? (t as MemoryType) : null;
}

/** Both spellings of the same word. The column stores the British one. */
function readFacet(value: unknown): SelfStateFacet | undefined {
  const f = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (f === "knowledge") return "knowledge";
  if (f === "behaviour" || f === "behavior") return "behaviour";
  return undefined;
}

function readSubjects(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/**
 * How many subjects each kind of belief is about. Not a preference — the schema
 * says so: `semantic.subject_jid` is NOT NULL, `relational.subject_jids` carries a
 * CHECK for two or more distinct, `episodic.subject_jid` is nullable, and
 * `self_state` has no subject at all.
 */
function subjectCountFits(memoryType: MemoryType, count: number): boolean {
  switch (memoryType) {
    case "episodic":
      return count <= 1;
    case "semantic":
      return count === 1;
    case "relational":
      return count >= 2;
    case "self_state":
      return count === 0;
  }
}

/**
 * Is this a claim that reaches past the person who made it?
 *
 * A claim about the speaker themselves is a REPORT and one citation is enough.
 * Everything else is an ASSERTION, and an assertion sourced from one person
 * saying it once is gossip. Relational memories are about two people by
 * definition; `self_state` is what @Aida believes about herself, which #83's Q7
 * already required a second voice for.
 *
 * A SUBJECT-LESS MEMORY IS AN ASSERTION TOO, and #99 said otherwise — an event
 * about the group is nobody's private life, so it could stay at one citation. The
 * first run of this extractor against group 70 refuted that in four candidates.
 * It proposed an `episodic` memory, `subjects: []`, one citation, whose content
 * was a private conflict between two named people — one of whom never spoke in
 * the window. Declaring no subject and putting the people in the PROSE walks past
 * both containment rules at once, and it is the same failure this slice exists to
 * answer, one level up: the structure only binds what the model declares.
 *
 * So the one-citation path belongs to a self-report and to nothing else. A real
 * group event is discussed by more than one person and clears the bar; what it
 * costs is an event only one person ever mentioned, which is the trade already
 * accepted everywhere else here.
 */
function needsCorroboration(
  memoryType: MemoryType,
  subjects: readonly SubjectIdentity[],
  ids: readonly number[],
  window: ExtractionWindow,
): boolean {
  if (memoryType === "self_state" || memoryType === "relational") return true;
  const subject = subjects[0];
  // Nobody declared: nothing here says the words are about nobody. See above.
  if (subject === undefined) return true;
  const key = subjectKey(subject.name);
  return !ids.every((id) => {
    const m = window.shown.get(id);
    return m !== undefined && subjectKey(labelOf(m, window.aliases)) === key;
  });
}

/**
 * Two citations, from two DISTINCT authors.
 *
 * Authors, not messages: two citations from the same person is one person saying
 * it twice, which is exactly the shape the rule exists to refuse. The subject
 * being one of the two authors is not excluded and must not be — someone
 * confirming what is said about them is the strongest corroboration there is.
 *
 * Authors are counted by LABEL, the same key subjects resolve through, so two
 * people the operator aliased to one name count as one voice. Conservative in the
 * safe direction: it can only make corroboration harder.
 */
function isCorroborated(ids: readonly number[], window: ExtractionWindow): boolean {
  if (ids.length < 2) return false;
  const authors = new Set<string>();
  for (const id of ids) {
    const m = window.shown.get(id);
    if (m !== undefined) authors.add(subjectKey(labelOf(m, window.aliases)));
  }
  return authors.size >= 2;
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
 * WHAT THIS PROMPT IS AND IS NOT RESPONSIBLE FOR. It asks for four types of
 * belief and it repeats the containment rules — but only to stop the model
 * spending its output on candidates that will be refused. The GUARANTEE is
 * `validateCandidate`, over what came back. Everything measured on this stack
 * says a prompt rule does not bind: the probe prompt that produced the two
 * sensitive rows on #83 said, in words, *if it would embarrass someone to read
 * it, skip it*, and produced them anyway.
 *
 * Every rule below is here because a previous version got it wrong on the real
 * group-70 corpus, not because it seemed prudent:
 *
 * - It answered in ENGLISH about a Hebrew corpus. A translated memory does not
 *   match the language she speaks or the words the group used, and this project
 *   copies names and places verbatim everywhere else.
 * - 14 of 20 were ephemeral — "I am at gate 11", "taxi is on the way", "I am not
 *   at home". "Still true later" was too abstract to bite, so the rule is now
 *   stated as a concrete test with the actual failures as counter-examples.
 * - 2 of 5 cited a message id that does not exist, so the ids are handed to it
 *   in brackets and it is told to copy rather than compose them.
 *
 * INFERENCE IS THE POINT, not a loophole. A `semantic` memory drawn from how
 * somebody behaves is unreachable under the shipped prompt's self-statement rule,
 * and it is most of what a group chat actually carries — the whole reason three
 * of the four tables have stayed empty.
 *
 * Names are rendered through `resolveSenderName`, the same name-space
 * {@link buildSubjectIndex} resolves subjects in and the roster and the transcript
 * both use. If the prompt showed one rendering and the index held another, every
 * subject would fail rule one and the run would report a room nobody spoke in.
 */
export function buildExtractionPrompt(
  messages: CandidateMessage[],
  aliases?: Map<string, string>,
): string {
  const lines = messages
    .map(
      (m) =>
        `[${m.messageId}] ${labelOf(m, aliases)}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`,
    )
    .join("\n");
  return [
    "Below are messages from a group chat, each prefixed with its id in [brackets]",
    "and the name of the person who wrote it.",
    "",
    "Extract DURABLE observations about the people in this chat and about the chat",
    "itself — things that will still matter in six months.",
    "",
    "THE FOUR KINDS:",
    '  semantic    — a lasting pattern about ONE person. Stated ("I work at X") or',
    '                inferred from how they behave ("always the one who organises").',
    "  relational  — a lasting pattern BETWEEN two or more named people.",
    "  episodic    — something that HAPPENED in this group and is worth remembering.",
    "                It may be about nobody in particular; then leave subjects empty.",
    "  self_state  — something about YOU, the assistant, that this chat established:",
    '                facet "knowledge" for a fact you were told, facet "behaviour"',
    "                for how you should act in this group.",
    "",
    "THE TEST: would this still matter in six months? If not, skip it.",
    "  KEEP:  a job, where someone lives, a relationship, something they own, a",
    "         long-running hobby, a recurring commitment, a habit they repeat.",
    "  SKIP:  where they are right now, what they are doing today, travel in",
    "         progress, an errand, a plan for this week, a mood, a joke.",
    "  Examples of what to SKIP: 'I am at gate 11', 'taxi is on the way',",
    "  'I am not at home', 'arriving at 13:00', 'I am returning soon'.",
    "",
    "HARD RULES:",
    "- Write the observation in the SAME LANGUAGE as the messages. Never translate.",
    "  Copy names, places and numbers exactly as written.",
    "- Name subjects EXACTLY as they appear before the colon above. A person who",
    "  never wrote a message here cannot be a subject — not their relative, not",
    "  their colleague, not somebody the chat is talking about.",
    "- Cite the ids of the messages the observation came from, copied from the",
    "  [brackets]. Never write an id that is not above.",
    "- Anyone your words are about IS a subject. Do not write about a person you",
    "  did not list in subjects.",
    "- An observation about the person who WROTE the message needs one message.",
    "  EVERYTHING ELSE — about another person, between people, about the group, or",
    "  about you — needs AT LEAST TWO messages written by TWO DIFFERENT people.",
    "  If only one person ever said it, skip it.",
    "- Never an opinion, a judgement, or an insult.",
    "- Most windows contain NOTHING durable. Returning [] is the normal, correct",
    "  answer — do not pad.",
    "",
    "Reply with ONLY a JSON array, each item:",
    '  {"type":"semantic","subjects":["name"],"content":"...","sourceMessageIds":[12]}',
    '  {"type":"relational","subjects":["a","b"],"content":"...","sourceMessageIds":[12,34]}',
    '  {"type":"episodic","subjects":[],"content":"...","sourceMessageIds":[12]}',
    '  {"type":"self_state","facet":"behaviour","content":"...","sourceMessageIds":[12,34]}',
    "",
    lines,
  ].join("\n");
}
