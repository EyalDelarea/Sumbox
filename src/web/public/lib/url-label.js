/**
 * url-label.js — compact display labels for URL values in artifact cells.
 *
 * Browser ES module (plain JS, no DOM). The agent copies raw links into artifact
 * cells (e.g. booking.com tracking URLs with a huge query string); these helpers
 * let the UI show a clean, clickable label while the full URL stays the href.
 */

const MAX_LABEL = 48;

/** True only when the WHOLE trimmed value is a single http/https URL (no spaces). */
export function isHttpUrl(value) {
  const s = (value ?? "").trim();
  if (!s || /\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A compact label for a URL: `host` (without `www.`) + `pathname`, with the query
 * string and hash dropped, truncated with an ellipsis. Falls back to the raw input
 * if it can't be parsed.
 */
export function compactUrlLabel(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname.replace(/\/$/, ""); // drop a trailing slash
  const label = host + path; // search + hash deliberately omitted
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}
