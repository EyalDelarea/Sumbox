/**
 * api.js — Thin client API wrapper for the WhatsApp-Sum web UI.
 *
 * Browser ES module (plain JS, no TypeScript).
 * Uses browser globals: fetch and EventSource.
 * No DOM manipulation — purely data-fetching logic.
 *
 * NOT unit-tested here because fetch/EventSource are browser globals
 * without a DOM/browser test environment. Keep this module thin and
 * correct — all business logic belongs in time.js or the view layer.
 */

/**
 * Fetch the list of groups. `summaryPreview` is a one-line preview of the
 * group's latest cached catch-up summary (null when none exists yet), so the
 * Updates cards can show what a chat is about before the user taps in.
 *
 * @returns {Promise<Array<{id: number, name: string, source: string, messageCount: number, lastMessageAt: string|null, newCount: number, summaryPreview: string|null}>>}
 */
export function getGroups() {
  return fetch("/api/groups").then((r) => r.json());
}

/**
 * Fetch the current service/system status.
 *
 * @returns {Promise<{
 *   service: { up: boolean, collectorConnected: boolean, lastHeartbeatAt: string|null, lastQrAt: string|null, stale: boolean },
 *   queues: Record<string, { depth: number }>,
 *   jobs: { pending: number, running: number, done: number, failed: number, dead: number },
 *   generatedAt: string,
 *   liveness: { healthy: boolean, lastHeartbeatAt: string|null } | null
 * }>}
 */
export function getStatus() {
  return fetch("/api/status").then((r) => r.json());
}

/**
 * Fetch stored summaries for a group (history view).
 *
 * @param {string} group  - Exact group display name
 * @param {number} [limit] - Optional positive integer (default 50, max 200 server-side)
 * `output` is normalized: `overview` is always the full markdown; v2 rows also
 * carry `tldr` + sectioned bullets (`{text, sourceMessageId?}`), v1 rows are
 * sectioned best-effort with no source links.
 * @param {string} group  - Exact group display name
 * @param {number} [limit] - Optional positive integer (default 50, max 200 server-side)
 * @returns {Promise<Array<{
 *   id: number,
 *   summaryType: "last_n"|"since"|"watermark",
 *   parameters: Record<string, unknown>,
 *   output: { version: 1|2, overview: string, tldr: string, topics: Array<{text:string, sourceMessageId?:number}>, decisions: Array<object>, openQuestions: Array<object>, actionItems: Array<object> },
 *   model: string,
 *   createdAt: string
 * }>>}
 */
export function getSummaries(group, limit) {
  const url =
    `/api/summaries?group=${encodeURIComponent(group)}` +
    (limit ? `&limit=${limit}` : "");
  return fetch(url).then((r) => r.json());
}

/**
 * Rate one catch-up summary 👍 / 👎 (+ optional reason code). Same-origin POST.
 * @param {number} summaryId
 * @param {1|-1|null} rating
 * @param {"missed"|"inaccurate"|"too_long"|"too_short"} [reason]
 * @returns {Promise<{ok: boolean, rating: 1|-1|null}>}
 */
export function rateSummary(summaryId, rating, reason) {
  return fetch(`/api/summaries/${summaryId}/rating`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reason === undefined ? { rating } : { rating, reason }),
  }).then((r) => {
    if (!r.ok) throw new Error(`rateSummary ${r.status}`);
    return r.json();
  });
}

/**
 * Fetch a window of messages around a cited message, for the Ask source-jump
 * thread view.
 *
 * @param {{chat: string, aroundId: number, limit?: number}} params
 * @returns {Promise<Array<{id: number, sender: string, text: string, sentAt: string, fromMe: boolean}>>}
 */
export function getMessages({ chat, aroundId, limit }) {
  const qs = new URLSearchParams({ chat });
  if (aroundId != null) qs.set("aroundId", String(aroundId));
  if (limit) qs.set("limit", String(limit));
  return fetch(`/api/messages?${qs.toString()}`).then((r) => {
    if (!r.ok) throw new Error(`messages ${r.status}`);
    return r.json();
  });
}

/**
 * Open an SSE stream to /api/summarize and wire up event handlers.
 *
 * params shape (one of):
 *   { mode: "sumbox" }           — summarize from the user's read watermark
 *   { last: N }                   — last N messages
 *   { since: "<ISO datetime>" }   — all messages since the given UTC timestamp
 *
 * handlers (all optional):
 *   syncing(data)  — {phase, fetched, fetchMs, partial} — progress while fetching messages
 *   status(data)   — {messages, usedFallback, stale}    — pre-summarise metadata
 *   token(data)    — {delta}                            — incremental LLM output token
 *   cached(data)   — {summary, generatedAt}             — served from cache (summary = normalized structured summary); stream ends here
 *   empty()        — no messages found; stream ends here
 *   done(data)     — {summaryId, elapsedMs, fetchMs, summarizeMs, fetched, partial, stale}
 *   error(data)    — {message}                          — server-side error; stream ends here
 *
 * The caller is responsible for calling .close() on the returned EventSource when done
 * (on "cached", "empty", "done", "error"). The native onerror fires when the connection
 * drops; we close automatically in that case.
 *
 * @param {Record<string, string|number>} params
 * @param {Partial<Record<string, Function>>} handlers
 * @returns {EventSource}
 */
export function summarizeStream(params, handlers = {}) {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    )
  );

  const es = new EventSource(`/api/summarize?${qs}`);

  // Events that carry JSON data
  const dataEvents = ["syncing", "status", "token", "cached", "done", "error"];
  for (const event of dataEvents) {
    es.addEventListener(event, (e) => {
      handlers[event]?.(JSON.parse(e.data));
    });
  }

  // "empty" carries no data payload
  es.addEventListener("empty", () => {
    handlers.empty?.();
  });

  // Native connection error — close the stream to avoid dangling connections
  es.onerror = () => {
    es.close();
  };

  return es;
}

/**
 * Fetch all chats with their scope state (Sources / onboarding).
 * @returns {Promise<Array<{group: string, source: string, messageCount: number, lastMessageAt: string|null, included: boolean, categoryId: number|null, removed: boolean}>>}
 */
export function getScopes() {
  return fetch("/api/scopes").then((r) => {
    if (!r.ok) throw new Error(`scopes ${r.status}`);
    return r.json();
  });
}

/**
 * Apply a batch of scope updates. Same-origin (cookies + JSON) so the CSRF guard passes.
 * @param {Array<{group: string, included?: boolean, categoryId?: number|null, removed?: boolean}>} updates
 * @returns {Promise<{updated: number}>}
 */
export function putScopes(updates) {
  return fetch("/api/scopes", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates }),
  }).then((r) => {
    if (!r.ok) throw new Error(`putScopes ${r.status}`);
    return r.json();
  });
}

/**
 * Fetch the tenant's scope categories.
 * @returns {Promise<Array<{id: number, name: string, isSystem: boolean, sortOrder: number}>>}
 */
export function getScopeCategories() {
  return fetch("/api/scope-categories").then((r) => {
    if (!r.ok) throw new Error(`scope-categories ${r.status}`);
    return r.json();
  });
}

/**
 * Create a scope category.
 * @param {string} name
 * @returns {Promise<{id: number, name: string, isSystem: boolean, sortOrder: number}>}
 */
export function createScopeCategory(name) {
  return fetch("/api/scope-categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => {
    if (!r.ok) throw new Error(`createScopeCategory ${r.status}`);
    return r.json();
  });
}

/**
 * The current /סיכום trigger plus all groups with their command permission.
 * @returns {Promise<{ trigger: string, groups: Array<{ groupId: number, name: string, whatsappId: string, enabled: boolean }> }>}
 */
export function getSummaryCommands() {
  return fetch("/api/summary-commands").then((r) => {
    if (!r.ok) throw new Error(`getSummaryCommands ${r.status}`);
    return r.json();
  });
}

/**
 * Toggle a group's /סיכום permission. Picked up by the next matching message —
 * the collector reads the DB live, no reload needed.
 * @param {number} groupId
 * @param {boolean} enabled
 * @returns {Promise<{ ok: boolean }>}
 */
export function toggleSummaryCommand(groupId, enabled) {
  return fetch("/api/summary-commands", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId, enabled }),
  }).then((r) => {
    if (!r.ok) throw new Error(`toggleSummaryCommand ${r.status}`);
    return r.json();
  });
}

/**
 * Update the /סיכום trigger text. Picked up by the next matching message —
 * the collector reads the DB live, no reload needed.
 * @param {string} trigger
 * @returns {Promise<{ ok: boolean }>}
 */
export function setSummaryTrigger(trigger) {
  return fetch("/api/summary-commands", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trigger }),
  }).then((r) => {
    if (!r.ok) throw new Error(`setSummaryTrigger ${r.status}`);
    return r.json();
  });
}

