import { describe, expect, it } from "vitest";
import {
  humanizeSender,
  parseNameAliases,
  resolveSenderName,
  UNKNOWN_SENDER,
} from "./sender-name.js";

describe("humanizeSender", () => {
  it("keeps a real human name unchanged", () => {
    expect(humanizeSender("Dana Cohen")).toBe("Dana Cohen");
    expect(humanizeSender("נועה לוי")).toBe("נועה לוי");
  });

  it("never surfaces a GROUP jid as a person (the reported bug)", () => {
    // Both the new (120…) and legacy (phone-ts) group-jid formats — a group is
    // never a message's human sender, so it must not show as one.
    expect(humanizeSender("120363403384885252@g.us")).toBe(UNKNOWN_SENDER);
    expect(humanizeSender("972523893791-1512111801@g.us")).toBe(UNKNOWN_SENDER);
  });

  it("shows a real phone for a phone JID (the only identifying info we have)", () => {
    expect(humanizeSender("972523893791@s.whatsapp.net")).toBe("+972523893791");
  });

  it("falls back to unknown for an @lid identity (no phone available)", () => {
    expect(humanizeSender("84773022113938@lid")).toBe(UNKNOWN_SENDER);
  });

  it("treats empty / null / whitespace as unknown", () => {
    expect(humanizeSender("")).toBe(UNKNOWN_SENDER);
    expect(humanizeSender(null)).toBe(UNKNOWN_SENDER);
    expect(humanizeSender("   ")).toBe(UNKNOWN_SENDER);
  });

  it("does NOT extract a phone from a legacy group jid's leading digits", () => {
    // 972523893791 here is the group CREATOR, not the sender — must stay unknown,
    // not become "+972523893791".
    expect(humanizeSender("972523893791-1512111801@g.us")).not.toMatch(/^\+/);
  });
});

describe("parseNameAliases", () => {
  it("parses comma-separated Name=Alias pairs, trimming whitespace", () => {
    const m = parseNameAliases(" Dana Cohen = דנה , Noa=נועה ");
    expect(m.get("Dana Cohen")).toBe("דנה");
    expect(m.get("Noa")).toBe("נועה");
  });

  it("ignores blanks and malformed entries", () => {
    const m = parseNameAliases("=nope,,justkey,Ok=Val");
    expect(m.size).toBe(1);
    expect(m.get("Ok")).toBe("Val");
  });

  it("returns an empty map for null/undefined/empty", () => {
    expect(parseNameAliases(undefined).size).toBe(0);
    expect(parseNameAliases("").size).toBe(0);
  });
});

describe("resolveSenderName", () => {
  const aliases = parseNameAliases("Dana Cohen=דנה,120363403384885252@g.us=אלכס");

  it("applies an operator alias to the raw stored name", () => {
    expect(resolveSenderName("Dana Cohen", aliases)).toBe("דנה");
  });

  it("can remap even a leaked JID to a real person", () => {
    expect(resolveSenderName("120363403384885252@g.us", aliases)).toBe("אלכס");
  });

  it("falls back to humanizeSender when no alias matches", () => {
    expect(resolveSenderName("Noa", aliases)).toBe("Noa");
    expect(resolveSenderName("972523893791-1512111801@g.us", aliases)).toBe(UNKNOWN_SENDER);
  });
});
