/**
 * label-sheet.ts — a self-contained HTML page for measuring Rosey's extraction
 * by hand: mark each found task real / not a task / duplicate, and tick any
 * message whose task she missed. The counts (and a copyable JSON of the labels)
 * update live. Precision needs a person; this makes that person's job quick.
 *
 * It embeds chat text, so it is written to a local file only — never served.
 */

import type { RoseySourceMessage, RoseyTaskView } from "../db/repositories/rosey-tasks.js";
import { resolveSenderName } from "../summarization/sender-name.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderLabelSheet(input: {
  groupId: number;
  tasks: readonly RoseyTaskView[];
  messages: readonly RoseySourceMessage[];
}): string {
  const byId = new Map(input.messages.map((m) => [m.messageId, m]));
  const withTask = new Set(input.tasks.map((t) => t.sourceMessageId));
  const taskRows = input.tasks
    .map((t) => {
      const src = byId.get(t.sourceMessageId);
      const who = t.raisedBy ? resolveSenderName(t.raisedBy) : "?";
      const opts = (["real", "not", "dup"] as const)
        .map(
          (v) =>
            `<label><input type="radio" name="t${t.id}" value="${v}" data-task="${t.id}">${{ real: "משימה", not: "לא משימה", dup: "כפילות" }[v]}</label>`,
        )
        .join("");
      return `<tr><td class="num">${t.id}</td><td><strong>${esc(t.title)}</strong><div class="src">${esc(src?.content ?? "(ההודעה מחוץ לחלון)")}</div></td><td class="meta">${esc(who)}<br>${t.raisedAt.toISOString().slice(0, 10)}<br>${t.status}</td><td class="opts">${opts}</td></tr>`;
    })
    .join("\n");
  const untasked = input.messages.filter((m) => !withTask.has(m.messageId));
  const missRows = untasked
    .map(
      (m) =>
        `<tr><td class="num">${m.messageId}</td><td>${esc(m.content)}</td><td class="meta">${esc(resolveSenderName(m.sender))}<br>${m.sentAt.toISOString().slice(0, 10)}</td><td class="opts"><label><input type="checkbox" data-missed="${m.messageId}">פוספסה משימה</label></td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rosey labels</title>
<style>
:root{--bg:#fbfbf9;--fg:#1d1f1c;--muted:#6b7068;--line:#e4e6e0;--accent:#5f7d63;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161815;--fg:#e8eae5;--muted:#9aa096;--line:#2c2f2a;--accent:#8fb093;--card:#1d201c}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:980px;margin:auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.lead{color:var(--muted);margin:0 0 16px}
.bar{position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.bar b{color:var(--accent)}button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
table{width:100%;border-collapse:collapse;background:var(--card)}td{border-bottom:1px solid var(--line);padding:8px;vertical-align:top}
.num{color:var(--muted);font-variant-numeric:tabular-nums;width:4em}.meta{color:var(--muted);font-size:13px;white-space:nowrap}
.src{color:var(--muted);font-size:13px;margin-top:4px;white-space:pre-wrap}.opts label{display:block;white-space:nowrap}
textarea{width:100%;height:90px;margin-top:8px;background:var(--card);color:var(--fg);border:1px solid var(--line)}
</style></head><body><main>
<h1>Rosey: labelling sheet, group ${input.groupId}</h1>
<p class="lead">סמנו כל משימה שנמצאה, וסמנו הודעות שהייתה בהן משימה שפוספסה. נשמר רק בדפדפן הזה.</p>
<div class="bar"><span>תויגו <b id="done">0</b>/${input.tasks.length}</span><span>משימה <b id="real">0</b></span><span>לא משימה <b id="not">0</b></span><span>כפילות <b id="dup">0</b></span><span>פוספסו <b id="missed">0</b></span><button id="copy">העתקת תוצאות</button></div>
<h2>משימות שנמצאו (${input.tasks.length})</h2>
<table>${taskRows}</table>
<h2>הודעות ללא משימה (${untasked.length})</h2>
<table>${missRows}</table>
<textarea id="out" readonly></textarea>
</main>
<script>
const KEY="rosey-labels-${input.groupId}";
const load=()=>{try{return JSON.parse(localStorage.getItem(KEY)||"{}")}catch{return {}}};
const save=(s)=>{try{localStorage.setItem(KEY,JSON.stringify(s))}catch{}};
const st=Object.assign({labels:{},missed:{}},load());
document.querySelectorAll("[data-task]").forEach(i=>{if(st.labels[i.dataset.task]===i.value)i.checked=true;i.onchange=()=>{st.labels[i.dataset.task]=i.value;save(st);render()}});
document.querySelectorAll("[data-missed]").forEach(i=>{i.checked=!!st.missed[i.dataset.missed];i.onchange=()=>{if(i.checked)st.missed[i.dataset.missed]=true;else delete st.missed[i.dataset.missed];save(st);render()}});
function render(){const v=Object.values(st.labels);const c=k=>v.filter(x=>x===k).length;
for(const k of ["real","not","dup"])document.getElementById(k).textContent=c(k);
document.getElementById("done").textContent=v.length;document.getElementById("missed").textContent=Object.keys(st.missed).length;
document.getElementById("out").value=JSON.stringify({group:${input.groupId},counts:{labelled:v.length,real:c("real"),not:c("not"),dup:c("dup"),missed:Object.keys(st.missed).length},labels:st.labels,missed:Object.keys(st.missed).map(Number)})}
document.getElementById("copy").onclick=()=>{const o=document.getElementById("out");o.select();navigator.clipboard?.writeText(o.value).catch(()=>{})};
render();
</script></body></html>
`;
}
