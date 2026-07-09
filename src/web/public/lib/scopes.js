// ── Sources view-logic (pure) ───────────────────────────
//
// Deterministic selectors over the /api/scopes payload, kept out of the DOM
// layer so they can be unit-tested. A scope is:
//   { group, source, messageCount, lastMessageAt, included, categoryId, removed }

/**
 * Active scopes (removed excluded) matching a name query + segment.
 * @param {Array} scopes
 * @param {{query: string, segment: "all"|"included"|"excluded"}} opts
 */
export function filterScopes(scopes, { query, segment }) {
  const q = (query || "").trim().toLowerCase();
  return scopes
    .filter((s) => !s.removed)
    .filter((s) => (q ? s.group.toLowerCase().includes(q) : true))
    .filter((s) => {
      if (segment === "included") return s.included;
      if (segment === "excluded") return !s.included;
      return true; // "all"
    });
}

/** Split scopes into active (shown in sections) and removed (the "הוסרו" section). */
export function partitionRemoved(scopes) {
  const active = [];
  const removed = [];
  for (const s of scopes) (s.removed ? removed : active).push(s);
  return { active, removed };
}

/**
 * Group active scopes into category sections (ordered by sortOrder), preserving
 * empty user-created categories. An "uncategorized" bucket (category: null) is
 * appended only when at least one scope has no category.
 * @returns {Array<{category: object|null, scopes: Array}>}
 */
export function groupByCategory(scopes, categories) {
  const ordered = [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const sections = ordered.map((category) => ({
    category,
    scopes: scopes.filter((s) => s.categoryId === category.id),
  }));
  const uncategorized = scopes.filter((s) => s.categoryId == null);
  if (uncategorized.length) sections.push({ category: null, scopes: uncategorized });
  return sections;
}

/** The "N/M פעילים" counter: included non-removed over non-removed total. */
export function activeCount(scopes) {
  const live = scopes.filter((s) => !s.removed);
  return { active: live.filter((s) => s.included).length, total: live.length };
}

/** Per-section included count. */
export function sectionCount(scopes) {
  return scopes.filter((s) => s.included && !s.removed).length;
}
