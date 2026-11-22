import { describe, expect, it } from "vitest";
import { renderLabelSheet } from "./label-sheet.js";

const at = new Date("2026-11-01T08:00:00Z");
const html = renderLabelSheet({
  groupId: 7,
  messages: [
    { messageId: 1, sentAt: at, sender: "Dana", content: "@Rosey fix the tap", isVoice: false },
    { messageId: 2, sentAt: at, sender: null, content: "<b>hi</b>", isVoice: false },
  ],
  tasks: [
    {
      id: 10,
      groupId: 7,
      title: "fix the tap",
      titleKey: "fix the tap",
      origin: "tag",
      kind: "task",
      status: "open",
      statusSource: "tag",
      raisedByParticipantId: null,
      sourceMessageId: 1,
      sourceItemIndex: 0,
      raisedAt: at,
      raisedBy: "Dana",
    },
  ],
});

describe("renderLabelSheet", () => {
  it("lets mixed-direction chat text pick its own direction inside the RTL page", () => {
    expect(html).toContain('<html lang="he" dir="rtl">');
    expect(html).toContain('<strong dir="auto">fix the tap</strong>');
    expect(html).toContain('<div class="src" dir="auto">@Rosey fix the tap</div>');
    expect(html).toContain('<div class="src msg" dir="auto">');
    // The JSON results box is code, so it reads left to right.
    expect(html).toContain('<textarea id="out" dir="ltr" readonly>');
  });

  it("escapes chat text", () => {
    expect(html).toContain("&#60;b&#62;hi&#60;/b&#62;");
    expect(html).not.toContain("<b>hi</b>");
  });

  it("stacks rows on a phone", () => {
    expect(html).toContain("@media (max-width:640px)");
  });
});
