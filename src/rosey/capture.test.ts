import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { type CaptureDeps, captureMessage, LIVENESS_WINDOW_MS } from "./capture.js";
import type { RoseyCommand } from "./tags.js";
import { makeTagMatcher } from "./tags.js";

const GROUP_JID = "120363000000000001@g.us";
const NOW = 1_795_000_000_000;

function wa(
  text: string,
  over: { jid?: string; id?: string; ageMs?: number; quotedId?: string } = {},
): WAMessage {
  return {
    key: {
      id: over.id ?? "WA-1",
      remoteJid: over.jid ?? GROUP_JID,
      participant: "972500000001@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: Math.floor((NOW - (over.ageMs ?? 1000)) / 1000),
    message: over.quotedId
      ? { extendedTextMessage: { text, contextInfo: { stanzaId: over.quotedId } } }
      : { conversation: text },
  } as WAMessage;
}

function deps(over: Partial<CaptureDeps> = {}) {
  const calls = {
    applied: [] as Array<{ cmd: RoseyCommand; ctx: unknown }>,
    scheduled: [] as number[],
  };
  const d: CaptureDeps = {
    matcher: makeTagMatcher(["@Rosey", "@רוזי"]),
    resolveEnabledJids: async () => new Set([GROUP_JID]),
    groupIdForJid: async () => 9,
    messageIdFor: async (_g, externalId) =>
      externalId === "WA-1" ? 501 : externalId === "WA-Q" ? 400 : null,
    isOwnPost: async () => false,
    applyCommand: async (cmd, ctx) => {
      calls.applied.push({ cmd, ctx });
      return { kind: "added", created: 1, confirmed: 0, alreadyOpen: 0 };
    },
    scheduleSuggestions: (g) => calls.scheduled.push(g),
    now: () => NOW,
    ...over,
  };
  return { d, calls };
}

describe("captureMessage — gates (each fails closed)", () => {
  it("ignores a 1:1 chat", async () => {
    const { d, calls } = deps();
    const r = await captureMessage(wa("@Rosey milk", { jid: "972500000001@s.whatsapp.net" }), d);
    expect(r).toEqual({ kind: "ignored", reason: "not_a_group" });
    expect(calls.applied).toEqual([]);
  });

  it("ignores a group that is not on Rosey's own allowlist", async () => {
    const { d, calls } = deps({ resolveEnabledJids: async () => new Set(["other@g.us"]) });
    expect(await captureMessage(wa("@Rosey milk"), d)).toEqual({
      kind: "ignored",
      reason: "not_enabled",
    });
    expect(calls.scheduled).toEqual([]);
  });

  it("fails closed when the allowlist lookup throws", async () => {
    const { d, calls } = deps({
      resolveEnabledJids: async () => {
        throw new Error("db down");
      },
    });
    expect(await captureMessage(wa("@Rosey milk"), d)).toEqual({
      kind: "ignored",
      reason: "allowlist_error",
    });
    expect(calls.applied).toEqual([]);
  });

  it("ignores a replay older than the liveness window", async () => {
    const { d, calls } = deps();
    const r = await captureMessage(wa("@Rosey milk", { ageMs: LIVENESS_WINDOW_MS + 1000 }), d);
    expect(r).toEqual({ kind: "ignored", reason: "stale" });
    expect(calls.applied).toEqual([]);
    // ...but it schedules the pass whose catch-up applies late commands.
    expect(calls.scheduled).toEqual([9]);
  });

  it("never acts on one of her own posts", async () => {
    const { d, calls } = deps({ isOwnPost: async () => true });
    expect(await captureMessage(wa("@Rosey milk"), d)).toEqual({
      kind: "ignored",
      reason: "own_post",
    });
    expect(calls.applied).toEqual([]);
    expect(calls.scheduled).toEqual([]);
  });
});

describe("captureMessage — routing", () => {
  it("applies a tagged message as a command, citing the stored message row", async () => {
    const { d, calls } = deps();
    const r = await captureMessage(wa("@Rosey לקנות חלב\nלתקן ברז"), d);
    expect(r).toMatchObject({ kind: "command", groupId: 9 });
    expect(calls.applied).toEqual([
      {
        cmd: { kind: "add", items: ["לקנות חלב", "לתקן ברז"] },
        ctx: {
          groupId: 9,
          messageId: 501,
          sentAt: new Date(Math.floor((NOW - 1000) / 1000) * 1000),
          quotedMessageId: null,
        },
      },
    ]);
    expect(calls.scheduled).toEqual([]);
  });

  it("resolves a quoted message to its row for a quote-reply done", async () => {
    const { d, calls } = deps();
    await captureMessage(wa("@רוזי בוצע", { quotedId: "WA-Q" }), d);
    expect(calls.applied[0]).toMatchObject({
      cmd: { kind: "done", query: "" },
      ctx: { quotedMessageId: 400 },
    });
  });

  it("applies nothing when the quoted message cannot be resolved (no unscoped guess)", async () => {
    const { d, calls } = deps();
    expect(await captureMessage(wa("@רוזי בוצע חלב", { quotedId: "WA-MISSING" }), d)).toEqual({
      kind: "ignored",
      reason: "quote_not_ingested",
    });
    expect(calls.applied).toEqual([]);
  });

  it("does nothing for a tagged message that was never ingested", async () => {
    const { d, calls } = deps({ messageIdFor: async () => null });
    expect(await captureMessage(wa("@Rosey milk"), d)).toEqual({
      kind: "ignored",
      reason: "not_ingested",
    });
    expect(calls.applied).toEqual([]);
  });

  it("an untagged message only schedules the group's suggestion pass", async () => {
    const { d, calls } = deps();
    expect(await captureMessage(wa("צריך לקנות חלב"), d)).toEqual({
      kind: "scheduled",
      groupId: 9,
    });
    expect(calls.scheduled).toEqual([9]);
    expect(calls.applied).toEqual([]);
  });

  it("a bare tag is neither a command nor chatter for the model", async () => {
    const { d, calls } = deps();
    expect(await captureMessage(wa("@Rosey"), d)).toEqual({ kind: "ignored", reason: "empty_tag" });
    expect(calls.scheduled).toEqual([]);
  });
});
