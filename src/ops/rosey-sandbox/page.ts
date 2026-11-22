/**
 * page.ts — the sandbox page, embedded so the build needs no extra asset step
 * (the build copies only src/web/public).
 *
 * RTL Hebrew, WhatsApp-like chat in the app's own sage tokens (one accent).
 * Every piece of chat content reaches the DOM through textContent, never as
 * HTML. Mixed Hebrew/English (e.g. "@Rosey") is isolated with dir="auto" and
 * <bdi>, so a trailing English word never flips sides.
 *
 * The client script is plain ES5-ish JS with no template literals, so this
 * file's own template string needs no escaping.
 */

export const SANDBOX_PAGE = String.raw`<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ארגז החול של רוזי</title>
<link rel="icon" href="data:,">
<style>
@font-face{font-family:"Heebo";font-weight:400;font-display:swap;src:url("/fonts/heebo-400-hebrew.woff2") format("woff2");unicode-range:U+0590-05FF,U+FB1D-FB4F}
@font-face{font-family:"Heebo";font-weight:400;font-display:swap;src:url("/fonts/heebo-400-latin.woff2") format("woff2");unicode-range:U+0000-024F}
@font-face{font-family:"Heebo";font-weight:500;font-display:swap;src:url("/fonts/heebo-500-hebrew.woff2") format("woff2");unicode-range:U+0590-05FF,U+FB1D-FB4F}
@font-face{font-family:"Heebo";font-weight:500;font-display:swap;src:url("/fonts/heebo-500-latin.woff2") format("woff2");unicode-range:U+0000-024F}
@font-face{font-family:"Heebo";font-weight:700;font-display:swap;src:url("/fonts/heebo-700-hebrew.woff2") format("woff2");unicode-range:U+0590-05FF,U+FB1D-FB4F}
@font-face{font-family:"Heebo";font-weight:700;font-display:swap;src:url("/fonts/heebo-700-latin.woff2") format("woff2");unicode-range:U+0000-024F}

/* The app's tokens (src/web/public/styles.css), light and dark. */
:root{color-scheme:light;--stage:#e9ece6;--bg:#fbfcfa;--surface:#fff;--surface-2:#f3f5f1;--ink:#1a1f1b;--ink-2:#4b524c;--muted:#888f88;--line:rgba(26,31,27,.10);--hover:rgba(26,31,27,.04);--accent:#52806a;--accent-ink:#2e4d3d;--accent-weak:#e7efe9;--on-accent:#fff;--warn-ink:#7c5418;--warn-weak:#f4ebda;--shadow-soft:0 1px 2px rgba(26,31,27,.06),0 4px 16px rgba(26,31,27,.05);--font-body:"Heebo",system-ui,sans-serif;--font-mono:ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--stage:#0c0e10;--bg:#16191c;--surface:#1e2226;--surface-2:#23282d;--ink:#e9ece9;--ink-2:#aab2ad;--muted:#7c847e;--line:rgba(255,255,255,.10);--hover:rgba(255,255,255,.05);--accent:#74a98c;--accent-ink:#bfe0cc;--accent-weak:rgba(116,169,140,.18);--on-accent:#0f211a;--warn-ink:#e6c489;--warn-weak:rgba(205,160,95,.16);--shadow-soft:0 1px 2px rgba(0,0,0,.4),0 4px 18px rgba(0,0,0,.35)}}

*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
html,body{height:100%}
body{background:var(--stage);color:var(--ink);font:15px/1.45 var(--font-body)}
button,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:6px 12px}
button:hover{background:var(--surface-2)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
button:disabled{opacity:.5;cursor:default}
.auto{unicode-bidi:plaintext}

.app{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;max-width:1120px;margin:0 auto;padding:16px;height:100%}
@media (max-width:820px){.app{grid-template-columns:minmax(0,1fr);height:auto;padding:0 0 16px;gap:12px}}

/* ── The chat ─────────────────────────────────── */
.phone{display:flex;flex-direction:column;min-height:0;background:var(--bg);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow-soft)}
@media (max-width:820px){.phone{border-radius:0;border-inline:0;height:100svh}}
.top{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface);border-bottom:1px solid var(--line)}
.top .av{width:36px;height:36px;border-radius:50%;background:var(--accent-weak);display:grid;place-items:center;flex:none}
.top .who{flex:1;min-width:0}
.top b{display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top small{color:var(--muted);font-size:12px}
.badge{font-size:11px;color:var(--ink-2);border:1px solid var(--line);border-radius:10px;padding:1px 8px;white-space:nowrap}
.chat{flex:1;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:6px}
.day{align-self:center;background:var(--surface);color:var(--muted);font-size:12px;border-radius:8px;padding:2px 10px;margin:6px 0}
.msg{position:relative;max-width:82%;padding:6px 9px 3px;border-radius:9px;background:var(--surface);box-shadow:0 1px 1px var(--line);overflow-wrap:anywhere;align-self:flex-start}
.msg.me{background:var(--accent-weak);align-self:flex-end}
.msg .name{font-size:12.5px;font-weight:500;color:var(--accent-ink)}
.msg .text{white-space:pre-wrap}
.msg .kind{font-size:12px;color:var(--muted)}
.msg .meta{display:flex;gap:6px;justify-content:flex-end;font-size:11px;color:var(--muted);margin-top:1px}
.msg .reply{border:0;background:none;padding:0;font-size:11px;color:var(--muted)}
.msg .reply:hover{color:var(--ink)}
.quote{border-inline-start:3px solid var(--accent);background:var(--hover);border-radius:6px;padding:3px 8px;margin:2px 0 4px;font-size:13px;color:var(--ink-2);max-height:3.2em;overflow:hidden}
.quote b{display:block;font-size:12px;font-weight:500;color:var(--accent-ink)}

/* ── A poll, as WhatsApp draws one ─────────────── */
.poll{min-width:min(300px,82%)}
.poll .q{font-weight:700;margin:2px 0}
.poll .hint{font-size:12px;color:var(--muted);margin-bottom:4px}
.opt{display:block;width:100%;text-align:start;border:0;background:none;padding:5px 0;border-radius:6px}
.opt:hover{background:var(--hover)}
.opt .row{display:flex;align-items:center;gap:8px}
.opt .lab{flex:1}
.opt .n{font-size:13px;color:var(--muted);min-width:1em;text-align:center}
.check{width:20px;height:20px;border-radius:50%;border:2px solid var(--muted);flex:none;display:grid;place-items:center;font-size:12px;line-height:1;color:var(--on-accent)}
.check.on{background:var(--accent);border-color:var(--accent)}
.bar{height:4px;background:var(--line);border-radius:2px;margin:4px 28px 0 0;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);border-radius:2px}
.voters{display:flex;gap:2px;margin:3px 28px 0 0}
.voter{width:18px;height:18px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line);font-size:10px;display:grid;place-items:center;color:var(--ink-2)}
.poll .foot{border-top:1px solid var(--line);margin-top:4px;padding-top:4px;font-size:12px;color:var(--muted)}

/* ── The composer ──────────────────────────────── */
.compose{border-top:1px solid var(--line);background:var(--surface);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.compose .as{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-2)}
.compose select{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:3px 6px;max-width:220px}
.compose .line{display:flex;gap:8px;align-items:flex-end}
.compose textarea{flex:1;resize:none;border:1px solid var(--line);background:var(--bg);border-radius:18px;padding:8px 14px;min-height:40px;max-height:120px}
.quoting{display:flex;gap:8px;align-items:center}
.quoting .quote{flex:1;margin:0}
.quoting button{border:0;background:none;padding:2px 6px;color:var(--muted)}

/* ── The side panel ────────────────────────────── */
.side{display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto}
@media (max-width:820px){.side{padding:0 12px;overflow:visible}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.card h2{font-size:14px;font-weight:500;color:var(--ink-2);margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline}
.card h2 small{font-weight:400;color:var(--muted);font-size:12px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;border-radius:0;padding:5px 10px;background:var(--surface)}
.seg button[aria-pressed="true"]{background:var(--accent-weak);color:var(--accent-ink);font-weight:500}
.group-h{font-size:12px;color:var(--muted);margin:10px 0 4px}
.group-h:first-of-type{margin-top:0}
.task{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:1px solid var(--line)}
.task:first-child{border-top:0}
.task .t{display:flex;gap:6px;align-items:baseline}
.task .t span{flex:1}
.task.closed .t span{color:var(--muted);text-decoration:line-through}
.task .src{font-size:11px;color:var(--muted)}
.task .acts{display:flex;gap:6px}
.task .acts button{font-size:12px;padding:2px 8px}
.empty{color:var(--muted);font-size:13px}
.log{font:12px/1.5 var(--font-mono);direction:ltr;text-align:left;max-height:260px;overflow-y:auto;color:var(--ink-2)}
.log div{padding:2px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
.log .warn{color:var(--warn-ink)}
.log .error{color:var(--warn-ink);font-weight:500}
.banner{background:var(--warn-weak);color:var(--warn-ink);border-radius:8px;padding:6px 10px;font-size:13px}
</style>
</head>
<body>
<div class="app">
  <section class="phone" aria-label="הצ'אט">
    <header class="top">
      <div class="av" aria-hidden="true">👥</div>
      <div class="who"><b id="gname" dir="auto"></b><small>ארגז חול · בלי וואטסאפ</small></div>
      <span class="badge" id="model" dir="ltr"></span>
    </header>
    <div class="chat" id="chat" aria-live="polite"></div>
    <form class="compose" id="compose">
      <div class="as"><label for="sender">כותב/ת בתור</label><select id="sender"></select></div>
      <div class="quoting" id="quoting" hidden><div class="quote" id="quoted"></div><button type="button" id="unquote" aria-label="בטל ציטוט">✕</button></div>
      <div class="line">
        <textarea id="text" rows="1" dir="auto" placeholder="הודעה… (למשל @רוזי לקנות חלב)"></textarea>
        <button class="primary" type="submit" id="send">שליחה</button>
      </div>
    </form>
  </section>

  <aside class="side">
    <div class="card">
      <h2>רוזי <small id="status"></small></h2>
      <div class="controls">
        <button type="button" id="suggest">הרצת סבב הצעות עכשיו</button>
        <span class="seg" role="group" aria-label="סגנון רשימה">
          <button type="button" data-style="poll">סקרים</button><button type="button" data-style="text">טקסט</button>
        </span>
        <button type="button" id="reset">איפוס ארגז החול</button>
      </div>
    </div>
    <div class="card">
      <h2>הרשימה <small id="counts"></small></h2>
      <div id="tasks"></div>
    </div>
    <div class="card">
      <h2>יומן <small>מה רוזי עשתה ולמה</small></h2>
      <div class="log" id="log"></div>
    </div>
  </aside>
</div>

<script>
(function () {
  "use strict";
  var state = null, lastJson = "", quoted = null, busy = false;
  var STATUS = { suggested: "מוצעות", open: "פתוחות", done: "בוצעו", dropped: "בוטלו" };
  var ORDER = ["suggested", "open", "done", "dropped"];
  var ACTIONS = { open: "אישור", done: "בוצע", dropped: "ביטול" };
  var SOURCE = { manual: "ידני", tag: "תיוג", reply: "תגובה", react: "אימוג'י", poll: "סקר", inferred: "הסקה", model: "מודל" };
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Chat text: RTL whenever it holds Hebrew (as WhatsApp lays it out), with each
  // @mention isolated so "@Rosey" never renders as "Rosey@" inside Hebrew.
  var HEBREW = /[\u0590-\u05FF]/, MENTION = /(@[A-Za-z][\w.-]*)/;
  function auto(tag, cls, text) {
    var e = el(tag, cls);
    text = text == null ? "" : String(text);
    e.dir = HEBREW.test(text) ? "rtl" : "auto";
    text.split(MENTION).forEach(function (part, i) {
      if (!part) return;
      e.appendChild(i % 2 ? bdi(part) : document.createTextNode(part));
    });
    return e;
  }
  function bdi(text) { var b = document.createElement("bdi"); b.textContent = text; return b; }
  function hhmm(t) { var d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function dayOf(t) { return new Date(t).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "numeric" }); }
  function initial(name) { return (name || "?").trim().charAt(0) || "?"; }

  function api(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function act(path, body) {
    return api(path, body).then(refresh).catch(function (e) { banner(e.message); });
  }
  function banner(text) {
    var b = $("status"); b.textContent = text; b.style.color = "var(--warn-ink)";
    setTimeout(function () { b.style.color = ""; render(true); }, 4000);
  }
  function senderIndex() { return Number($("sender").value || 0); }
  function memberName(i) { var m = state && state.members[i]; return m ? m.name : "?"; }

  // ── The timeline: stored messages and her polls, by time ─────────
  function timeline() {
    var items = state.history.map(function (h) { return { at: Date.parse(h.sentAt), msg: h }; });
    state.polls.forEach(function (p) { items.push({ at: p.at, poll: p }); });
    items.sort(function (a, b) { return a.at - b.at; });
    return items;
  }
  function byExternal(id) {
    for (var i = 0; i < state.history.length; i++) if (state.history[i].externalId === id) return state.history[i];
    return null;
  }
  function senderLabel(h) { return h.rosey ? "🤖 רוזי" : h.aida ? "Aida" : (h.sender || "?"); }
  function quoteBlock(id) {
    var q = byExternal(id), box = el("div", "quote");
    if (!q) { box.textContent = "הודעה מצוטטת"; return box; }
    var b = el("b"); b.appendChild(bdi(senderLabel(q))); box.appendChild(b);
    box.appendChild(auto("span", "", q.text || "מדיה"));
    return box;
  }

  function messageEl(h) {
    var m = el("div", "msg" + (h.fromMe ? " me" : ""));
    var name = el("div", "name"); name.appendChild(bdi(senderLabel(h))); m.appendChild(name);
    if (h.quotedId) m.appendChild(quoteBlock(h.quotedId));
    if (h.source === "voice") m.appendChild(el("div", "kind", "🎤 הודעה קולית (תמלול)"));
    if (h.source === "media") m.appendChild(el("div", "kind", "🖼️ מדיה (תיאור)"));
    m.appendChild(auto("div", "text", h.text || (h.source === "none" ? "מדיה ללא תיאור" : "")));
    var meta = el("div", "meta");
    if (h.externalId) {
      var r = el("button", "reply", "↩ ציטוט"); r.type = "button";
      r.onclick = function () { setQuote(h); };
      meta.appendChild(r);
    }
    meta.appendChild(el("span", "", hhmm(h.sentAt)));
    m.appendChild(meta);
    return m;
  }

  function pollEl(p) {
    var m = el("div", "msg me poll");
    var name = el("div", "name"); name.appendChild(bdi("🤖 רוזי")); m.appendChild(name);
    if (p.quotedId) m.appendChild(quoteBlock(p.quotedId));
    m.appendChild(auto("div", "q", p.name));
    m.appendChild(el("div", "hint", "אפשר לבחור כמה אפשרויות · מצביע/ה: " + memberName(senderIndex())));
    var me = senderIndex(), total = 0, perOpt = p.options.map(function () { return []; });
    Object.keys(p.votes).forEach(function (k) {
      p.votes[k].forEach(function (o) { perOpt[o].push(Number(k)); total++; });
    });
    var voters = Object.keys(p.votes).filter(function (k) { return p.votes[k].length; }).length;
    p.options.forEach(function (label, i) {
      var b = el("button", "opt"); b.type = "button";
      var row = el("div", "row");
      var mine = (p.votes[me] || []).indexOf(i) >= 0;
      row.appendChild(el("span", "check" + (mine ? " on" : ""), mine ? "✓" : ""));
      row.appendChild(auto("span", "lab", label));
      row.appendChild(el("span", "n", String(perOpt[i].length)));
      b.appendChild(row);
      var bar = el("div", "bar"), fill = el("i");
      fill.style.width = (voters ? Math.round((perOpt[i].length / voters) * 100) : 0) + "%";
      bar.appendChild(fill); b.appendChild(bar);
      if (perOpt[i].length) {
        var vs = el("div", "voters");
        perOpt[i].forEach(function (v) { var a = el("span", "voter", initial(memberName(v))); a.title = memberName(v); vs.appendChild(a); });
        b.appendChild(vs);
      }
      b.setAttribute("aria-pressed", mine ? "true" : "false");
      b.onclick = function () { act("/api/vote", { pollId: p.id, member: senderIndex(), option: i }); };
      m.appendChild(b);
    });
    var foot = el("div", "foot");
    foot.appendChild(el("span", "", voters + " הצביעו · " + hhmm(p.at)));
    m.appendChild(foot);
    return m;
  }

  function renderChat() {
    var chat = $("chat"), atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    chat.textContent = "";
    var lastDay = "";
    var items = timeline();
    if (!items.length) chat.appendChild(el("div", "day", "אין הודעות בשבעת הימים האחרונים"));
    items.forEach(function (it) {
      var d = dayOf(it.at);
      if (d !== lastDay) { chat.appendChild(el("div", "day", d)); lastDay = d; }
      chat.appendChild(it.poll ? pollEl(it.poll) : messageEl(it.msg));
    });
    if (atBottom || !renderChat.done) chat.scrollTop = chat.scrollHeight;
    renderChat.done = true;
  }

  // ── The list panel ───────────────────────────────────────────────
  function renderTasks() {
    var box = $("tasks"); box.textContent = "";
    var counts = [];
    ORDER.forEach(function (status) {
      var items = state.tasks.filter(function (t) { return t.status === status; });
      counts.push(items.length + " " + STATUS[status]);
      if (!items.length) return;
      box.appendChild(el("div", "group-h", STATUS[status]));
      items.forEach(function (t) {
        var row = el("div", "task" + (status === "done" || status === "dropped" ? " closed" : ""));
        var line = el("div", "t");
        if (t.kind === "grocery") line.appendChild(el("span", "", "🛒")).style.flex = "none";
        line.appendChild(auto("span", "", t.title));
        row.appendChild(line);
        var src = SOURCE[t.statusSource] || t.statusSource || "";
        row.appendChild(el("div", "src", "#" + t.id + (src ? " · " + src : "") + (t.statusSource === "manual" ? " · נעול ידנית" : "")));
        var acts = el("div", "acts");
        ["open", "done", "dropped"].forEach(function (s) {
          if (s === status) return;
          var b = el("button", "", s === "open" && status !== "suggested" ? "פתיחה מחדש" : ACTIONS[s]); b.type = "button";
          b.onclick = function () { act("/api/task", { id: t.id, status: s }); };
          acts.appendChild(b);
        });
        row.appendChild(acts);
        box.appendChild(row);
      });
    });
    if (!state.tasks.length) box.appendChild(el("div", "empty", "אין עדיין פריטים. כתבו \"@רוזי …\" או הריצו סבב הצעות."));
    $("counts").textContent = counts.join(" · ");
  }

  function renderLog() {
    var box = $("log"); box.textContent = "";
    state.events.slice().reverse().forEach(function (e) {
      box.appendChild(el("div", e.level, hhmm(e.at) + "  " + e.line));
    });
  }

  function renderSenders() {
    var sel = $("sender"), keep = sel.value;
    if (sel.options.length === state.members.length) return;
    sel.textContent = "";
    state.members.forEach(function (m, i) {
      var o = el("option", "", m.name + (m.owner ? " (הבעלים)" : "")); o.value = String(i); sel.appendChild(o);
    });
    sel.value = keep && Number(keep) < state.members.length ? keep : "0";
  }

  function render(force) {
    if (!state) return;
    $("gname").textContent = state.group.name;
    $("model").textContent = state.model;
    var st = $("status");
    st.textContent = !state.running ? "מושבתת — לחצו איפוס" : state.passRunning ? "סבב הצעות רץ…" : "מוכנה";
    $("suggest").disabled = state.passRunning;
    document.querySelectorAll(".seg button").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.style === state.listStyle ? "true" : "false");
    });
    renderSenders();
    renderChat();
    renderTasks();
    renderLog();
  }

  function refresh() {
    return fetch("/api/state").then(function (r) {
      if (r.status === 503) { $("status").textContent = "מאפסת…"; return; }
      return r.text().then(function (t) {
        if (t === lastJson) return;
        lastJson = t; state = JSON.parse(t); render();
      });
    }).catch(function () { $("status").textContent = "אין חיבור לשרת"; });
  }

  function setQuote(h) {
    quoted = h;
    var box = $("quoted"); box.textContent = "";
    var b = el("b"); b.appendChild(bdi(senderLabel(h))); box.appendChild(b);
    box.appendChild(auto("span", "", h.text || "מדיה"));
    $("quoting").hidden = false; $("text").focus();
  }
  $("unquote").onclick = function () { quoted = null; $("quoting").hidden = true; };

  $("compose").onsubmit = function (ev) {
    ev.preventDefault();
    var text = $("text").value.trim();
    if (!text || busy) return;
    busy = true; $("send").disabled = true;
    api("/api/post", { member: senderIndex(), text: text, quotedId: quoted ? quoted.externalId : null })
      .then(function () { $("text").value = ""; quoted = null; $("quoting").hidden = true; return refresh(); })
      .catch(function (e) { banner(e.message); })
      .then(function () { busy = false; $("send").disabled = false; });
  };
  $("text").onkeydown = function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("compose").requestSubmit(); }
  };
  $("sender").onchange = function () { lastJson = ""; refresh(); };
  $("suggest").onclick = function () { act("/api/suggest"); };
  $("reset").onclick = function () {
    if (!confirm("לאפס? כל השינויים בארגז החול יימחקו והקבוצה תועתק מחדש.")) return;
    $("status").textContent = "מאפסת…"; renderChat.done = false;
    act("/api/reset");
  };
  document.querySelectorAll(".seg button").forEach(function (b) {
    b.onclick = function () { act("/api/style", { style: b.dataset.style }); };
  });

  refresh();
  setInterval(refresh, 1500);
})();
</script>
</body>
</html>
`;
