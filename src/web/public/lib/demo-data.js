/**
 * demo-data.js — fabricated placeholder data for screenshots / offline preview.
 *
 * Activated only when the page URL has a `?demo=` query (off by default, never
 * touches the API or any real WhatsApp data). Used to produce README images
 * with dummy content. Group names/summaries here are invented examples.
 */

const MIN = 60 * 1000;
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();

/** Invented groups — fresh ones first, then stale. `summaryPreview` mirrors the
 *  real /api/groups field: chats with a cached catch-up show a one-liner, the
 *  rest fall back to the "tap to summarize" CTA. */
export const DEMO_GROUPS = [
  {
    name: "צוות עבודה",
    source: "group",
    messageCount: 0,
    lastMessageAt: ago(9 * MIN),
    newCount: 12,
    summaryPreview: "פגישת הצוות נקבעה ליום שלישי 10:00, ודני מסיים את המסמך עד חמישי.",
  },
  {
    name: "משפחה ❤️",
    source: "group",
    messageCount: 0,
    lastMessageAt: ago(42 * MIN),
    newCount: 5,
    summaryPreview: "ארוחת שישי אצל סבתא ב-19:00 — אמא מביאה קינוח, ומתאמים הפתעה לאבא.",
  },
  {
    name: "חברים מהטיול",
    source: "group",
    messageCount: 0,
    lastMessageAt: ago(3 * 60 * MIN),
    newCount: 3,
    summaryPreview: "מתכננים פיקניק בפארק בשבת, ומתלבטים בין הגולן למדבר לטיול הסתיו.",
  },
  {
    name: "ועד הבית",
    source: "group",
    messageCount: 0,
    lastMessageAt: ago(2 * 24 * 60 * MIN),
    summaryPreview: "אושר תיקון המעלית; דנים בהעלאת דמי הוועד מהחודש הבא.",
  },
  { name: "מועדון ריצה 🏃", source: "group", messageCount: 0, lastMessageAt: ago(4 * 24 * 60 * MIN) },
  { name: "קבוצת לימוד", source: "group", messageCount: 0, lastMessageAt: ago(9 * 24 * 60 * MIN) },
];

/** Per-group dummy summaries (markdown), keyed by group name — each contextually
 *  coherent so the family chat shows family content, the work chat work content, etc. */
export const DEMO_SUMMARIES = {
  "משפחה ❤️": [
    "**ארוחת שישי:** נפגשים אצל סבתא ב־19:00, אמא מביאה קינוח.",
    "",
    "**יום הולדת:** מתאמים הפתעה לאבא בסוף החודש — דנה אוספת כסף למתנה.",
    "",
    "**הסעות:** מי אוסף את הילדים מהחוג ביום רביעי? יואב התנדב.",
  ].join("\n"),
  "צוות עבודה": [
    "**פגישת צוות:** נקבעה ליום שלישי 10:00, נטע תשלח הזמנה ביומן.",
    "",
    "**משימות פתוחות:** דני מסיים את המסמך עד חמישי; רוני בודקת את התקציב.",
    "",
    "**החלטה:** עוברים לכלי הניהול החדש מתחילת החודש הבא.",
  ].join("\n"),
  "חברים מהטיול": [
    "**מפגש הבא:** מציעים פיקניק בפארק בשבת הקרובה אחה״צ.",
    "",
    "**תמונות:** מאיה העלתה אלבום מהטיול הצפוני — שווה לראות.",
    "",
    "**טיול הבא:** מתלבטים בין הגולן למדבר יהודה לחופשת הסתיו.",
  ].join("\n"),
};

/** Fallback summary for any group without a tailored entry. */
export const DEMO_SUMMARY = DEMO_SUMMARIES["צוות עבודה"];

/** Structured (version-2) demo summaries — the same shape the real summarizer
 *  emits, so demo mode showcases the topics / decisions / open-questions card
 *  (`buildStructuredSummaryCard`) exactly as production renders it. Keyed by group. */
export const DEMO_STRUCTURED = {
  "צוות עבודה": {
    version: 2,
    tldr: "סגירת הספרינט בעיצומה. נקבע דדליין ליום חמישי, ונותר רק אישור התקציב מול ההנהלה.",
    topics: [
      { text: "**דדליין:** הספרינט נסגר ביום חמישי — בלי דחיות הפעם." },
      { text: "**תקציב:** ממתינים לאישור ההנהלה לפני הסגירה הסופית." },
      { text: "**חלוקת עבודה:** כל אחד משלים את המשימות שלו עוד היום." },
    ],
    decisions: [
      { text: "דדליין סופי נקבע ליום חמישי." },
      { text: "נועה תדבר עם רון על אישור התקציב." },
    ],
    openQuestions: [{ text: "האם התקציב יאושר בזמן לסגירת הספרינט?" }],
  },
  "משפחה ❤️": {
    version: 2,
    tldr: "ארוחת שישי אצל סבתא ב־19:00, ומתחילים לתאם הפתעת יום הולדת לאבא.",
    topics: [
      { text: "**ארוחת שישי:** נפגשים אצל סבתא ב־19:00, אמא מביאה קינוח." },
      { text: "**יום הולדת:** מתאמים הפתעה לאבא בסוף החודש." },
      { text: "**הסעות:** יואב התנדב לאסוף את הילדים מהחוג ביום רביעי." },
    ],
    decisions: [
      { text: "דנה אוספת כסף למתנה המשותפת." },
      { text: "אמא אחראית על הקינוח לשישי." },
    ],
    openQuestions: [{ text: "מי מזמין את דוד יוסי להפתעה?" }],
  },
};

/** A dummy total-summary highlights block (markdown). */
export const DEMO_TOTAL_HIGHLIGHTS = [
  "## מה קרה היום",
  "- **צוות עבודה:** נקבעה פגישה ליום שלישי.",
  "- **משפחה:** מתאמים ארוחה משותפת לשבת.",
  "- **חברים מהטיול:** מחפשים תאריך למפגש הבא.",
].join("\n");

/** Dummy per-chat breakdown for the total view. */
export const DEMO_TOTAL_PERCHAT = [
  { name: "צוות עבודה", messageCount: 128, summary: "תיאום פגישה ומשימות לשבוע." },
  { name: "משפחה ❤️", messageCount: 64, summary: "תכנון ארוחה משפחתית בשבת." },
  { name: "חברים מהטיול", messageCount: 31, summary: "רעיונות למפגש הבא." },
];

/** Dummy /סיכום command trigger + per-group permission list for the פקודות tab. */
export const DEMO_SUMMARY_COMMANDS = {
  trigger: "/סיכום",
  groups: [
    { groupId: 1, name: "כדורגל רביעי", whatsappId: "1@g.us", enabled: true },
    { groupId: 2, name: "משפחה", whatsappId: "2@g.us", enabled: false },
    { groupId: 3, name: "שכונה", whatsappId: "3@g.us", enabled: false },
  ],
};
