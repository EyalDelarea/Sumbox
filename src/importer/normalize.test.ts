import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";
import type { ImportedMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Build a minimal valid ImportedMessage. */
function makeMsg(overrides: Partial<ImportedMessage> = {}): ImportedMessage {
  return {
    senderName: "Alice",
    sentAt: new Date("2024-01-15T10:30:00.000Z"),
    messageType: "text",
    textContent: "Hello world",
    mediaFilename: null,
    ...overrides,
  };
}

const GROUP_ID = 42;
const CTX = { groupId: GROUP_ID, importId: 7, source: "import" as const };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("normalize()", () => {
  it("computes dedupe_key equal to sha256 of R1 input string for a known message", () => {
    const msg = makeMsg();
    const [row] = normalize([msg], CTX);

    // R1: sha256(group_id + ' ' + sent_at_iso + ' ' + sender_name + ' ' + normalized_text + ' ' + media_filename)
    const sentAtIso = msg.sentAt.toISOString();
    const senderName = msg.senderName ?? "";
    const normalizedText = (msg.textContent ?? "").trim().replace(/\s+/g, " ");
    const mediaFilename = msg.mediaFilename ?? "";

    const expected = sha256(
      `${GROUP_ID} ${sentAtIso} ${senderName} ${normalizedText} ${mediaFilename}`,
    );

    expect(row?.dedupeKey).toBe(expected);
  });

  it("two messages identical except for groupId have different dedupe keys", () => {
    const msg = makeMsg();
    const [rowA] = normalize([msg], { ...CTX, groupId: 1 });
    const [rowB] = normalize([msg], { ...CTX, groupId: 2 });

    expect(rowA?.dedupeKey).not.toBe(rowB?.dedupeKey);
  });

  it("system messages yield senderName null and a stable dedupe key", () => {
    const msg = makeMsg({
      senderName: null,
      messageType: "system",
      textContent: "You were added",
    });
    const [row] = normalize([msg], CTX);

    expect(row?.senderName).toBeNull();

    // Key must be deterministic — calling twice gives the same result
    const [row2] = normalize([msg], CTX);
    expect(row?.dedupeKey).toBe(row2?.dedupeKey);

    // The key is built with empty string for senderName (not the literal 'null')
    const sentAtIso = msg.sentAt.toISOString();
    const normalizedText = (msg.textContent ?? "").trim().replace(/\s+/g, " ");
    const expected = sha256(`${GROUP_ID} ${sentAtIso}  ${normalizedText} `);
    expect(row?.dedupeKey).toBe(expected);
  });

  it("collapses internal whitespace differences into the same normalized_text and thus the same key", () => {
    const base = makeMsg({ textContent: "Hello   world" });
    const collapsed = makeMsg({ textContent: "Hello world" });

    const [rowBase] = normalize([base], CTX);
    const [rowCollapsed] = normalize([collapsed], CTX);

    expect(rowBase?.dedupeKey).toBe(rowCollapsed?.dedupeKey);
    expect(rowBase?.textContent).toBe("Hello world");
    expect(rowCollapsed?.textContent).toBe("Hello world");
  });

  it("passes through groupId, importId, and source from context", () => {
    const [row] = normalize([makeMsg()], CTX);
    expect(row?.groupId).toBe(CTX.groupId);
    expect(row?.importId).toBe(CTX.importId);
    expect(row?.source).toBe("import");
  });

  it("sets textContent null for pure media rows with no body text", () => {
    const msg = makeMsg({
      messageType: "media",
      textContent: "",
      mediaFilename: "audio.opus",
    });
    const [row] = normalize([msg], CTX);
    expect(row?.textContent).toBeNull();
    expect(row?.mediaFilename).toBe("audio.opus");
  });

  it("preserves non-empty textContent for media messages that have a caption", () => {
    const msg = makeMsg({
      messageType: "media",
      textContent: "Check this out",
      mediaFilename: "photo.jpg",
    });
    const [row] = normalize([msg], CTX);
    expect(row?.textContent).toBe("Check this out");
  });

  it("trims leading/trailing whitespace from textContent", () => {
    const msg = makeMsg({ textContent: "  trimmed  " });
    const [row] = normalize([msg], CTX);
    expect(row?.textContent).toBe("trimmed");
  });

  it("accepts importId null (live messages context)", () => {
    const [row] = normalize([makeMsg()], { groupId: 1, importId: null, source: "import" });
    expect(row?.importId).toBeNull();
  });
});
