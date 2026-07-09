/**
 * app.js — Elevated Glacier UI · Sumbox
 *
 * Persistent two-pane shell:
 *   #top-bar   — brand + core-features row (AMA + total) + health pill
 *   #pane-list — search + group list (the right sidebar on desktop)
 *   #pane-main — detail | total | ama content
 *
 * Visible pane is CSS-driven by #layout[data-view]. On mobile one pane shows at
 * a time (feed ↔ detail/total/ama); on desktop both panes show together.
 *
 * View state machine: feed ↔ detail{group} ↔ total ↔ ama{scope?}
 * Routing: history.pushState + popstate (phone Back works)
 * Teardown: EventSource is closed when leaving a streaming view
 */

import { createScopeCategory, getGroups, getMessages, getScopeCategories, getScopes, getStatus, getSummaries, getSummaryCommands, putScopes, rateSummary, setSummaryTrigger, summarizeStream, toggleSummaryCommand } from "./lib/api.js";
import { activeCount, filterScopes, groupByCategory, partitionRemoved, sectionCount } from "./lib/scopes.js";
import { formatAgo, presetToSince, validateRangeInput } from "./lib/time.js";
import { renderInline, renderMarkdown, toWhatsAppText } from "./lib/markdown.js";
import { deriveHealth } from "./lib/health.js";
import { shouldStartBackgroundRefresh } from "./lib/open-state.js";
import { scanFill } from "./lib/phase-loader.js";
import { compactUrlLabel, isHttpUrl } from "./lib/url-label.js";
import { DEMO_GROUPS, DEMO_STRUCTURED, DEMO_SUMMARY, DEMO_SUMMARIES, DEMO_SUMMARY_COMMANDS, DEMO_TOTAL_HIGHLIGHTS, DEMO_TOTAL_PERCHAT } from "./lib/demo-data.js";
import { applyTheme, readStoredTheme, resolveInitialTheme, setTheme } from "./lib/theme.js";
import { icon } from "./lib/icons.js";

/** Off by default. `?demo=1` previews dummy data; `?demo=tube` shows the loader. */
const DEMO = new URLSearchParams(location.search).get("demo");

/* ── 1. Globals ──────────────────────────────────────────── */

const layout = document.getElementById("layout");
const topBar = document.getElementById("top-bar");
const paneList = document.getElementById("pane-list");
const paneMain = document.getElementById("pane-main");
const botNav = document.getElementById("botnav");
const staleBanner = document.getElementById("stale-banner");

/** Active theme ("light" | "dark"). The pre-paint snippet in index.html already
 *  reflected this onto <html>; we resolve it again here to drive the toggle. */
let currentTheme = resolveInitialTheme(
  readStoredTheme(),
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
);
applyTheme(currentTheme);

/** Currently open EventSource (cleaned up on view change). */
let activeEventSource = null;
/** Total-view loader elapsed-timer handle. */
let totalLoaderTimer = null;
/** Health poll interval id. */
let healthInterval = null;
/** Cached groups list. */
let cachedGroups = [];
/** Updates (§3) category filter + the category list backing its chips. */
let sumboxFilter = "הכול";
let sumboxCategories = [];

/* ── 2. Routing & nav model ──────────────────────────────── */

/** The "me" card shown in the nav rail. Single-user has no real profile, so this
 *  is a neutral, privacy-consistent placeholder mirroring the prototype card. */
const ME = { name: "החשבון שלי", sub: "מחובר · וואטסאפ", hue: 280 };

/** Vertical nav rail items (prototype order). `count` badges are filled lazily
 *  by the screen loaders via setNavCount(); omit when unknown. */
const NAV = [
  { id: "sumbox", label: "עדכונים", icon: "inbox" },
  { id: "sources", label: "צ׳אטים", icon: "filter" },
  { id: "commands", label: "פקודות", icon: "send" },
];

/** Mobile bottom-nav: the most-used surfaces. */
const BOTNAV = ["sumbox"];

/** Appbar title + subtitle per screen. `sub` may be a function (dynamic date). */
const META = {
  sumbox: { title: "עדכונים", sub: "מה פספסת — סיכומים במקום גלילה" },
  detail: { title: "עדכונים", sub: "מה פספסת — סיכומים במקום גלילה" },
  thread: { title: "השיחה המלאה", sub: "ההודעה שהסיכום הצביע עליה" },
  sources: { title: "צ׳אטים", sub: "בחרו אילו שיחות מזינות את Sumbox" },
  commands: { title: "פקודות", sub: "ניהול פקודת /סיכום בקבוצות" },
  total: { title: "סיכום כללי", sub: "מה קרה בכל הצ׳אטים" },
};

/** Which nav item is highlighted for a given view. */
function navIdForView(view) {
  if (view === "detail") return "sumbox";
  if (view === "thread") return "sumbox";
  return view;
}

/** Set the visible-pane hint for CSS (mobile pane visibility / residual styling). */
function setView(view) {
  if (layout) layout.dataset.view = view;
  setActiveNav(navIdForView(view));
}

/**
 * Navigate to a view, pushing a history entry.
 * @param {"sumbox"|"detail"|"total"|"thread"|"sources"|"commands"} view
 * @param {string|object} [arg] — group name (detail) or {chat,aroundId} (thread)
 */
function navigate(view, arg) {
  if (view === "sumbox") {
    history.pushState({ view: "sumbox" }, "", "#sumbox");
    renderSumbox();
  } else if (view === "detail" && arg) {
    history.pushState({ view: "detail", group: arg }, "", `#group=${encodeURIComponent(arg)}`);
    renderDetail(arg, true);
  } else if (view === "total") {
    history.pushState({ view: "total" }, "", "#total");
    renderTotal(true);
  } else if (view === "thread" && arg) {
    history.pushState(
      { view: "thread", chat: arg.chat, aroundId: arg.aroundId },
      "",
      `#thread=${encodeURIComponent(arg.chat)}&m=${arg.aroundId}`,
    );
    renderThread(arg.chat, arg.aroundId);
  } else if (view === "sources") {
    history.pushState({ view: "sources" }, "", "#sources");
    renderSources();
  } else if (view === "commands") {
    history.pushState({ view: "commands" }, "", "#commands");
    renderCommands();
  } else {
    history.pushState({ view: "sumbox" }, "", "#sumbox");
    renderSumbox();
  }
}

window.addEventListener("popstate", (e) => {
  teardownStream();
  const state = e.state;
  if (state?.view === "sumbox") {
    renderSumbox();
  } else if (state?.view === "detail" && state.group) {
    renderDetail(state.group, false);
  } else if (state?.view === "total") {
    renderTotal(false);
  } else if (state?.view === "sources") {
    renderSources();
  } else if (state?.view === "thread" && state.chat) {
    renderThread(state.chat, state.aroundId);
  } else {
    renderSumbox();
  }
});

/* ── 3. Health polling ───────────────────────────────────── */

function applyHealth(healthy) {
  staleBanner.hidden = !!healthy;
  document.querySelectorAll(".health-pill").forEach((pill) => {
    const dot = pill.querySelector(".health-pill__dot");
    pill.textContent = "";
    const d = dot || document.createElement("span");
    d.className = "health-pill__dot";
    pill.appendChild(d);
    if (healthy) {
      pill.classList.remove("health-pill--bad");
      pill.appendChild(document.createTextNode("המערכת תקינה"));
    } else {
      pill.classList.add("health-pill--bad");
      pill.appendChild(document.createTextNode("לא מגיב"));
    }
  });
}

async function pollHealth() {
  try {
    applyHealth(deriveHealth(await getStatus()));
  } catch {
    applyHealth(false);
  }
}

function startHealthPolling() {
  if (healthInterval) return;
  pollHealth();
  healthInterval = setInterval(pollHealth, 5_000);
}

/* ── 4. Shell: nav rail + appbar + mobile bottom nav ─────── */

/** The Sumbox brand mark — "זינוק" (swoosh): a speech bubble with motion
 *  lines ("catch up fast"), the logo the team locked in. `d3` adds the 3D
 *  app-icon treatment used on large/login surfaces. */
function brandGlyph(size = 34, { d3 = false } = {}) {
  const r = Math.round(size * 0.29);
  return (
    `<div class="bglyph v-swoosh${d3 ? " d3" : ""}" style="width:${size}px;height:${size}px;border-radius:${r}px;font-size:${size}px">`
    + `<svg class="lg-svg" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path d="M2.5 8.6 H6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".42"/>`
    + `<path d="M1.6 12.6 H5.6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".42"/>`
    + `<path d="M10 5 h8.4 a2.8 2.8 0 0 1 2.8 2.8 v5 a2.8 2.8 0 0 1 -2.8 2.8 h-4.4 l-4 3 v-3 a2.8 2.8 0 0 1 -2.8 -2.8 V7.8 A2.8 2.8 0 0 1 10 5 z" fill="currentColor"/>`
    + `</svg></div>`
  );
}

/** Initials + per-entity oklch tint disc (matches the prototype Avatar). */
function avatarHtml(name, hue = 150, size = 36) {
  const initials = (name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("");
  return (
    `<div class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;`
    + `background:oklch(0.93 0.045 ${hue});color:oklch(0.42 0.09 ${hue})">${escHtml(initials)}</div>`
  );
}

/** Render the persistent shell once at boot: nav rail + bottom nav. */
function renderShell() {
  paneList.innerHTML = navRailHtml();
  topBar.innerHTML = "";
  if (botNav) botNav.innerHTML = botnavHtml();
  for (const el of paneList.querySelectorAll("[data-nav-id]")) {
    el.addEventListener("click", () => navigate(el.dataset.navId));
  }
  for (const el of botNav?.querySelectorAll("[data-nav-id]") ?? []) {
    el.addEventListener("click", () => navigate(el.dataset.navId));
  }
}

function navRailHtml() {
  const links = NAV.map((n) => `
    <button class="navlink" type="button" data-nav-id="${n.id}" aria-label="${escHtml(n.label)}">
      ${icon(n.icon, { size: 20 })}
      <span>${escHtml(n.label)}</span>
      <span class="count" data-count="${n.id}" hidden></span>
    </button>`).join("");
  return `
    <div class="side-brand">
      ${brandGlyph(34)}
      <div class="wordmark"><b style="font-size:16px">Sumbox</b><small>וואטסאפ, בלי הרעש</small></div>
    </div>
    ${links}
    <div class="side-foot">
      <div class="privacy-card">
        ${icon("lock", { size: 18 })}
        <div><b>הכול נשאר אצלך</b><p>מאוחסן במכשיר · לא נשלח החוצה</p></div>
      </div>
      <div class="side-user">
        ${avatarHtml(ME.name, ME.hue, 36)}
        <div style="min-width:0">
          <div style="font-weight:700;font-size:14px">${escHtml(ME.name)}</div>
          <div class="mono" dir="ltr" style="font-size:11px;color:var(--muted)">${escHtml(ME.sub)}</div>
        </div>
      </div>
    </div>`;
}

function botnavHtml() {
  return BOTNAV.map((id) => {
    const n = NAV.find((x) => x.id === id);
    return `<button type="button" data-nav-id="${id}" aria-label="${escHtml(n.label)}">${icon(n.icon, { size: 21 })}<span>${escHtml(n.label)}</span></button>`;
  }).join("");
}

/** Highlight the active nav item (rail + bottom nav). */
function setActiveNav(id) {
  for (const el of document.querySelectorAll("#pane-list .navlink")) {
    el.classList.toggle("on", el.dataset.navId === id);
  }
  for (const el of document.querySelectorAll("#botnav button")) {
    el.classList.toggle("on", el.dataset.navId === id);
  }
}

/** Fill or clear a nav count badge. */
function setNavCount(id, n) {
  for (const el of document.querySelectorAll(`.count[data-count="${id}"]`)) {
    if (n && n > 0) {
      el.textContent = String(n);
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }
}

/** Appbar header for the current screen: title + subtitle + action icons + optional back. */
function setAppbar(view, { back, title, sub: subOverride } = {}) {
  const m = META[view] || { title: "", sub: "" };
  const resolvedTitle = title ?? m.title;
  const sub = subOverride ?? (typeof m.sub === "function" ? m.sub() : m.sub);
  const backBtn = back
    ? `<button class="iconbtn" id="appbar-back" type="button" aria-label="חזרה">${icon("chevR", { size: 19 })}</button>`
    : "";
  topBar.innerHTML = `
    ${backBtn}
    <div>
      <h1>${escHtml(resolvedTitle)}</h1>
      ${sub ? `<div class="sub">${sub}</div>` : ""}
    </div>
    <div class="acts">
      <button class="iconbtn" id="appbar-search" type="button" aria-label="חיפוש">${icon("search", { size: 19 })}</button>
      <button class="iconbtn" id="appbar-theme" type="button" aria-label="החלפת ערכת צבעים">${icon(currentTheme === "dark" ? "sun" : "moon", { size: 19 })}</button>
    </div>`;
  document.getElementById("appbar-back")?.addEventListener("click", () => history.back());
  document.getElementById("appbar-search")?.addEventListener("click", () => navigate("sumbox"));
  document.getElementById("appbar-theme")?.addEventListener("click", toggleTheme);
}

/** Flip + persist the theme; refresh the appbar toggle icon in place. */
function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  setTheme(currentTheme);
  const btn = document.getElementById("appbar-theme");
  if (btn) btn.innerHTML = icon(currentTheme === "dark" ? "sun" : "moon", { size: 19 });
}

/** Chats with at least one message since their last summary — the עדכונים badge.
 *  Mirrors the per-card "N חדשות" signal (g.newCount) so the badge reflects what's
 *  actually new to catch up on, not the static count of monitored chats. */
function newUpdatesCount(groups) {
  return groups.filter((g) => (g.newCount ?? g.n ?? 0) > 0).length;
}

/** Fetch groups (scope-filtered) into the cache + the עדכונים nav badge. */
async function loadGroupsIntoList() {
  if (DEMO) {
    cachedGroups = DEMO_GROUPS;
    setNavCount("sumbox", newUpdatesCount(cachedGroups));
    return;
  }
  let groups;
  try {
    groups = await getGroups();
  } catch {
    return;
  }
  // Scope filter (S4 §3): hide excluded/removed chats. Resilient — on any scope
  // failure, fall back to showing all groups (default-on).
  try {
    const byName = new Map((await getScopes()).map((s) => [s.group, s]));
    groups = groups
      .filter((g) => {
        const s = byName.get(g.name);
        return s ? s.included && !s.removed : false;
      })
      .map((g) => ({ ...g, categoryId: byName.get(g.name)?.categoryId ?? null }));
  } catch {
    /* show all on scope-load failure */
  }
  cachedGroups = groups;
  setNavCount("sumbox", newUpdatesCount(cachedGroups));
}

/** True if the group had activity within the last 24h. */
function isFreshGroup(group) {
  return group.lastMessageAt
    ? Date.now() - new Date(group.lastMessageAt).getTime() < 24 * 60 * 60 * 1000
    : false;
}

/** Deterministic per-name avatar hue (stable across renders). */
function hueFromName(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Per-group avatar hue, stable from the name (used by artifact-table avatars). */
function groupHue(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/* ── 4b. Updates (עדכונים) — list-first catch-up ─────────── */
//
// The catch-up surface: a list of fed chats, each a card with a one-line
// summary. Tapping a card opens the structured summary-first chat (renderDetail).

async function renderSumbox() {
  teardownStream();
  setView("sumbox");
  setAppbar("sumbox");
  paneMain.innerHTML = `<div class="content"><p class="thread-loading">טוען עדכונים…</p></div>`;

  if (cachedGroups.length === 0 && !DEMO) await loadGroupsIntoList();
  if (!DEMO && sumboxCategories.length === 0) {
    try {
      sumboxCategories = await getScopeCategories();
    } catch {
      /* chips fall back to just "הכול" */
    }
  }
  const groups = cachedGroups;

  if (!groups.length) {
    paneMain.innerHTML = `
      <div class="content">
        <div class="empty">
          <div class="empty-ic">${icon("filter", { size: 26 })}</div>
          <h3>אין צ׳אטים מוזנים</h3>
          <p>כל הצ׳אטים שלך מוחרגים כרגע. הוסיפו לפחות צ׳אט אחד כדי לראות עדכונים.</p>
          <button class="btn btn-soft" id="sumbox-manage" type="button">${icon("filter", { size: 15 })}נהל צ׳אטים</button>
        </div>
      </div>`;
    document.getElementById("sumbox-manage")?.addEventListener("click", () => navigate("sources"));
    return;
  }

  // Category chips: "הכול" + any category that has at least one included chat.
  const usedCatIds = new Set(groups.map((g) => g.categoryId).filter((id) => id != null));
  const catChips = sumboxCategories
    .filter((c) => usedCatIds.has(c.id))
    .map((c) => ({ name: c.name, id: c.id }));
  const filterNames = ["הכול", ...catChips.map((c) => c.name)];
  if (!filterNames.includes(sumboxFilter)) sumboxFilter = "הכול";

  const visible =
    sumboxFilter === "הכול"
      ? groups
      : groups.filter((g) => catChips.find((c) => c.name === sumboxFilter)?.id === g.categoryId);

  const chips = filterNames
    .map((n) => `<span class="chip${n === sumboxFilter ? " on" : ""}" data-filter="${escHtml(n)}">${escHtml(n)}</span>`)
    .join("");

  const listOrEmpty =
    visible.length === 0
      ? `<div class="empty">
          <div class="empty-ic">${icon("inbox", { size: 26 })}</div>
          <h3>אין עדכונים בקטגוריה זו</h3>
          <p>נסו קטגוריה אחרת, או הוסיפו עוד צ׳אטים לקבוצה הזו.</p>
        </div>`
      : `<div class="list">${visible.map((g) => buildUpdateCard(g)).join("")}</div>`;

  paneMain.innerHTML = `
    <div class="content">
      <div class="filters">
        <span class="muted" style="font-size:13px;font-weight:700">קבץ לפי:</span>
        ${chips}
        <span class="chip cat-manage" id="sumbox-manage">${icon("filter", { size: 14 })}נהל צ׳אטים</span>
      </div>
      ${listOrEmpty}
    </div>`;
  document.getElementById("sumbox-manage")?.addEventListener("click", () => navigate("sources"));
  paneMain.querySelector(".filters")?.addEventListener("click", (e) => {
    const ch = e.target.closest(".chip[data-filter]");
    if (!ch) return;
    sumboxFilter = ch.dataset.filter;
    renderSumbox();
  });
  for (const card of paneMain.querySelectorAll(".itemcard[data-group]")) {
    card.addEventListener("click", () => navigate("detail", card.dataset.group));
  }
}

function buildUpdateCard(g) {
  const name = formatGroupName(g.name);
  const hue = g.hue ?? hueFromName(g.name);
  const sum = g.summaryPreview || "הקישו לסיכום מה שפספסתם בשיחה הזו.";
  const n = g.newCount ?? g.n;
  const newBadge = n ? `<span class="badge accent">${n} חדשות</span>` : "";
  const ago = g.lastMessageAt ? formatAgo(g.lastMessageAt) : "";
  return `
    <div class="itemcard surface" data-group="${escHtml(g.name)}" role="button" tabindex="0">
      ${avatarHtml(name, hue, 40)}
      <div class="grow">
        <h4>${escHtml(name)}${newBadge}</h4>
        <p>${escHtml(sum)}</p>
        ${ago ? `<div class="meta"><span class="muted" style="font-size:12px;font-weight:600">${escHtml(ago)}</span></div>` : ""}
      </div>
      <span class="btn btn-soft" style="align-self:center">פתח ${icon("chevL", { size: 15 })}</span>
    </div>`;
}

/* ── 5. Detail view ──────────────────────────────────────── */

const detailState = {
  group: null,
  started: 0,
  syncingTimer: null,
  syncingStart: 0,
  summaryText: "",
  phase: "idle",
  activeChip: "sumbox",
  cachedSummaryText: null,
  showingCachedCard: false,
  backgroundRefreshStarted: false,
};

function renderDetail(group, autoStart) {
  teardownStream();
  const meta = cachedGroups.find((g) => g.name === group) || { name: group };
  const ago = formatAgo(meta.lastMessageAt);
  const fresh = isFreshGroup(meta);

  detailState.group = group;
  detailState.summaryText = "";
  detailState.phase = "idle";
  detailState.activeChip = "sumbox";
  detailState.cachedSummaryText = null;
  detailState.showingCachedCard = false;
  detailState.backgroundRefreshStarted = false;

  paneMain.innerHTML = buildDetailShell(group);
  setView("detail");
  setAppbar("detail", {
    back: true,
    title: formatGroupName(group),
    sub: fresh
      ? `<span class="dot-live"></span>פעיל${ago ? ` · ${escHtml(ago)}` : ""}`
      : escHtml(ago),
  });
  wireDetailButtons(group);
  if (!DEMO) loadHistory(group);

  if (autoStart) {
    setActiveChip("sumbox");
    if (DEMO) {
      if (DEMO === "tube") {
        setSummaryRegion(buildPhaseTube({ phase: "read", messages: 247, elapsed: 12 }));
      } else if (DEMO_STRUCTURED[group]) {
        // Showcase the structured (topics/decisions/open-questions) card — the
        // shape the real summarizer emits — when a tailored entry exists.
        setSummaryRegion(buildStructuredSummaryCard(DEMO_STRUCTURED[group], "סיכום · נוצר היום 08:00 · 247 הודעות", false));
      } else {
        setSummaryRegion(buildSummaryCardDone(DEMO_SUMMARIES[group] || DEMO_SUMMARY, "נשמר • 8.4 שניות • 247 הודעות", false));
      }
      return;
    }
    void runDetailWithCacheFirst(group);
  }
}

async function runDetailWithCacheFirst(group) {
  let cached = null;
  try {
    const history = await getSummaries(group, 1);
    if (history && history.length > 0 && history[0].output?.overview) cached = history[0];
  } catch {
    /* fall through to cold open */
  }

  if (cached) {
    detailState.cachedSummaryText = cached.output.overview;
    detailState.summaryText = cached.output.overview; // so copy works on the cached card
    detailState.showingCachedCard = true;
    const statusText = `מהמטמון • נוצר ב־${fmtTime(cached.createdAt)}`;
    setSummaryRegion(buildStructuredSummaryCard(cached.output, statusText, false, cached.id));
    const openedGroup = group;
    setTimeout(() => {
      if (shouldStartBackgroundRefresh({
        hasCached: true,
        openedGroup,
        currentDetailGroup: detailState.group,
        backgroundRefreshStarted: detailState.backgroundRefreshStarted,
      })) {
        detailState.backgroundRefreshStarted = true;
        runSummary({ mode: "sumbox", group: openedGroup }, true);
      }
    }, 400);
  } else {
    runSummary({ mode: "sumbox", group }, false);
  }
}

function buildDetailShell(group) {
  // The chat identity (avatar/name/live/back) lives in the appbar (set in
  // renderDetail) — here we render the design's summary-first body: time-range
  // chips (.sum-ranges) + the structured .sum-card region + history + ask bar.
  const ranges = [
    ["sumbox", "מה שפספסתי"],
    ["24h", "24 שעות"],
    ["3d", "3 ימים"],
    ["week", "שבוע"],
    ["month", "חודש"],
    ["range", "טווח…"],
  ];
  const chips = ranges
    .map(
      ([k, l]) =>
        `<span class="chip${k === "sumbox" ? " on" : ""}" data-chip="${k}" role="button" tabindex="0" aria-pressed="${k === "sumbox"}">${l}</span>`,
    )
    .join("");
  return `
    <div class="detail-view">
      <div class="sum-ranges" role="group" aria-label="בחירת טווח זמן" id="mode-chips">${chips}</div>

      <div id="summary-region" aria-live="polite" aria-atomic="false"></div>

      <div id="range-sheet" class="range-sheet" aria-modal="true" role="dialog" aria-label="בחירת טווח זמן" hidden>
        <div class="range-sheet__handle" aria-hidden="true"></div>
        <h4 class="range-sheet__title">בחירת טווח</h4>
        <div class="range-sheet__field">
          <label class="range-sheet__label" for="range-datetime">📅 מתאריך ושעה</label>
          <input id="range-datetime" class="range-sheet__input" type="datetime-local" aria-label="תאריך ושעה התחלה" />
        </div>
        <div class="range-sheet__until">
          <span class="range-sheet__until-label">עד:</span>
          <span class="range-sheet__until-val">עכשיו</span>
        </div>
        <div class="range-sheet__divider" aria-hidden="true">— או —</div>
        <div class="range-sheet__field">
          <label class="range-sheet__label" for="range-lastn">📩 הודעות אחרונות</label>
          <input id="range-lastn" class="range-sheet__input" type="number" min="1" step="1"
            placeholder="לדוגמה: 100" aria-label="מספר הודעות אחרונות" />
        </div>
        <p id="range-error" class="range-sheet__error" aria-live="polite" hidden></p>
        <button class="range-sheet__go" id="range-go">סכם את הטווח הזה</button>
        <button class="range-sheet__cancel" id="range-cancel">ביטול</button>
      </div>

      <section class="history-section" id="history-section" aria-label="סיכומים קודמים">
        <div id="history-list" class="history-list" aria-live="polite" hidden></div>
      </section>
    </div>
  `;
}

function wireDetailButtons(group) {
  document.getElementById("back-btn")?.addEventListener("click", () => navigate("feed"));
  document.getElementById("mode-chips")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip[data-chip]");
    if (btn) onChipClick(btn.dataset.chip);
  });
  document.getElementById("range-go")?.addEventListener("click", () => onRangeSubmit());
  document.getElementById("range-cancel")?.addEventListener("click", () => closeRangeSheet());
  // Source-jump: a structured-summary bullet → the chat thread, pulsing the source.
  document.getElementById("summary-region")?.addEventListener("click", (e) => {
    const jump = e.target.closest?.(".sum-jump");
    if (!jump || !detailState.group) return;
    const id = Number(jump.dataset.id);
    if (Number.isFinite(id)) navigate("thread", { chat: detailState.group, aroundId: id });
  });
}

function onChipClick(chip) {
  if (chip === "range") {
    setActiveChip("range");
    openRangeSheet();
    return;
  }
  closeRangeSheet();
  setActiveChip(chip);
  if (chip === "sumbox") {
    runSummary({ mode: "sumbox", group: detailState.group });
  } else {
    runSummary({ since: presetToSince(chip), group: detailState.group });
  }
}

function setActiveChip(chip) {
  detailState.activeChip = chip;
  const container = document.getElementById("mode-chips");
  if (!container) return;
  container.querySelectorAll(".chip[data-chip]").forEach((btn) => {
    const isActive = btn.dataset.chip === chip;
    btn.classList.toggle("on", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

/* ── 5a. Range sheet ─────────────────────────────────────── */

function openRangeSheet() {
  const sheet = document.getElementById("range-sheet");
  if (!sheet) return;
  sheet.hidden = false;
  const err = document.getElementById("range-error");
  if (err) { err.hidden = true; err.textContent = ""; }
  document.getElementById("range-datetime")?.focus();
}

function closeRangeSheet() {
  const sheet = document.getElementById("range-sheet");
  if (sheet) sheet.hidden = true;
}

function onRangeSubmit() {
  const datetime = document.getElementById("range-datetime")?.value || "";
  const lastNRaw = (document.getElementById("range-lastn")?.value || "").trim();
  const errEl = document.getElementById("range-error");

  let result;
  if (lastNRaw !== "") {
    const n = parseInt(lastNRaw, 10);
    result = validateRangeInput({ mode: "last", n: isNaN(n) ? null : n });
  } else {
    result = validateRangeInput({ mode: "since", datetime });
  }

  if (!result.ok) {
    if (errEl) { errEl.textContent = result.error; errEl.hidden = false; }
    return;
  }
  closeRangeSheet();
  if (result.last !== undefined) {
    runSummary({ last: result.last, group: detailState.group });
  } else {
    runSummary({ since: result.since, group: detailState.group });
  }
}

/* ── 5b. runSummary — generic streaming runner ───────────── */

function runSummary(params, background = false) {
  teardownStream();
  if (!detailState.group) return;

  detailState.started = Date.now();
  detailState.syncingTimer = null;
  detailState.syncingStart = 0;
  detailState.summaryText = "";
  detailState.phase = "streaming";

  if (!background) {
    detailState.cachedSummaryText = null;
    detailState.showingCachedCard = false;
    showUpdatingChip(false);
    setSummaryRegion(buildPhaseTube({ phase: "sync", elapsed: 0 }));
  }
  if (background && detailState.showingCachedCard) showUpdatingChip(true);

  activeEventSource = summarizeStream(params, {
    syncing: onSyncing,
    status: onStatus,
    token: onToken,
    cached: onCached,
    empty: onEmpty,
    done: onDone,
    error: onError,
  });
}

function teardownStream() {
  if (detailState.syncingTimer) { clearInterval(detailState.syncingTimer); detailState.syncingTimer = null; }
  if (totalLoaderTimer) { clearInterval(totalLoaderTimer); totalLoaderTimer = null; }
  if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
}

/* ── 5c. SSE event handlers ──────────────────────────────── */

function onSyncing(data) {
  if (detailState.showingCachedCard) return;
  if (data.phase === "start") {
    detailState.syncingStart = Date.now();
    setSummaryRegion(buildPhaseTube({ phase: "sync", elapsed: 0 }));
    detailState.syncingTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - detailState.syncingStart) / 1000);
      setTubeElapsed(elapsed);
    }, 500);
  } else if (data.phase === "done") {
    clearSyncingTimer();
    setSummaryRegion(buildPhaseTube({ phase: "read", elapsed: Math.round(data.fetchMs / 1000), messages: data.fetched }));
  }
}

function onStatus(data) {
  if (detailState.showingCachedCard) { clearSyncingTimer(); return; }
  clearSyncingTimer();
  const elapsed = detailState.started ? Math.round((Date.now() - detailState.started) / 1000) : 0;
  const mediaJobsAhead = typeof data.mediaJobsAhead === "number" ? data.mediaJobsAhead : 0;
  setSummaryRegion(buildPhaseTube({ phase: "read", messages: data.messages || 0, elapsed, mediaJobsAhead }));
  detailState.syncingTimer = setInterval(() => {
    const secs = detailState.started ? Math.round((Date.now() - detailState.started) / 1000) : 0;
    setTubeElapsed(secs);
  }, 1000);
}

function onToken(data) {
  if (detailState.showingCachedCard) { detailState.summaryText += data.delta; return; }
  detailState.summaryText += data.delta;
  let body = document.querySelector(".summary-card--streaming .summary-card__body");
  if (!body) {
    setSummaryRegion(buildSummaryCardStreaming(detailState.summaryText, ""));
    body = document.querySelector(".summary-card--streaming .summary-card__body");
  } else {
    body.innerHTML = `${renderMarkdown(detailState.summaryText)}<span class="caret" aria-hidden="true"></span>`;
    body.scrollTop = body.scrollHeight;
  }
}

function onCached(data) {
  clearSyncingTimer();
  detailState.phase = "cached";
  if (detailState.showingCachedCard) {
    showUpdatingChip(false);
    detailState.showingCachedCard = false;
    teardownStream();
    return;
  }
  // `data.summary` is a normalized structured summary (same shape as `done`) —
  // render the §3 card, not the legacy markdown card. `summaryText` keeps the
  // full overview so "העתק סיכום" still copies the verbatim summary.
  detailState.summaryText = data.summary?.overview ?? "";
  const statusText = `אין חדש — מתוך מטמון • נוצר ב־${fmtTime(data.generatedAt)}`;
  setSummaryRegion(buildStructuredSummaryCard(data.summary, statusText, false, data.summaryId));
  teardownStream();
}

function onEmpty() {
  clearSyncingTimer();
  detailState.phase = "empty";
  if (detailState.showingCachedCard) {
    showUpdatingChip(false);
    detailState.showingCachedCard = false;
    teardownStream();
    return;
  }
  setSummaryRegion(buildEmptyResult());
  teardownStream();
}

function onDone(data) {
  clearSyncingTimer();
  detailState.phase = "done";
  const totalSec = ((Date.now() - detailState.started) / 1000).toFixed(1);
  const parts = [`נשמר • ${totalSec} שניות`];
  if (data.fetchMs > 0) parts.push(`טעינה ${(data.fetchMs / 1000).toFixed(1)}ש׳ (${data.fetched} הודעות)`);
  if (data.summarizeMs) parts.push(`סיכום ${(data.summarizeMs / 1000).toFixed(1)}ש׳`);
  showUpdatingChip(false);
  detailState.showingCachedCard = false;
  // Prefer the structured summary carried on `done`; keep summaryText as the full
  // markdown so the copy button still copies the verbatim summary.
  if (data.summary?.overview) detailState.summaryText = data.summary.overview;
  const statusText = parts.join(" • ");
  setSummaryRegion(
    data.summary
      ? buildStructuredSummaryCard(data.summary, statusText, !!data.stale, data.summaryId)
      : buildSummaryCardDone(detailState.summaryText, statusText, !!data.stale),
  );
  teardownStream();
  if (detailState.group) loadHistory(detailState.group);
}

function onError(data) {
  clearSyncingTimer();
  detailState.phase = "error";
  if (detailState.showingCachedCard) {
    showUpdatingChip(false);
    teardownStream();
    return;
  }
  const msg = data?.message || "שגיאת חיבור.";
  setSummaryRegion(`<p class="detail-status detail-status--error" role="alert">${escHtml(msg)}</p>`);
  teardownStream();
}

/* ── 5d. Phase Tube + summary builders ───────────────────── */

/**
 * The playful "summarizing" loader (.sumload): a bobbing brand glyph in a
 * pulsing ring, orbiting dots, rising chat bubbles, twinkling sparkles and an
 * indeterminate bar. All motion is CSS and gated behind prefers-reduced-motion.
 */
function buildSumLoader(title, quip, compact = false) {
  return `
    <div class="sumload${compact ? " sumload--compact" : ""}" role="status" aria-live="polite" aria-label="${escHtml(title)}">
      <div class="sumload-scene" aria-hidden="true">
        <div class="sumload-floats"><i></i><i></i><i></i></div>
        <div class="sumload-orbit"><i></i><i></i><i></i></div>
        <div class="sumload-ring"></div>
        <div class="sumload-core">${brandGlyph(compact ? 30 : 38)}</div>
        <span class="sumload-spark s1">${icon("sparkle", { size: 13 })}</span>
        <span class="sumload-spark s2">${icon("sparkle", { size: 11 })}</span>
        <span class="sumload-spark s3">${icon("sparkle", { size: 12 })}</span>
      </div>
      <div class="sumload-title">${escHtml(title)}</div>
      <div class="sumload-quip">${escHtml(quip)}</div>
      <div class="sumload-bar"><b></b></div>
    </div>`;
}

/**
 * Summarize loader (phase-aware copy). Name + signature are kept so existing
 * call sites — and the now no-op tube updaters — need no change; the retired
 * Glacier "phase tube" is replaced by the designed .sumload scene.
 * @param {{ phase?: string, mediaJobsAhead?: number }} opts
 */
function buildPhaseTube({ phase = "sync", mediaJobsAhead = 0 } = {}) {
  const copy = {
    sync: ["מתחבר לוואטסאפ…", "טוען את ההודעות האחרונות…"],
    read: ["קורא את ההודעות…", "עובר על מה שפספסת…"],
    summarize: ["בונה את הסיכום…", "מתמצת לכמה שורות ✦"],
    done: ["מסיים…", "כמעט שם ✦"],
  };
  const [title, defaultQuip] = copy[phase] || copy.sync;
  const quip = (phase === "read" && mediaJobsAhead > 0)
    ? `מנתח עוד ${mediaJobsAhead} פריטי מדיה ברקע — הסיכום ימשיך`
    : defaultQuip;
  return buildSumLoader(title, quip);
}

/** Update the live elapsed counter inside the tube. */
function setTubeElapsed(sec) {
  const el = document.getElementById("tube-elapsed");
  if (el) el.textContent = `${sec}ש׳`;
}

/** Update the liquid fill width (used by the total-view scan). */
function setTubeFill(pct) {
  const liq = document.querySelector(".phase-tube__liq");
  if (liq) liq.style.width = `${pct}%`;
}

function buildSummaryCardStreaming(text) {
  if (!text.length) return buildPhaseTube({ phase: "summarize", elapsed: 0 });
  return `
    <div class="glass-card summary-card summary-card--streaming" style="animation: summary-fade-in 0.35s ease both">
      <div class="summary-card__meta">
        <span class="writing-indicator">
          <span class="writing-indicator__pen" aria-hidden="true">✍️</span>
          כותב סיכום<span class="writing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </span>
      </div>
      <div class="summary-card__body summary-card__body--rendered">${renderMarkdown(text)}<span class="caret" aria-hidden="true"></span></div>
    </div>
  `;
}

function buildSummaryCardDone(text, statusText, stale) {
  return `
    ${stale ? `
      <div class="stale-note" role="alert">
        <span aria-hidden="true">⚠️</span><span>נתונים עלולים להיות לא עדכניים</span>
      </div>` : ""}
    <div class="glass-card summary-card">
      <div class="summary-card__meta"><span>סיכום Sumbox · ${escHtml(statusText)}</span></div>
      <div class="summary-card__body summary-card__body--rendered">${renderMarkdown(text)}</div>
      <div class="summary-actions">
        <button class="btn btn-soft show-thread-btn" type="button">${icon("message", { size: 15 })}הצג את השיחה</button>
        <button class="copy-btn" id="copy-btn" data-summary-md="${escHtml(text)}" aria-label="העתק סיכום">📋 העתק סיכום</button>
      </div>
    </div>
  `;
}

/** Render a section's bullets; those with a sourceMessageId become source-jump buttons. */
function renderSumBullets(bullets) {
  return bullets
    .map((b) => {
      // Inline markdown (bold label + chat tags), citation markers stripped —
      // the source-jump button carries the real messageId for attribution.
      const text = renderInline(b.text);
      if (b.sourceMessageId) {
        return `<li><button type="button" class="sum-jump" data-id="${b.sourceMessageId}">` +
          `<span class="sum-jump__text">${text}</span>` +
          `<span class="sum-jump__icon" aria-hidden="true">↩︎</span></button></li>`;
      }
      return `<li class="sum-item">${text}</li>`;
    })
    .join("");
}

/** Feedback row for the catch-up card: 👍/👎 + (after 👎) four reason chips. */
function buildSummaryRateRow(summaryId) {
  if (summaryId == null) return ""; // demo / legacy / cache-first without an id
  const chips = [
    ["missed", "פספס משהו"],
    ["inaccurate", "לא מדויק"],
    ["too_long", "ארוך מדי"],
    ["too_short", "קצר מדי"],
  ]
    .map(([k, label]) => `<button class="chip sum-reason-chip" type="button" data-reason="${k}" hidden>${label}</button>`)
    .join("");
  return `<div class="asst-rate sum-rate" data-summary-id="${summaryId}">
    <span class="asst-rate-q">עזר?</span>
    <button class="asst-rate-b" type="button" data-rate="1" title="עזר">✓</button>
    <button class="asst-rate-b down" type="button" data-rate="-1" title="לא עזר">✗</button>
    <span class="sum-reason-chips">${chips}</span>
  </div>`;
}

/**
 * Structured summary-first card (§3). Falls back to the markdown card for legacy
 * (version !== 2) or missing structure, so nothing ever fails to render.
 * @param {{version:number, overview:string, tldr:string, topics:Array, decisions:Array, openQuestions:Array}} summary
 * @param {number} [summaryId]
 */
function buildStructuredSummaryCard(summary, statusText, stale, summaryId) {
  if (!summary || summary.version !== 2) {
    return buildSummaryCardDone(summary?.overview ?? "", statusText, stale);
  }
  const section = (title, bullets) =>
    bullets && bullets.length
      ? `<div class="sum-section"><h4 class="sum-section__title">${title}</h4>` +
        `<ul class="sum-list">${renderSumBullets(bullets)}</ul></div>`
      : "";
  const tldr = summary.tldr
    ? `<div class="sum-section sum-section--tldr"><h4 class="sum-section__title">תקציר</h4><p class="sum-tldr">${escHtml(summary.tldr)}</p></div>`
    : "";
  return `
    ${stale ? `
      <div class="stale-note" role="alert">
        <span aria-hidden="true">⚠️</span><span>נתונים עלולים להיות לא עדכניים</span>
      </div>` : ""}
    <div class="glass-card summary-card sum-card">
      <div class="summary-card__meta"><span>סיכום Sumbox · ${escHtml(statusText)}</span></div>
      ${tldr}
      ${section("נושאים עיקריים", summary.topics)}
      ${section("החלטות ומשימות", summary.decisions)}
      ${section("שאלות פתוחות", summary.openQuestions)}
      <div class="summary-actions">
        <button class="btn btn-soft show-thread-btn" type="button">${icon("message", { size: 15 })}הצג את השיחה</button>
        <button class="copy-btn" id="copy-btn" data-summary-md="${escHtml(summary.overview ?? "")}" aria-label="העתק סיכום">📋 העתק סיכום</button>
      </div>
      ${buildSummaryRateRow(summaryId)}
    </div>
  `;
}

function buildEmptyResult() {
  return `
    <div class="glass-card summary-card">
      <div class="summary-card__meta"><span>אין חדש</span></div>
      <p class="detail-status">אין הודעות חדשות לסיכום.</p>
    </div>
  `;
}

function showUpdatingChip(show) {
  let host = document.getElementById("updating-chip-host");
  if (!host) {
    const region = document.getElementById("summary-region");
    if (!region) return;
    host = document.createElement("div");
    host.id = "updating-chip-host";
    region.parentNode.insertBefore(host, region);
  }
  host.innerHTML = show
    ? `<div class="updating-chip" role="status" aria-live="polite" aria-label="מתעדכן">
         <span class="updating-chip__dot" aria-hidden="true"></span>
         <span class="updating-chip__text">מתעדכן…</span>
       </div>`
    : "";
}

/* ── 5e. Copy button (delegated) ─────────────────────────── */

function wireCopyButton() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    // Every summary copy button carries its OWN card's raw markdown in
    // `data-summary-md`, so the copied text always matches the card it lives in
    // — never the shared `detailState.summaryText`, which tracks the last stream
    // that finished (a background watermark refresh) and drifts from a cached or
    // range-selected card on screen. Always reshape to WhatsApp-native text.
    const md = btn.dataset.summaryMd ?? detailState.summaryText;
    const text = toWhatsAppText(md);
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
      }
      btn.textContent = "הועתק!";
      btn.classList.add("copy-btn--confirm");
      setTimeout(() => { btn.textContent = "📋 העתק סיכום"; btn.classList.remove("copy-btn--confirm"); }, 2000);
    } catch {
      btn.textContent = "לא ניתן להעתיק";
      setTimeout(() => { btn.textContent = "📋 העתק סיכום"; }, 2000);
    }
  });
}

/** "הצג את השיחה" — open the current chat's full thread (no anchor → latest window). */
function wireShowThread() {
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".show-thread-btn")) return;
    if (detailState.group) navigate("thread", { chat: detailState.group });
  });
}

/** Summary card 👍/👎 + reason chips (delegated; survives innerHTML re-renders). */
function wireSummaryRate() {
  document.addEventListener("click", (e) => {
    const row = e.target.closest(".sum-rate[data-summary-id]");
    if (!row) return;
    const summaryId = Number(row.dataset.summaryId);
    const chip = e.target.closest(".sum-reason-chip[data-reason]");
    if (chip) {
      const reason = chip.dataset.reason;
      void rateSummary(summaryId, -1, reason).catch(() => {});
      if (detailState.group) {
        runSummary({ mode: "sumbox", group: detailState.group, regenerate: summaryId, reason }, false);
      }
      return;
    }
    const down = e.target.closest(".asst-rate-b.down");
    if (down) {
      for (const c of row.querySelectorAll(".sum-reason-chip")) c.hidden = false;
      return;
    }
    const up = e.target.closest(".asst-rate-b:not(.down)");
    if (up) {
      void rateSummary(summaryId, 1).catch(() => {});
      row.innerHTML = `<span class="asst-rate-thanks">✓ תודה על המשוב</span>`;
    }
  });
}

/* ── 5f. History ─────────────────────────────────────────── */

function summaryTypeLabel(type) {
  switch (type) {
    case "watermark": return "מה שפספסתי";
    case "last_n": return "הודעות אחרונות";
    case "since": return "טווח זמן";
    default: return escHtml(type);
  }
}

async function loadHistory(group) {
  const section = document.getElementById("history-section");
  const listEl = document.getElementById("history-list");
  if (!section || !listEl) return;

  let summaries;
  try {
    summaries = await getSummaries(group);
  } catch {
    _renderHistoryToggle(section, listEl, 0, true);
    return;
  }

  if (!summaries || summaries.length === 0) {
    section.querySelector(".history-toggle")?.remove();
    listEl.hidden = true;
    listEl.innerHTML = "";
    return;
  }

  const sorted = [...summaries].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  listEl.innerHTML = sorted.map((s) => buildHistoryRow(s)).join("");
  listEl.querySelectorAll(".history-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".history-row__body")) return;
      toggleHistoryRow(row);
    });
  });
  _renderHistoryToggle(section, listEl, sorted.length, false);
}

function _renderHistoryToggle(section, listEl, count, error) {
  const existingToggle = section.querySelector(".history-toggle");
  const wasOpen = existingToggle ? existingToggle.getAttribute("aria-expanded") === "true" : false;
  if (existingToggle) existingToggle.remove();

  if (error) {
    listEl.hidden = true;
    listEl.innerHTML = `<p class="history-empty">שגיאה בטעינת היסטוריה.</p>`;
    return;
  }
  if (count === 0) { listEl.hidden = true; return; }

  const toggle = document.createElement("button");
  toggle.className = "history-toggle";
  toggle.setAttribute("aria-expanded", wasOpen ? "true" : "false");
  toggle.setAttribute("aria-controls", "history-list");
  toggle.innerHTML = `<span class="history-toggle__label">סיכומים קודמים (${count})</span><span class="history-toggle__chevron" aria-hidden="true">▾</span>`;
  section.insertBefore(toggle, listEl);

  if (wasOpen) {
    listEl.hidden = false;
    toggle.querySelector(".history-toggle__chevron").classList.add("history-toggle__chevron--open");
  } else {
    listEl.hidden = true;
  }

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    listEl.hidden = open;
    toggle.querySelector(".history-toggle__chevron")?.classList.toggle("history-toggle__chevron--open", !open);
  });
}

function buildHistoryRow(s) {
  const label = summaryTypeLabel(s.summaryType);
  const ts = fmtTime(s.createdAt);
  const bodyText = s.output?.overview ?? "";
  return `
    <div class="history-row glass-card" data-id="${s.id}" aria-expanded="false">
      <div class="history-row__head">
        <span class="history-row__type">${label}</span>
        <span class="history-row__ts">${escHtml(ts)}</span>
        <span class="history-row__chevron" aria-hidden="true">›</span>
      </div>
      <div class="history-row__body" hidden>
        <div class="history-row__text summary-card__body--rendered">${renderMarkdown(bodyText)}</div>
        <div class="summary-actions">
          <button class="copy-btn" data-summary-md="${escHtml(bodyText)}" aria-label="העתק סיכום">📋 העתק סיכום</button>
        </div>
      </div>
    </div>
  `;
}

function toggleHistoryRow(row) {
  const body = row.querySelector(".history-row__body");
  const chevron = row.querySelector(".history-row__chevron");
  if (!body) return;
  const expanded = row.getAttribute("aria-expanded") === "true";
  row.setAttribute("aria-expanded", expanded ? "false" : "true");
  body.hidden = expanded;
  chevron?.classList.toggle("history-row__chevron--open", !expanded);
}

/* ── 6. Total view ───────────────────────────────────────── */

function renderTotal(autoStart) {
  teardownStream();
  paneMain.innerHTML = buildTotalShell();
  setView("total");
  setAppbar("total", { back: true });

  document.getElementById("total-back-btn")?.addEventListener("click", () => navigate("feed"));
  const chipsContainer = document.getElementById("total-chips");
  chipsContainer?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip[data-since]");
    if (!btn) return;
    chipsContainer.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("chip--active", c === btn);
      c.setAttribute("aria-pressed", c === btn ? "true" : "false");
    });
    runTotal({ since: btn.dataset.since });
  });

  if (autoStart) {
    if (DEMO) {
      const card = document.getElementById("total-highlights");
      const body = document.getElementById("total-highlights-body");
      if (card) card.hidden = false;
      if (body) body.innerHTML = renderMarkdown(DEMO_TOTAL_HIGHLIGHTS);
      renderTotalPerChat(DEMO_TOTAL_PERCHAT);
      return;
    }
    runTotal({ since: defaultTotalSince() });
  }
}

function defaultTotalSince() {
  return new Date(Date.now() - 24 * 3600 * 1000).toISOString();
}

function buildTotalShell() {
  const since24h = defaultTotalSince();
  const since3d = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const sinceWeek = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  return `
    <div class="detail-view total-view">
      <nav class="detail-nav" aria-label="ניווט">
        <button class="back-btn" id="total-back-btn" aria-label="חזרה לרשימת הקבוצות">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
      </nav>
      <div class="detail-ghead detail-ghead--center">
        <h2 class="detail-gtitle">📊 סיכום כללי</h2>
        <div class="detail-gfresh">מה קרה בכל הצ׳אטים</div>
      </div>
      <div class="chips mode-chips chips--center" role="group" aria-label="בחירת טווח זמן" id="total-chips">
        <button class="chip chip--active" data-since="${escHtml(since24h)}" aria-pressed="true">24 שעות</button>
        <button class="chip" data-since="${escHtml(since3d)}" aria-pressed="false">3 ימים</button>
        <button class="chip" data-since="${escHtml(sinceWeek)}" aria-pressed="false">שבוע</button>
      </div>
      <div id="total-loader" aria-live="polite"></div>
      <p id="total-error" class="detail-status detail-status--error" role="alert" hidden></p>
      <div id="total-highlights" class="glass-card summary-card" hidden>
        <div id="total-highlights-body" class="summary-card__body summary-card__body--rendered"></div>
      </div>
      <div id="total-perchat" class="total-perchat-list"></div>
    </div>
  `;
}

function showTotalLoader(phase, opts = {}) {
  const region = document.getElementById("total-loader");
  if (region) region.innerHTML = buildPhaseTube({ phase, elapsed: 0, ...opts });
}

function clearTotalLoader() {
  const region = document.getElementById("total-loader");
  if (region) region.innerHTML = "";
  if (totalLoaderTimer) { clearInterval(totalLoaderTimer); totalLoaderTimer = null; }
}

function renderTotalPerChat(perChat) {
  const perChatEl = document.getElementById("total-perchat");
  if (!perChatEl) return;
  if (perChat.length === 0) { perChatEl.innerHTML = ""; return; }
  const chats = perChat.slice().sort((a, b) => Number(b.messageCount) - Number(a.messageCount));
  const heading = `<h3 class="total-section-heading">לפי צ׳אט · ${chats.length} צ׳אטים</h3>`;
  const items = chats.map((c) => `
    <details class="perchat glass-card">
      <summary class="perchat__summary">
        <span class="perchat__name">${escHtml(c.name)}</span>
      </summary>
      <div class="perchat__body summary-card__body--rendered">${renderMarkdown(c.summary)}</div>
    </details>
  `).join("");
  perChatEl.innerHTML = heading + items;
}

function runTotal({ since }) {
  teardownStream();
  const highlightsCard = document.getElementById("total-highlights");
  const highlightsBody = document.getElementById("total-highlights-body");
  const perChatEl = document.getElementById("total-perchat");
  const errorEl = document.getElementById("total-error");
  if (highlightsCard) highlightsCard.hidden = true;
  if (highlightsBody) highlightsBody.innerHTML = "";
  if (perChatEl) perChatEl.innerHTML = "";
  if (errorEl) errorEl.hidden = true;

  const startedAt = Date.now();
  showTotalLoader("read");
  totalLoaderTimer = setInterval(() => {
    setTubeElapsed(Math.round((Date.now() - startedAt) / 1000));
  }, 1000);

  let raw = "";
  let loaderActive = true;
  const es = new EventSource(`/api/total-summary?since=${encodeURIComponent(since)}`);
  activeEventSource = es;

  es.addEventListener("status", (e) => {
    const d = JSON.parse(e.data);
    if (d.phase === "chat" && loaderActive) {
      const cap = document.querySelector("#total-loader .phase-tube__caption");
      if (cap) cap.textContent = `📖 מסכם את "${d.name}" · צ׳אט ${d.index} מתוך ${d.total}`;
      if (d.total > 0) setTubeFill(scanFill(d.index - 1, d.total));
    }
  });

  es.addEventListener("token", (e) => {
    if (loaderActive) { loaderActive = false; clearTotalLoader(); }
    raw += JSON.parse(e.data).delta;
    if (highlightsCard) highlightsCard.hidden = false;
    if (highlightsBody) highlightsBody.innerHTML = `${renderMarkdown(raw)}<span class="caret" aria-hidden="true"></span>`;
  });

  es.addEventListener("done", (e) => {
    const d = JSON.parse(e.data);
    loaderActive = false;
    clearTotalLoader();
    if (highlightsCard) highlightsCard.hidden = false;
    if (highlightsBody) highlightsBody.innerHTML = renderMarkdown(d.highlights);
    renderTotalPerChat(d.perChat || []);
    teardownStream();
  });

  es.addEventListener("error", (e) => {
    let msg = "שגיאה בהפקת הסיכום.";
    try { const data = JSON.parse(e.data); if (data?.message) msg = data.message; } catch { /* native error */ }
    loaderActive = false;
    clearTotalLoader();
    if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; }
    teardownStream();
  });
}

/* ── 7b. Thread view (Ask source-jump) ───────────────────── */

/**
 * Render a chat thread windowed around a cited message and pulse the source.
 * Reuses the single-pane (ama) layout slot. Back returns via history.
 * @param {string} chat — group name
 * @param {number} aroundId — cited message id to center + pulse
 */
async function renderThread(chat, aroundId) {
  teardownStream();
  setView("thread");
  setAppbar("thread", { back: true });
  paneMain.innerHTML = `
    <div class="thread-panel">
      <div class="thread-head">
        <button class="back-btn" id="thread-back" aria-label="חזרה">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
        <div class="thread-head__title">${escHtml(formatGroupName(chat))}</div>
        <button class="thread-head__src" id="thread-to-summary" type="button">${icon("sparkle", { size: 13 })}סיכום</button>
      </div>
      <div class="thread-msgs" id="thread-msgs"><p class="thread-loading">טוען שיחה…</p></div>
    </div>`;
  document.getElementById("thread-back")?.addEventListener("click", () => history.back());
  document.getElementById("thread-to-summary")?.addEventListener("click", () => navigate("detail", chat));

  let rows = [];
  try {
    rows = await getMessages({ chat, aroundId, limit: 24 });
  } catch {
    const box = document.getElementById("thread-msgs");
    if (box) box.innerHTML = `<p class="error-state">שגיאה בטעינת השיחה.</p>`;
    return;
  }
  const box = document.getElementById("thread-msgs");
  if (!box) return; // navigated away while loading
  if (!rows.length) {
    box.innerHTML = `<p class="empty-state">לא נמצאו הודעות.</p>`;
    return;
  }
  box.innerHTML = rows
    .map((m) => {
      const side = m.fromMe ? "cmsg--me" : "cmsg--them";
      const hl = m.id === aroundId ? " cmsg--hl" : "";
      const tag = m.id === aroundId ? `<span class="cmsg__tag">מקור הסיכום</span>` : "";
      return `<div class="cmsg ${side}${hl}" data-id="${m.id}">
        <div class="cmsg__meta">${escHtml(m.sender)} · <span dir="ltr">${escHtml(fmtTime(m.sentAt))}</span></div>
        <div class="cmsg__text">${escHtml(m.text)}</div>${tag}
      </div>`;
    })
    .join("");
  const target = box.querySelector(".cmsg--hl");
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.classList.add("cmsg--pulse");
  }
}

/* ── 7c. Sources (chat scopes) ───────────────────────────── */

const SEG_LABEL = { all: "הכול", included: "מוזנים", excluded: "מוחרגים" };
const sourcesState = { scopes: [], categories: [], query: "", segment: "all", adding: false };
let sourcesMenuWired = false;

/** Close every open per-row ⋯ overflow menu in Sources. */
function closeAllSourceMenus() {
  for (const m of document.querySelectorAll(".src-row .cl-menu")) m.hidden = true;
  for (const b of document.querySelectorAll('.src-row [data-act="menu"]')) {
    b.setAttribute("aria-expanded", "false");
  }
}

/** The Sources control center (§7): whitelist/blacklist + categorize chats. */
async function renderSources() {
  teardownStream();
  setView("sources");
  setAppbar("sources");
  paneMain.innerHTML = `<div class="sources-panel"><p class="thread-loading">טוען צ׳אטים…</p></div>`;
  try {
    const [scopes, categories] = await Promise.all([getScopes(), getScopeCategories()]);
    sourcesState.scopes = scopes;
    sourcesState.categories = categories;
  } catch {
    paneMain.innerHTML = `<div class="sources-panel"><p class="error-state">שגיאה בטעינת הצ׳אטים.</p></div>`;
    return;
  }
  paintSources();
}

function paintSources() {
  const { scopes, categories, query, segment } = sourcesState;
  const { removed } = partitionRemoved(scopes);
  const counts = activeCount(scopes);
  const filtered = filterScopes(scopes, { query, segment });
  const sections = groupByCategory(filtered, categories);

  paneMain.innerHTML = `
    <div class="sources-panel">
      <div class="sources-head">
        <button class="back-btn" id="sources-back" aria-label="חזרה">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
        <div class="sources-head__title">צ׳אטים</div>
      </div>
      <div class="sources-callout">
        <span class="sources-callout__ico">${icon("filter", { size: 22 })}</span>
        <div class="grow">
          <b>אתם בוחרים מה Sumbox רואה</b>
          <p>רק צ׳אטים מסומנים מוזנים לסיכום, לעדכונים ולהצעות. תייגו לפי הקשר כדי לכוון את המערכת.</p>
        </div>
        <span class="badge accent" dir="ltr">${counts.active}/${counts.total} פעילים</span>
      </div>
      <div class="sources-toolbar">
        <input id="sources-search" class="src-search" type="search" placeholder="🔍  חיפוש צ׳אט…"
          aria-label="חיפוש צ׳אט" value="${escHtml(query)}" autocomplete="off" />
        <div class="src-seg" role="group" aria-label="סינון">
          ${["all", "included", "excluded"]
            .map(
              (seg) =>
                `<button class="src-seg__btn${segment === seg ? " is-active" : ""}" data-seg="${seg}" type="button">${SEG_LABEL[seg]}</button>`,
            )
            .join("")}
        </div>
        <button class="src-addcat" id="sources-addcat" type="button" aria-expanded="${sourcesState.adding ? "true" : "false"}">+ קבוצה</button>
      </div>
      ${
        sourcesState.adding
          ? `<div class="src-addgroup">
          <input id="sources-newcat" type="text" placeholder="שם קבוצה חדשה (למשל: חברים מהצבא)" aria-label="שם קבוצה חדשה" autocomplete="off" />
          <button class="src-addcat" id="sources-newcat-add" type="button">הוסף</button>
        </div>`
          : ""
      }
      ${sections.map(buildSourcesSection).join("")}
      ${filtered.length === 0 ? `<p class="empty-state">לא נמצאו צ׳אטים תואמים.</p>` : ""}
      ${removed.length ? buildRemovedSection(removed) : ""}
      <p class="src-legend">מתג = הכללה/החרגה (whitelist/blacklist) · ⋯ = העברה בין קבוצות והסרה · ״קבוצה״ ליצירת קטגוריה חדשה</p>
    </div>`;
  wireSources();
}

function buildSourcesSection(section) {
  const title = section.category ? escHtml(section.category.name) : "ללא קטגוריה";
  const n = sectionCount(section.scopes);
  // "all on" (not "any on") drives the bulk label so a partially-on category offers "הפעל הכול".
  const allOn = section.scopes.length > 0 && section.scopes.every((s) => s.included);
  const bulkLabel = allOn ? "כבה הכול" : "הפעל הכול";
  const rows = section.scopes.map((s, i) => (i ? '<div class="divide"></div>' : "") + buildSourceRow(s)).join("");
  return `
    <div class="src-section">
      <div class="src-section__head">
        <span class="src-section__title">${title} <span class="src-section__count mono" dir="ltr">${n}/${section.scopes.length}</span></span>
        ${section.scopes.length ? `<button class="src-bulk" data-bulk="${allOn ? "off" : "on"}" data-cat="${section.category?.id ?? ""}" type="button">${bulkLabel}</button>` : ""}
      </div>
      ${section.scopes.length ? `<div class="src-card surface">${rows}</div>` : `<p class="src-empty-cat">אין צ׳אטים בקטגוריה זו</p>`}
    </div>`;
}

function buildSourceRow(s) {
  const name = formatGroupName(s.group);
  const catName = sourcesState.categories.find((c) => c.id === s.categoryId)?.name;
  const status = !s.included ? "מוחרג — לא ינוטר" : s.muted ? "מושתק · עדכונים בלבד" : "מוזן ל-Sumbox";
  const statusLine = catName ? `${escHtml(status)} · ${escHtml(catName)}` : escHtml(status);
  const moveItems = sourcesState.categories
    .filter((c) => c.id !== s.categoryId)
    .map((c) => `<button data-act="cat" data-cat="${c.id}" type="button">${escHtml(c.name)}${icon("chevL", { size: 13 })}</button>`)
    .join("");
  const toNone = s.categoryId != null ? `<button data-act="cat" data-cat="" type="button">ללא קטגוריה${icon("chevL", { size: 13 })}</button>` : "";
  return `
    <div class="src-row${s.included ? "" : " src-row--off"}" data-group="${escHtml(s.group)}">
      ${avatarHtml(name, hueFromName(s.group), 38)}
      <div class="src-row__body">
        <div class="src-row__name">${escHtml(name)}</div>
        <div class="src-row__status">${statusLine}</div>
      </div>
      <div class="src-actions-wrap">
        <button class="cl-ico" data-act="menu" type="button" aria-haspopup="true" aria-expanded="false" aria-label="פעולות">${icon("more", { size: 18 })}</button>
        <div class="cl-menu surface" hidden>
          <button data-act="toggle" type="button">${s.included ? "הסר מהסיכום" : "כלול בסיכום"}${icon(s.included ? "x" : "check", { size: 14 })}</button>
          ${s.included ? `<button data-act="mute" type="button">${s.muted ? "בטל השתקת הצעות" : "השתק הצעות (עדכונים בלבד)"}${icon("moon", { size: 14 })}</button>` : ""}
          <div class="cl-menu-label">העבר לקבוצה</div>
          ${moveItems}${toNone}
          <div class="divide"></div>
          <button class="danger" data-act="remove" type="button">הסר מהרשימה${icon("trash", { size: 14 })}</button>
        </div>
      </div>
      <button class="src-switch${s.included ? " is-on" : ""}" data-act="toggle" type="button"
        role="switch" aria-checked="${s.included}" aria-label="${s.included ? "מוזן" : "מוחרג"}">
        <span class="src-switch__knob"></span>
      </button>
    </div>`;
}

function buildRemovedSection(removed) {
  return `
    <div class="src-section src-section--removed">
      <div class="src-section__head"><span class="src-section__title">הוסרו <span class="mono" dir="ltr">${removed.length}</span></span></div>
      ${removed
        .map(
          (s) => `
        <div class="src-row src-row--removed" data-group="${escHtml(s.group)}">
          <div class="src-row__name">${escHtml(formatGroupName(s.group))}</div>
          <button class="src-restore" data-act="restore" type="button">שחזר</button>
        </div>`,
        )
        .join("")}
    </div>`;
}

/** Apply a scope change locally + persist, then repaint. Optimistic. */
async function applyScopeChange(updates) {
  for (const u of updates) {
    const row = sourcesState.scopes.find((s) => s.group === u.group);
    if (!row) continue;
    if (u.included !== undefined) row.included = u.included;
    if (u.categoryId !== undefined) row.categoryId = u.categoryId;
    if (u.removed !== undefined) row.removed = u.removed;
    if (u.muted !== undefined) row.muted = u.muted;
  }
  paintSources();
  try {
    await putScopes(updates);
  } catch {
    // Refetch to resync if the write failed.
    renderSources();
  }
}

function wireSources() {
  document.getElementById("sources-back")?.addEventListener("click", () => history.back());

  const search = document.getElementById("sources-search");
  if (search) {
    search.addEventListener("input", () => {
      sourcesState.query = search.value;
      paintSources();
      document.getElementById("sources-search")?.focus();
    });
  }
  for (const btn of document.querySelectorAll(".src-seg__btn")) {
    btn.addEventListener("click", () => {
      sourcesState.segment = btn.dataset.seg;
      paintSources();
    });
  }
  document.getElementById("sources-addcat")?.addEventListener("click", () => {
    sourcesState.adding = !sourcesState.adding;
    paintSources();
    document.getElementById("sources-newcat")?.focus();
  });
  const submitNewCat = async () => {
    const name = (document.getElementById("sources-newcat")?.value || "").trim();
    if (!name) return;
    try {
      await createScopeCategory(name);
      sourcesState.categories = await getScopeCategories();
      sourcesState.adding = false;
      paintSources();
    } catch {
      /* ignore */
    }
  };
  document.getElementById("sources-newcat-add")?.addEventListener("click", submitNewCat);
  document.getElementById("sources-newcat")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitNewCat();
  });
  for (const btn of document.querySelectorAll(".src-bulk")) {
    btn.addEventListener("click", () => {
      const on = btn.dataset.bulk === "on";
      const catId = btn.dataset.cat === "" ? null : Number(btn.dataset.cat);
      const updates = sourcesState.scopes
        .filter((s) => !s.removed && (s.categoryId ?? null) === catId)
        .map((s) => ({ group: s.group, included: on }));
      if (updates.length) applyScopeChange(updates);
    });
  }
  for (const row of document.querySelectorAll(".src-row[data-group]")) {
    const group = row.dataset.group;
    // The include switch AND the menu's "כלול/הסר מהסיכום" item both toggle inclusion.
    for (const t of row.querySelectorAll('[data-act="toggle"]')) {
      t.addEventListener("click", () => {
        const s = sourcesState.scopes.find((x) => x.group === group);
        applyScopeChange([{ group, included: !s.included }]);
      });
    }
    row.querySelector('[data-act="mute"]')?.addEventListener("click", () => {
      const s = sourcesState.scopes.find((x) => x.group === group);
      applyScopeChange([{ group, muted: !s.muted }]);
    });
    row.querySelector('[data-act="remove"]')?.addEventListener("click", () =>
      applyScopeChange([{ group, removed: true }]),
    );
    row.querySelector('[data-act="restore"]')?.addEventListener("click", () =>
      applyScopeChange([{ group, removed: false }]),
    );
    for (const cb of row.querySelectorAll('[data-act="cat"]')) {
      cb.addEventListener("click", () => {
        const val = cb.dataset.cat;
        applyScopeChange([{ group, categoryId: val === "" ? null : Number(val) }]);
      });
    }
    // ⋯ overflow menu (move-to-group + remove): open one at a time.
    const menuBtn = row.querySelector('[data-act="menu"]');
    const menu = row.querySelector(".cl-menu");
    if (menuBtn && menu) {
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        closeAllSourceMenus();
        menu.hidden = !willOpen;
        menuBtn.setAttribute("aria-expanded", String(willOpen));
      });
      menu.addEventListener("click", (e) => e.stopPropagation());
    }
  }
  // Close any open ⋯ menu on an outside click (wired once).
  if (!sourcesMenuWired) {
    sourcesMenuWired = true;
    document.addEventListener("click", closeAllSourceMenus);
  }
}

/** A transient toast pinned to the bottom of the main column (reuses .dg-flash). */
function showMainToast(text) {
  const host = document.querySelector(".main");
  if (!host) return;
  const t = document.createElement("div");
  t.className = "dg-flash show";
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

/* ── 7e. Commands (summary command permissions) ──────────── */

const commandsState = { groups: [], trigger: "/סיכום", search: "" };

/** A chat whose display name is a raw JID (no WhatsApp subject/pushName) — unidentifiable,
 *  so it's hidden from the add-search list. Enabled chats always show regardless. */
function isNamedChat(g) {
  const n = g.name ?? "";
  return !(n.endsWith("@g.us") || n.endsWith("@lid") || n.endsWith("@s.whatsapp.net"));
}

async function renderCommands() {
  teardownStream();
  setView("commands");
  setAppbar("commands");
  if (DEMO) {
    commandsState.groups = DEMO_SUMMARY_COMMANDS.groups;
    commandsState.trigger = DEMO_SUMMARY_COMMANDS.trigger;
    paintCommands();
    return;
  }
  paneMain.innerHTML = `<div class="cmds-panel"><p class="thread-loading">טוען קבוצות…</p></div>`;
  try {
    const data = await getSummaryCommands();
    commandsState.groups = data.groups;
    commandsState.trigger = data.trigger;
  } catch {
    paneMain.innerHTML = `<div class="cmds-panel"><p class="error-state">שגיאה בטעינת רשימת הקבוצות.</p></div>`;
    return;
  }
  paintCommands();
}

function paintCommands() {
  const groups = commandsState.groups;
  const trigger = commandsState.trigger;
  const active = groups.filter((g) => g.enabled);
  paneMain.innerHTML = `
    <div class="cmds-panel">
      <div class="cmds-head">
        <button class="back-btn" id="cmds-back" aria-label="חזרה">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
        <div class="cmds-head__title">פקודות</div>
      </div>
      <div class="cmds-callout">
        <span class="cmds-callout__ico" aria-hidden="true">${icon("send", { size: 22 })}</span>
        <div class="grow">
          <b>${escHtml(trigger)} — סיכום מיידי בקבוצה</b>
          <p>כתבו ${escHtml(trigger)} בקבוצה מורשית והמערכת תחזיר סיכום של מה שפספסתם. התשובה נשלחת חזרה לקבוצה — הפעילו רק בקבוצות שבהן זה מתאים.</p>
        </div>
        <span class="badge accent" dir="ltr">${active.length} פעילים</span>
      </div>
      <label class="cmd-trigger">
        <span class="cmd-trigger__label">הפקודה</span>
        <input class="cmd-trigger__input" id="cmd-trigger-input" type="text" dir="ltr" maxlength="32"
               value="${escHtml(trigger)}" aria-label="טקסט הפקודה" />
      </label>
      <p class="cmd-trigger__hint">הודעה בקבוצה מורשית שתכיל בדיוק את הטקסט הזה תפעיל סיכום. חייב להתחיל ב־/.</p>

      <h3 class="cmds-section">קבוצות פעילות${active.length ? ` · ${active.length}` : ""}</h3>
      <div class="cmds-list">
        ${
          active.length === 0
            ? '<p class="empty-state">עדיין לא הופעלו קבוצות. חפשו קבוצה למטה כדי להוסיף.</p>'
            : active.map(buildCommandRow).join("")
        }
      </div>

      <h3 class="cmds-section">הוספת קבוצה</h3>
      <label class="cmd-search">
        <span class="cmd-search__ico" aria-hidden="true">${icon("search", { size: 18 })}</span>
        <input class="cmd-search__input" id="cmd-search-input" type="search"
               placeholder="חיפוש קבוצה לפי שם…" aria-label="חיפוש קבוצה להוספה"
               value="${escHtml(commandsState.search)}" />
      </label>
      <div class="cmds-list" id="cmds-search-results">${buildSearchResults()}</div>

      <p class="cmds-legend">המתג מפעיל/מכבה את פקודת ${escHtml(trigger)} בקבוצה. השינוי נכנס לתוקף מיד.</p>
    </div>`;
  wireCommands();
}

/** Search results = named, not-yet-enabled chats matching the query. Empty query shows a hint
 *  (never the full list — no dump of all chats/contacts). */
function buildSearchResults() {
  const q = commandsState.search.trim().toLowerCase();
  if (!q) return '<p class="empty-state">הקלידו שם כדי למצוא קבוצה להוספה.</p>';
  const matches = commandsState.groups.filter(
    (g) => !g.enabled && isNamedChat(g) && (g.name ?? "").toLowerCase().includes(q),
  );
  if (matches.length === 0) return '<p class="empty-state">לא נמצאו קבוצות בשם הזה.</p>';
  return matches
    .slice(0, 20)
    .map(buildCommandRow)
    .join("");
}

function buildCommandRow(g) {
  const name = escHtml(g.name);
  return `
    <div class="cmd-row${g.enabled ? "" : " cmd-row--off"}" data-group-id="${g.groupId}">
      <div class="cmd-row__body">
        <div class="cmd-row__name">${name}</div>
        <div class="cmd-row__status">${g.enabled ? "מורשה — /סיכום פעיל" : "פקודה כבויה"}</div>
      </div>
      <button class="cmd-switch${g.enabled ? " is-on" : ""}" data-act="toggle" type="button"
        role="switch" aria-checked="${g.enabled}" aria-label="${g.enabled ? "כבוי" : "פעיל"}">
        <span class="cmd-switch__knob"></span>
      </button>
    </div>`;
}

/** (Re)attach toggle handlers to every switch currently in the DOM — called on full paint
 *  and after the search-results list re-renders. Uses a bound flag to avoid double-wiring. */
function wireCommandToggles() {
  for (const btn of document.querySelectorAll('[data-act="toggle"]')) {
    if (btn.dataset.wired === "1") continue;
    btn.dataset.wired = "1";
    btn.addEventListener("click", async (e) => {
      if (DEMO) return showMainToast("לא זמין בתצוגה");
      const row = e.currentTarget.closest(".cmd-row");
      if (!row) return;
      const groupId = Number(row.dataset.groupId);
      const wasOn = row.classList.contains("cmd-row--off") === false;
      const enabled = !wasOn;
      // Optimistic toggle
      row.classList.toggle("cmd-row--off", !enabled);
      btn.classList.toggle("is-on", enabled);
      btn.setAttribute("aria-checked", String(enabled));
      try {
        await toggleSummaryCommand(groupId, enabled);
        // Refresh to sync counts + move the chat between the active/search sections.
        const data = await getSummaryCommands();
        commandsState.groups = data.groups;
        commandsState.trigger = data.trigger;
        paintCommands();
      } catch {
        // Revert on failure
        row.classList.toggle("cmd-row--off", wasOn);
        btn.classList.toggle("is-on", wasOn);
        btn.setAttribute("aria-checked", String(wasOn));
      }
    });
  }
}

function wireCommands() {
  document.getElementById("cmds-back")?.addEventListener("click", () => history.back());
  wireCommandToggles();
  const searchInput = document.getElementById("cmd-search-input");
  searchInput?.addEventListener("input", (e) => {
    commandsState.search = e.currentTarget.value;
    const results = document.getElementById("cmds-search-results");
    if (results) results.innerHTML = buildSearchResults();
    wireCommandToggles();
  });

  const triggerInput = document.getElementById("cmd-trigger-input");
  triggerInput?.addEventListener("change", async (e) => {
    const value = e.currentTarget.value.trim();
    if (DEMO) {
      e.currentTarget.value = commandsState.trigger;
      return showMainToast("לא זמין בתצוגה");
    }
    const lastGood = commandsState.trigger;
    try {
      await setSummaryTrigger(value);
      commandsState.trigger = value;
      paintCommands();
    } catch {
      e.currentTarget.value = lastGood;
      showMainToast("הפקודה חייבת להתחיל ב־/ ולהיות תקינה.");
    }
  });
}

/* ── 8. Helpers ──────────────────────────────────────────── */

function formatGroupName(name) {
  if (!name) return name;
  if (name.endsWith("@s.whatsapp.net")) return "+" + name.slice(0, name.lastIndexOf("@"));
  if (name.endsWith("@lid")) return "איש קשר · …" + name.slice(0, name.lastIndexOf("@")).slice(-4);
  if (name.endsWith("@g.us")) return "קבוצה · …" + name.slice(0, name.lastIndexOf("@")).slice(-4);
  return name;
}

function setSummaryRegion(html) {
  const region = document.getElementById("summary-region");
  if (region) region.innerHTML = html;
}

function clearSyncingTimer() {
  if (detailState.syncingTimer) { clearInterval(detailState.syncingTimer); detailState.syncingTimer = null; }
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleString("he-IL"); } catch { return iso; }
}

function escHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ── 9. Bootstrap ────────────────────────────────────────── */

function resolveInitialRoute() {
  const hash = location.hash;
  let m = hash.match(/^#group=(.+)$/);
  if (m) {
    const group = decodeURIComponent(m[1]);
    history.replaceState({ view: "detail", group }, "", hash);
    return { view: "detail", group };
  }
  if (hash === "#total") {
    history.replaceState({ view: "total" }, "", hash);
    return { view: "total" };
  }
  // Retired routes (#ama / #create / #ask / #assistant / #today / #agenda / #people
  // / #meetings / #todos / #settings) — those surfaces are gone; land on the daily
  // summary like any other unrecognized hash.
  if (hash === "#sources") {
    history.replaceState({ view: "sources" }, "", hash);
    return { view: "sources" };
  }
  if (hash === "#commands") {
    history.replaceState({ view: "commands" }, "", hash);
    return { view: "commands" };
  }
  // Default landing surface is the daily summary feed (עדכונים).
  history.replaceState({ view: "sumbox" }, "", "#sumbox");
  return { view: "sumbox" };
}

// ── First-run onboarding check (single-user, no login) ───────────────────────
// Single-user local mode has no auth gate — this only decides whether to show
// the guided QR-link flow before the app, or reviewed any time via
// ?onboarding=preview.

async function checkOnboarding() {
  const params = new URLSearchParams(location.search);
  if (params.get("onboarding") === "preview") {
    renderOnboardingFlow({ preview: true });
    return false;
  }
  // Run the guided first-run flow once — only when a WhatsApp link is actually
  // pending (the onboarding registry is mounted AND not yet connected) and the
  // user hasn't already completed/skipped it.
  let onboarded = false;
  try {
    onboarded = localStorage.getItem("sumbox-onboarded") === "1";
  } catch {
    /* ignore */
  }
  if (!onboarded) {
    const ob = await fetch("/api/onboarding/status").catch(() => null);
    if (ob?.ok) {
      const { status } = await ob.json();
      if (status && status !== "connected") {
        renderOnboardingFlow({ initialStatus: status });
        return false;
      }
    }
  }
  return true;
}

/* ── §1 Onboarding — guided 5-step first-run flow ────────────
 *
 * welcome → connect (QR) → scanning → choose chats → digest time → ready.
 * Seeds the suggestion engine's scopes so the very first digest is already
 * focused. Reuses the real /api/onboarding/qr + /progress SSE streams and
 * getGroups/putScopes. Runs on first-run and is reachable any time via
 * ?onboarding=preview.
 */
const OB_STEPS = ["ברוכים הבאים", "חיבור", "סריקה", "צ׳אטים", "סיום"];
const OB_WIDTHS = { 0: 560, 1: 660, 2: 520, 3: 680, 4: 540 };
const OB_TIMES = ["07:00", "08:00", "09:00", "20:00"];
const obState = {
  step: 0,
  preview: false,
  initialStatus: null,
  chats: [],
  loadedChats: false,
  digestTime: "08:00",
  morningNotif: true,
  timers: [],
};

function renderOnboardingFlow({ initialStatus = null, preview = false } = {}) {
  obState.step = 0;
  obState.preview = preview;
  obState.initialStatus = initialStatus;
  obState.chats = [];
  obState.loadedChats = false;
  obState.digestTime = "08:00";
  obState.morningNotif = true;
  obTeardown();
  obPaint();
}

/** Stop the active SSE + any scan timers (called on every step change). */
function obTeardown() {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  for (const t of obState.timers) {
    clearInterval(t);
    clearTimeout(t);
  }
  obState.timers = [];
}

function obGo(step) {
  obTeardown();
  obState.step = step;
  obPaint();
}

function obProgressHtml(step) {
  return `<div class="ob-prog">${OB_STEPS.map((l, k) => {
    const cls = k < step ? " done" : k === step ? " on" : "";
    const dot = k < step ? icon("check", { size: 13 }) : String(k + 1);
    const bar = k < OB_STEPS.length - 1 ? '<span class="ob-prog-bar"></span>' : "";
    return `<div class="ob-prog-step${cls}"><span class="ob-prog-dot">${dot}</span><span class="ob-prog-lbl">${escHtml(l)}</span></div>${bar}`;
  }).join("")}</div>`;
}

function obPaint() {
  const step = obState.step;
  const back =
    step > 0 && step < 4
      ? `<button class="ob-back" id="ob-back" type="button">${icon("chevR", { size: 16 })}חזרה</button>`
      : "";
  const card =
    step === 0
      ? obWelcomeHtml()
      : step === 1
        ? obConnectHtml()
        : step === 2
          ? obScanHtml()
          : step === 3
            ? obChatsHtml()
            : obReadyHtml();
  document.getElementById("layout").innerHTML = `
    <div class="ob ob-flow ob-takeover">
      <div style="width:min(${OB_WIDTHS[step]}px,100%)">
        ${obProgressHtml(step >= 4 ? 4 : step)}
        ${back}
        ${card}
      </div>
    </div>`;
  document.getElementById("ob-back")?.addEventListener("click", () => obGo(step - 1));
  obWire(step);
}

function obWelcomeHtml() {
  return `
    <div class="ob-card surface shadow-sm ob-center">
      <div style="display:grid;place-items:center;margin-bottom:22px">${brandGlyph(84, { d3: true })}</div>
      <h2 class="ob-h">Sumbox</h2>
      <p class="ob-p">סיכום יומי, מעקב אנשים, פגישות ומשימות — הכול מתוך הצ׳אטים שלך.<b> והכול נשאר אצלך בלבד.</b></p>
      <div class="ob-bullets">
        <div><span class="ob-bi">${icon("sparkle", { size: 16 })}</span>סיכום יומי שמתמצת את היום בדקה</div>
        <div><span class="ob-bi">${icon("filter", { size: 16 })}</span>אתם בוחרים אילו צ׳אטים נכנסים</div>
        <div><span class="ob-bi">${icon("lock", { size: 16 })}</span>הכול מעובד ונשמר על המכשיר</div>
      </div>
      <button class="btn btn-primary btn-lg btn-block" id="ob-welcome-cta" type="button">${icon("phone")}התחברות עם וואטסאפ</button>
      <div class="trust-line">${icon("lock")}שום דבר לא עולה לענן בלי אישורך</div>
    </div>`;
}

/** A deterministic QR-ish placeholder grid (13×13) shown until the real
 *  server-rendered QR data-URL arrives over SSE. */
function obQrCellsHtml() {
  let cells = "";
  for (let i = 0; i < 169; i++) {
    const on = (Math.imul(i + 1, 2654435761) >>> 27) & 1;
    cells += `<i class="${on ? "" : "off"}"></i>`;
  }
  return cells;
}

function obConnectHtml() {
  return `
    <div class="ob-card surface shadow-sm" style="text-align:start;padding:34px">
      <div class="ob-qr-grid">
        <div>
          <h2 class="ob-h" style="font-size:23px;text-align:start">חברו את הוואטסאפ שלכם</h2>
          <p class="ob-p" style="font-size:14.5px;text-align:start;margin:0 0 18px">סריקה חד-פעמית. החיבור נשאר על המכשיר הזה.</p>
          <ol class="steps">
            <li><span class="sn">1</span><div>פתחו וואטסאפ בטלפון</div></li>
            <li><span class="sn">2</span><div>היכנסו ל<b>הגדרות ← מכשירים מקושרים</b></div></li>
            <li><span class="sn">3</span><div>הקישו <b>קישור מכשיר</b> וכוונו את המצלמה לקוד</div></li>
          </ol>
          <div class="trust-line" style="margin-top:20px">${icon("lock")}חיבור מוצפן מקצה לקצה · אנחנו לא רואים את ההודעות</div>
        </div>
        <div style="text-align:center">
          <div class="qr" id="ob-qr">${obQrCellsHtml()}</div>
          <p class="ob-p" id="ob-qr-hint" style="font-size:12px;margin:10px 0 0">${obState.preview ? "תצוגה מקדימה — קוד לדוגמה" : "מכינים קוד…"}</p>
        </div>
      </div>
      <div class="divide" style="margin:24px 0 18px"></div>
      <button class="btn btn-primary btn-block" id="ob-connect-cta" type="button">${icon("check")}סרקתי — המשך</button>
    </div>`;
}

function obScanItems() {
  return [
    { t: "מתחבר לוואטסאפ", icon: "phone" },
    { t: "קורא את 3 הימים האחרונים", icon: "message" },
    { t: "מזהה אנשים, פגישות ומשימות", icon: "users" },
    { t: "מחלץ משימות ופגישות", icon: "checks" },
    { t: "בונה את הסיכום הראשון", icon: "sun" },
  ];
}

function obScanHtml() {
  const floats = [
    ["12%", "0s", "2.6s", 150, 26],
    ["26%", ".5s", "3.1s", 20, 20],
    ["44%", "1.1s", "2.4s", 230, 30],
    ["62%", ".3s", "3.4s", 60, 22],
    ["78%", "1.4s", "2.8s", 330, 26],
    ["88%", ".8s", "3.2s", 200, 18],
  ]
    .map(
      ([l, d, dur, hue, s]) =>
        `<span class="ob-float" style="inset-inline-start:${l};animation-delay:${d};animation-duration:${dur};--fh:${hue};width:${s}px;height:${s}px">${icon("message", { size: Math.round(s * 0.5) })}</span>`,
    )
    .join("");
  const list = obScanItems()
    .map(
      (it, k) =>
        `<div class="ob-scan-item" data-k="${k}"><span class="ob-scan-ic">${icon(it.icon, { size: 15 })}</span><span>${escHtml(it.t)}</span></div>`,
    )
    .join("");
  return `
    <div class="ob-card surface shadow-sm ob-center ob-scan">
      <div class="ob-scan-stage">
        <div class="ob-floats">${floats}</div>
        <div class="ob-orbit"><i></i><i></i><i></i></div>
        <div class="ob-scan-ring" id="ob-ring" style="--p:0">
          <div class="ob-scan-inner">${brandGlyph(46)}<span class="ob-scan-pct mono" id="ob-pct" dir="ltr">0%</span></div>
        </div>
        <span class="ob-spark s1">${icon("sparkle", { size: 16 })}</span>
        <span class="ob-spark s2">${icon("sparkle", { size: 12 })}</span>
        <span class="ob-spark s3">${icon("sparkle", { size: 14 })}</span>
      </div>
      <h2 class="ob-h" style="font-size:22px">מכינים בשבילך הכול…</h2>
      <p class="ob-quip" id="ob-quip">ממיין הודעות חשובות מרעש…</p>
      <div class="ob-scan-list">${list}</div>
    </div>`;
}

function obChatsHtml() {
  const on = obState.chats.filter((c) => c.included).length;
  const body = !obState.loadedChats
    ? `<p class="ob-p" style="text-align:center">טוען את הצ׳אטים שלך…</p>`
    : obState.chats.length === 0
      ? `<p class="ob-p" style="text-align:center">לא נמצאו צ׳אטים עדיין — אפשר להמשיך ולבחור אחר כך.</p>`
      : `<div class="ob-cat"><div class="ob-cat-head"><b>הצ׳אטים הפעילים שלך</b><button class="src-bulk" id="ob-bulk" type="button">${on === obState.chats.length ? "כבה הכול" : "הפעל הכול"}</button></div>
          <div class="ob-chat-grid">${obState.chats
            .map(
              (c, i) =>
                `<button class="ob-chat-pill${c.included ? " on" : ""}" data-i="${i}" type="button">${avatarHtml(formatGroupName(c.name), c.hue, 30)}<span class="ob-chat-name">${escHtml(formatGroupName(c.name))}</span><span class="ob-chat-check">${c.included ? icon("check", { size: 14 }) : icon("plus", { size: 14 })}</span></button>`,
            )
            .join("")}</div></div>`;
  return `
    <div class="ob-card surface shadow-sm ob-chats" style="text-align:start">
      <div class="ob-chats-head">
        <div>
          <h2 class="ob-h" style="font-size:22px;text-align:start;margin:0 0 4px">אילו צ׳אטים שווה לעקוב אחריהם?</h2>
          <p class="ob-p" style="font-size:14px;text-align:start;margin:0">בחרו את הצ׳אטים שיוזנו ל-Sumbox. תמיד אפשר לשנות אחר כך.</p>
        </div>
        <span class="badge accent ob-count" id="ob-count">${on} נבחרו</span>
      </div>
      <div class="ob-chip-hint">${icon("sparkle", { size: 13 })}רק המסומנים יוזנו לסיכום, לעדכונים ולהצעות</div>
      <div class="ob-chats-scroll">${body}</div>
      <div class="ob-foot">
        <button class="btn btn-primary btn-block" id="ob-chats-cta" type="button"${on === 0 ? " disabled" : ""}>המשך עם ${on} צ׳אטים</button>
        <button class="ob-skip" id="ob-chats-skip" type="button">אבחר אחר כך</button>
      </div>
    </div>`;
}

function obReadyHtml() {
  const times = OB_TIMES.map(
    (t) =>
      `<button class="chip ob-time${t === obState.digestTime ? " on" : ""}" data-t="${t}" type="button"><span class="mono" dir="ltr">${t}</span></button>`,
  ).join("");
  return `
    <div class="ob-card surface shadow-sm ob-center">
      <div class="done-badge" style="width:60px;height:60px;margin-bottom:16px">${icon("check", { size: 30 })}</div>
      <h2 class="ob-h">הכול מוכן ✦</h2>
      <p class="ob-p">הסיכום הראשון שלך מחכה. מתי תרצו לקבל אותו כל בוקר?</p>
      <div class="ob-times">${times}</div>
      <button class="ob-notif" id="ob-notif" type="button" aria-pressed="${obState.morningNotif}">
        <span><b>התראת בוקר עדינה</b><small>נזכיר לכם כשהסיכום מוכן</small></span>
        <span class="switch${obState.morningNotif ? " on" : ""}"></span>
      </button>
      <button class="btn btn-primary btn-lg btn-block" id="ob-finish" type="button">${icon("sun")}כניסה לסיכום</button>
      <div class="trust-line">${icon("lock")}הנתונים נשארים על המכשיר · בשליטתכם המלאה</div>
    </div>`;
}

/** Per-step event wiring. */
function obWire(step) {
  if (step === 0) {
    document.getElementById("ob-welcome-cta")?.addEventListener("click", () => obGo(1));
    return;
  }
  if (step === 1) {
    document.getElementById("ob-connect-cta")?.addEventListener("click", () => obGo(2));
    if (obState.preview) return; // placeholder QR only — no live link in preview
    const es = new EventSource("/api/onboarding/qr");
    activeEventSource = es;
    es.addEventListener("qr", (e) => {
      const { dataUrl } = JSON.parse(e.data);
      const box = document.getElementById("ob-qr");
      const hint = document.getElementById("ob-qr-hint");
      if (box && dataUrl) box.outerHTML = `<img class="qr-img" id="ob-qr" src="${dataUrl}" alt="קוד QR לקישור וואטסאפ" width="208" height="208" />`;
      if (hint) hint.textContent = "סרקו עם הטלפון";
    });
    es.addEventListener("connected", () => obGo(2));
    es.onerror = () => {}; // graceful: the manual "סרקתי — המשך" still advances
    return;
  }
  if (step === 2) {
    obRunScan();
    return;
  }
  if (step === 3) {
    if (!obState.loadedChats) {
      obLoadChats().then(() => {
        if (obState.step === 3) obPaint();
      });
      return;
    }
    obWireChats();
    return;
  }
  if (step === 4) {
    for (const btn of document.querySelectorAll(".ob-time")) {
      btn.addEventListener("click", () => {
        obState.digestTime = btn.dataset.t;
        obPaint();
      });
    }
    document.getElementById("ob-notif")?.addEventListener("click", () => {
      obState.morningNotif = !obState.morningNotif;
      obPaint();
    });
    document.getElementById("ob-finish")?.addEventListener("click", obFinish);
  }
}

/** Drive the scan ring + checklist with a timed simulation, overridden by real
 *  /api/onboarding/progress events when a live sync is streaming. Advances to
 *  the chat picker on completion. */
function obRunScan() {
  let pct = 0;
  const quips = [
    "ממיין הודעות חשובות מרעש…",
    "מאתר מה מחכה לתשובה…",
    "מחבר נקודות בין שיחות…",
    "כמעט שם — מסדר את הבוקר שלך ✦",
  ];
  let q = 0;
  const items = obScanItems().length;
  const apply = (p) => {
    pct = Math.max(0, Math.min(100, p));
    const ring = document.getElementById("ob-ring");
    const pctEl = document.getElementById("ob-pct");
    if (ring) ring.style.setProperty("--p", String(pct));
    if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    const active = Math.min(items - 1, Math.floor(pct / (100 / items)));
    for (const el of document.querySelectorAll(".ob-scan-item")) {
      const k = Number(el.dataset.k);
      const ok = pct >= (k + 1) * (100 / items);
      el.classList.toggle("ok", ok);
      el.classList.toggle("active", !ok && k === active);
      let dots = el.querySelector(".ob-dots");
      if (!ok && k === active && !dots) {
        dots = document.createElement("span");
        dots.className = "ob-dots";
        dots.innerHTML = "<i></i><i></i><i></i>";
        el.appendChild(dots);
      } else if ((ok || k !== active) && dots) {
        dots.remove();
      }
      if (ok && !el.querySelector(".ob-scan-tick")) {
        const tick = document.createElement("span");
        tick.className = "ob-scan-tick";
        tick.innerHTML = icon("check", { size: 13 });
        el.appendChild(tick);
      }
    }
  };
  const finish = () => {
    obTeardown();
    if (obState.step === 2) obGo(3);
  };
  // Live link: let the REAL history-sync progress drive completion. The simulated
  // fill only animates up to a cap, then waits for the real `done` — so we never
  // advance to the chat picker before the user's chats have actually synced. A safety
  // timeout still advances if no progress/`done` ever arrives (already-synced account,
  // or a stream error). Preview keeps filling to 100 on its own.
  const live = !obState.preview;
  const simCap = live ? 90 : 100;
  const tick = setInterval(() => {
    if (pct < simCap) apply(Math.min(pct + 1, simCap));
    if (pct >= 100) {
      clearInterval(tick);
      setTimeout(finish, 600);
    }
  }, 55);
  const quipTimer = setInterval(() => {
    q = (q + 1) % quips.length;
    const el = document.getElementById("ob-quip");
    if (el) el.textContent = quips[q];
  }, 1700);
  obState.timers.push(tick, quipTimer);
  if (live) {
    const es = new EventSource("/api/onboarding/progress");
    activeEventSource = es;
    es.addEventListener("progress", (e) => {
      const { progress } = JSON.parse(e.data);
      if (typeof progress === "number") apply(Math.max(pct, progress));
    });
    es.addEventListener("done", () => {
      apply(100);
      finish();
    });
    es.onerror = () => {}; // the safety timeout below still advances the flow
    // Safety net: never stall on the scan step if no progress/`done` arrives.
    obState.timers.push(
      setTimeout(() => {
        apply(100);
        finish();
      }, 45000),
    );
  }
}

/** Load the user's most-active chats into the picker (default all included). */
async function obLoadChats() {
  let groups = [];
  try {
    groups = await getGroups();
  } catch {
    groups = [];
  }
  obState.chats = groups
    .slice(0, 40)
    .map((g) => ({ name: g.name, hue: hueFromName(g.name), included: true }));
  obState.loadedChats = true;
}

function obWireChats() {
  const recount = () => {
    const on = obState.chats.filter((c) => c.included).length;
    const cnt = document.getElementById("ob-count");
    if (cnt) cnt.textContent = `${on} נבחרו`;
    const cta = document.getElementById("ob-chats-cta");
    if (cta) {
      cta.textContent = `המשך עם ${on} צ׳אטים`;
      cta.disabled = on === 0;
    }
    const bulk = document.getElementById("ob-bulk");
    if (bulk) bulk.textContent = on === obState.chats.length ? "כבה הכול" : "הפעל הכול";
  };
  for (const pill of document.querySelectorAll(".ob-chat-pill")) {
    pill.addEventListener("click", () => {
      const i = Number(pill.dataset.i);
      obState.chats[i].included = !obState.chats[i].included;
      pill.classList.toggle("on", obState.chats[i].included);
      pill.querySelector(".ob-chat-check").innerHTML = obState.chats[i].included
        ? icon("check", { size: 14 })
        : icon("plus", { size: 14 });
      recount();
    });
  }
  document.getElementById("ob-bulk")?.addEventListener("click", () => {
    const allOn = obState.chats.every((c) => c.included);
    for (const c of obState.chats) c.included = !allOn;
    obPaint();
  });
  document.getElementById("ob-chats-cta")?.addEventListener("click", () => obCommitChats(true));
  document.getElementById("ob-chats-skip")?.addEventListener("click", () => obCommitChats(false));
}

/** Persist the chat selection (seeding the engine's scopes) then advance. In
 *  preview mode we don't write — the flow is just being reviewed. */
async function obCommitChats(useSelection) {
  if (!obState.preview && obState.loadedChats && obState.chats.length) {
    // "אבחר אחר כך" defers curation — keep the default all-on selection rather than
    // excluding everything (the whitelist is default-OFF server-side, so writing false
    // for all chats would seed an empty first digest, contradicting Step 4).
    const updates = obState.chats.map((c) => ({ group: c.name, included: useSelection ? c.included : true }));
    await putScopes(updates).catch(() => {});
  }
  obGo(4);
}

/** Save the digest preferences, mark onboarding done, and enter the app. */
async function obFinish() {
  // Immediate feedback + double-click guard.
  const btn = document.getElementById("ob-finish");
  if (btn) {
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.textContent = "נכנסים…";
  }
  if (!obState.preview) {
    // Digest time/notification choices above are UX-only here — the schedule comes
    // from the DIGEST_TIMES env var; there is no settings UI to persist a per-user
    // override to.
    try {
      localStorage.setItem("sumbox-onboarded", "1");
    } catch {
      /* ignore storage failures */
    }
  }
  obTeardown();
  location.href = "/"; // drops ?onboarding=preview; boot loads the app
}

async function boot() {
  if (!(await checkOnboarding())) return;
  renderShell();
  if (DEMO) applyHealth(true);
  else startHealthPolling();
  wireCopyButton();
  wireShowThread();
  wireSummaryRate();

  const route = resolveInitialRoute();
  await loadGroupsIntoList();

  if (route.view === "detail") {
    renderDetail(route.group, true);
  } else if (route.view === "total") {
    renderTotal(true);
  } else if (route.view === "sources") {
    renderSources();
  } else if (route.view === "commands") {
    renderCommands();
  } else {
    renderSumbox();
  }
}

boot();
