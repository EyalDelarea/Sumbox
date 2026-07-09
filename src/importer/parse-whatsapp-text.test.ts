import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWhatsAppTextExport } from "./parse-whatsapp-text.js";

describe("parseWhatsAppTextExport", () => {
  it("parses Android-style exports", () => {
    const text = readFixture("android-chat.txt");
    const messages = parseWhatsAppTextExport(text);

    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatchObject({
      senderName: "Alice",
      messageType: "text",
      textContent: "Morning everyone",
      mediaFilename: null,
    });
    expect(messages[1]?.textContent).toBe(
      "This is a multiline message\nwith a second line\nand a third line",
    );
    expect(messages[2]).toMatchObject({
      senderName: "Alice",
      messageType: "media",
      mediaFilename: "IMG-20260531-WA0001.jpg",
    });
    expect(messages[3]).toMatchObject({
      senderName: null,
      messageType: "system",
    });
    expect(messages[4]).toMatchObject({
      senderName: "דנה",
      textContent: "בוקר טוב",
    });
  });

  it("parses iOS-style exports", () => {
    const text = readFixture("ios-chat.txt");
    const messages = parseWhatsAppTextExport(text);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      senderName: "Alice",
      messageType: "text",
      textContent: "Hello from iOS",
    });
    expect(messages[1]).toMatchObject({
      senderName: "Bob",
      messageType: "media",
      mediaFilename: "PTT-20260531-WA0002.opus",
    });
    expect(messages[2]).toMatchObject({
      senderName: null,
      messageType: "system",
      textContent: "Alice changed the group description",
    });
    expect(messages[3]?.textContent).toBe("הודעה\nעם המשך שורה");
  });

  it("ignores blank lines", () => {
    const messages = parseWhatsAppTextExport("\n31/05/2026, 09:12 - Alice: Hi\n\n");

    expect(messages).toHaveLength(1);
  });
});

function readFixture(name: string): string {
  return readFileSync(resolve("fixtures", name), "utf8");
}
