/**
 * markdown.test.js — Tests for renderMarkdown (Vitest, plain JS)
 *
 * Run: npx vitest run src/web/public/lib/markdown.test.js
 */

import { describe, it, expect } from "vitest";
import { renderInline, renderMarkdown, toWhatsAppText } from "./markdown.js";

describe("renderMarkdown — tables", () => {
  it("renders a GFM table as a <table> with header + rows", () => {
    const md = "| שם | דירוג |\n|---|---|\n| North Villas | 9.6 |\n| Hotel Soa | 8.8 |";
    const out = renderMarkdown(md);
    expect(out).toContain("<table");
    expect(out).toContain("<th>שם</th>");
    expect(out).toContain("<th>דירוג</th>");
    expect(out).toContain("<td>North Villas</td>");
    expect(out).toContain("<td>9.6</td>");
    // the separator row itself is not rendered as a data row
    expect(out).not.toContain("<td>---</td>");
  });

  it("renders prose that immediately precedes a table (no blank line)", () => {
    const md = "הנה הטבלה:\n| א | ב |\n|---|---|\n| 1 | 2 |";
    const out = renderMarkdown(md);
    expect(out).toContain("הנה הטבלה:");
    expect(out).toContain("<table");
    expect(out).toContain("<td>1</td>");
  });

  it("leaves a lone pipe line as prose (not a table)", () => {
    const out = renderMarkdown("עלות: 5 | 10 שקלים");
    expect(out).not.toContain("<table");
  });
});

describe("renderMarkdown — headings", () => {
  it("## heading → <h3>", () => {
    const out = renderMarkdown("## כותרת");
    expect(out).toContain("<h3>כותרת</h3>");
  });

  it("### heading → <h4>", () => {
    const out = renderMarkdown("### כותרת קטנה");
    expect(out).toContain("<h4>כותרת קטנה</h4>");
  });

  it("## heading does not produce <h3> for non-heading lines", () => {
    const out = renderMarkdown("זה לא כותרת");
    expect(out).not.toContain("<h3>");
  });
});

describe("renderMarkdown — bold", () => {
  it("**text** → <strong>text</strong>", () => {
    const out = renderMarkdown("**מודגש**");
    expect(out).toContain("<strong>מודגש</strong>");
  });

  it("bold mid-sentence", () => {
    const out = renderMarkdown("הנה **מילה מודגשת** בתוך משפט");
    expect(out).toContain("<strong>מילה מודגשת</strong>");
  });
});

describe("renderMarkdown — chat tags (bidi isolation)", () => {
  it("[Chat] → bidi-isolated chip without the literal brackets", () => {
    const out = renderMarkdown("- [Bar Hevr] בדיקה");
    expect(out).toContain('<bdi class="chat-tag">Bar Hevr</bdi>');
    expect(out).not.toContain("[Bar Hevr]");
  });

  it("isolates a tag containing emoji and dates", () => {
    const out = renderMarkdown("- [Flopi 06.06.26 🎉] משהו קרה");
    expect(out).toContain('<bdi class="chat-tag">Flopi 06.06.26 🎉</bdi>');
  });

  it("wraps multiple tags on one line", () => {
    const out = renderMarkdown("- [A] ו [B] גם");
    const count = (out.match(/class="chat-tag"/g) || []).length;
    expect(count).toBe(2);
  });
});

describe("renderMarkdown — bullet lists", () => {
  it("consecutive '- ' lines → <ul> with <li> per item", () => {
    const out = renderMarkdown("- א\n- ב");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>א</li>");
    expect(out).toContain("<li>ב</li>");
  });

  it("'* ' bullet syntax also works", () => {
    const out = renderMarkdown("* ראשון\n* שני");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>ראשון</li>");
    expect(out).toContain("<li>שני</li>");
  });

  it("bullet list is wrapped in a single <ul>", () => {
    const out = renderMarkdown("- א\n- ב\n- ג");
    const ulCount = (out.match(/<ul>/g) || []).length;
    expect(ulCount).toBe(1);
  });
});

describe("renderMarkdown — paragraphs", () => {
  it("two blocks separated by blank line → two <p>", () => {
    const out = renderMarkdown("בלוק ראשון\n\nבלוק שני");
    const pCount = (out.match(/<p>/g) || []).length;
    expect(pCount).toBe(2);
  });

  it("single newline inside a block → <br>", () => {
    const out = renderMarkdown("שורה אחת\nשורה שניה");
    expect(out).toContain("<br>");
  });
});

describe("renderMarkdown — plain prose (no markdown)", () => {
  it("plain prose → wrapped in <p>", () => {
    const out = renderMarkdown("זוהי פסקה פשוטה ללא מרקדאון");
    expect(out).toContain("<p>");
    expect(out).not.toContain("<h3>");
    expect(out).not.toContain("<ul>");
  });
});

describe("renderMarkdown — HTML escaping (FR-010)", () => {
  it("<script> tag is escaped, not live markup", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("& is escaped to &amp;", () => {
    const out = renderMarkdown("a & b");
    expect(out).toContain("&amp;");
  });

  it("< is escaped to &lt;", () => {
    const out = renderMarkdown("a < b");
    expect(out).toContain("&lt;");
  });

  it("> is escaped to &gt;", () => {
    const out = renderMarkdown("a > b");
    expect(out).toContain("&gt;");
  });

  it('" is escaped to &quot;', () => {
    const out = renderMarkdown('say "hello"');
    expect(out).toContain("&quot;");
  });

  it("' is escaped to &#39;", () => {
    const out = renderMarkdown("it's fine");
    expect(out).toContain("&#39;");
  });
});

describe("renderMarkdown — empty / whitespace input", () => {
  it("empty string → empty string", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("whitespace-only → empty string", () => {
    expect(renderMarkdown("   \n  \n  ")).toBe("");
  });
});

describe("renderMarkdown — citation markers", () => {
  it("strips a single `^[#3, #5]` marker", () => {
    const out = renderMarkdown("גיא פרסם את לוח הזמנים ^[#3, #5].");
    expect(out).not.toContain("#3");
    expect(out).not.toContain("[#");
    expect(out).toContain("לוח הזמנים");
  });

  it("strips a run of separate `[#1], [#2]` markers", () => {
    const out = renderMarkdown("אין עליו מפתח [#1], [#2].");
    expect(out).not.toContain("[#");
    expect(out).not.toContain("#2");
  });

  it("keeps chat tags (no #) intact", () => {
    const out = renderMarkdown("- [Bar Hevr] עדכון ^[#7]");
    expect(out).toContain('<bdi class="chat-tag">Bar Hevr</bdi>');
    expect(out).not.toContain("[#");
  });

  // The model also emits citations WITHOUT the `#` — bracketed (`[31]`,
  // `[32, 33]`) or bare-caret (`^131, 185`). These slipped past the old
  // `[#…]`-only strip; `[31]` even rendered as a green `.chat-tag` chip.
  it("strips bare bracketed numeric refs `[31]` (no chat-tag chip leaks)", () => {
    const out = renderMarkdown("מסירה של רהיטים [31], הודעה על כרטיס [1].");
    expect(out).not.toContain("[31]");
    expect(out).not.toContain('chat-tag">31');
    expect(out).not.toContain('chat-tag">1');
    expect(out).toContain("מסירה של רהיטים");
  });

  it("strips a multi-number bracket `[32, 33]`", () => {
    const out = renderMarkdown("התלהבות מהציוד [32, 33].");
    expect(out).not.toContain("[32");
    expect(out).not.toContain("33]");
    expect(out).toContain("התלהבות מהציוד");
  });

  it("strips bare caret refs `^131, 185` and `^242`", () => {
    const out = renderMarkdown("נופים מרשימים ^131, 185 ונוף ההרים ^242.");
    expect(out).not.toContain("^131");
    expect(out).not.toContain("185");
    expect(out).not.toContain("^242");
    expect(out).toContain("נופים מרשימים");
    expect(out).toContain("ונוף ההרים");
  });

  it("leaves bare prose numbers (not caret/bracket-marked) intact", () => {
    const out = renderMarkdown("כ-290 אלף הודעות נשלחו ב-2025.");
    expect(out).toContain("290");
    expect(out).toContain("2025");
  });

  it("keeps a chat tag adjacent to a bare numeric ref", () => {
    const out = renderMarkdown("- [Bar Hevr] שיתף קובץ [12]");
    expect(out).toContain('<bdi class="chat-tag">Bar Hevr</bdi>');
    expect(out).not.toContain("[12]");
    expect(out).not.toContain('chat-tag">12');
  });
});

describe("renderInline", () => {
  it("renders **bold** without block wrapping", () => {
    const out = renderInline("**זמינות לעזרה:** אייל עדכן");
    expect(out).toContain("<strong>זמינות לעזרה:</strong>");
    expect(out).not.toContain("<p>");
    expect(out).not.toContain("<ul>");
  });

  it("strips inline citation markers", () => {
    const out = renderInline("אין עליו מפתח ^[#1], [#2].");
    expect(out).not.toContain("[#");
    expect(out).not.toContain("**");
    expect(out).toContain("אין עליו מפתח");
  });

  it("escapes HTML before transforming", () => {
    const out = renderInline("<b>x</b> **y**");
    expect(out).not.toContain("<b>x</b>");
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("<strong>y</strong>");
  });

  it("empty / null → empty string", () => {
    expect(renderInline("")).toBe("");
    expect(renderInline(null)).toBe("");
    expect(renderInline("   ")).toBe("");
  });
});

describe("renderMarkdown — realistic mixed sample", () => {
  it("heading + bullets + paragraph all render correctly", () => {
    const md = [
      "## תקציר",
      "סיכום קצר של השיחה.",
      "",
      "## נושאים עיקריים",
      "- נושא ראשון",
      "- נושא שני",
      "",
      "הערות נוספות בפסקה.",
    ].join("\n");

    const out = renderMarkdown(md);

    expect(out).toContain("<h3>תקציר</h3>");
    expect(out).toContain("<h3>נושאים עיקריים</h3>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>נושא ראשון</li>");
    expect(out).toContain("<li>נושא שני</li>");
    expect(out).toContain("<p>");
  });
});

describe("toWhatsAppText", () => {
  it("known Hebrew headings get their mapped emoji + single-asterisk bold", () => {
    expect(toWhatsAppText("## תקציר")).toBe("📝 *תקציר*");
    expect(toWhatsAppText("## נושאים עיקריים")).toBe("📌 *נושאים עיקריים*");
    expect(toWhatsAppText("## החלטות ומשימות")).toBe("✅ *החלטות ומשימות*");
    expect(toWhatsAppText("## שאלות פתוחות")).toBe("❓ *שאלות פתוחות*");
    expect(toWhatsAppText("## לפי משתתף")).toBe("👤 *לפי משתתף*");
  });

  it("unknown heading gets bold only, no emoji", () => {
    expect(toWhatsAppText("## כותרת מוזרה")).toBe("*כותרת מוזרה*");
  });

  it("### sub-headings are also converted", () => {
    expect(toWhatsAppText("### תת כותרת")).toBe("*תת כותרת*");
  });

  it("**bold** becomes *bold*", () => {
    expect(toWhatsAppText("זה **מודגש** בטקסט")).toBe("זה *מודגש* בטקסט");
  });

  it("- and * bullets become •", () => {
    const out = toWhatsAppText("- פריט ראשון\n* פריט שני");
    expect(out).toBe("• פריט ראשון\n• פריט שני");
  });

  it("strips citation markers", () => {
    expect(toWhatsAppText("החלטה חשובה ^[#303]")).toBe("החלטה חשובה");
    expect(toWhatsAppText("עוד החלטה [#197, #356]")).toBe("עוד החלטה");
  });

  it("collapses 3+ blank lines to 1", () => {
    const out = toWhatsAppText("שורה א\n\n\n\nשורה ב");
    expect(out).toBe("שורה א\n\nשורה ב");
  });

  it("full realistic sample renders clean WhatsApp text", () => {
    const md = [
      "## תקציר",
      "**החלטה:** לדחות את הפגישה ^[#12]",
      "",
      "## נושאים עיקריים",
      "- נושא ראשון [#5]",
      "- נושא שני",
    ].join("\n");

    const out = toWhatsAppText(md);

    expect(out).not.toContain("##");
    expect(out).not.toContain("**");
    expect(out).not.toContain("[#");
    expect(out).toContain("📝 *תקציר*");
    expect(out).toContain("*החלטה:* לדחות את הפגישה");
    expect(out).toContain("📌 *נושאים עיקריים*");
    expect(out).toContain("• נושא ראשון");
    expect(out).toContain("• נושא שני");
  });

  it("empty / null → empty string", () => {
    expect(toWhatsAppText("")).toBe("");
    expect(toWhatsAppText(null)).toBe("");
    expect(toWhatsAppText("   ")).toBe("");
  });
});
