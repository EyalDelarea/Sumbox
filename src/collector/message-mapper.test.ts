/**
 * Unit tests for message-mapper.ts (no DB required).
 * Tests the mapping from Baileys WAMessage objects to our domain shape.
 */

import type { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { mapWaMessage } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Helpers to build minimal fake Baileys WAMessage objects
// ---------------------------------------------------------------------------

type FakeWAMessage = {
  key: {
    id: string;
    remoteJid: string;
    remoteJidAlt?: string;
    fromMe?: boolean;
    participant?: string;
  };
  messageTimestamp: number;
  pushName?: string;
  message?: proto.IMessage | null;
};

function makeTextMessage(overrides: Partial<FakeWAMessage> = {}): FakeWAMessage {
  return {
    key: {
      id: "ABCDEF123456",
      remoteJid: "1234567890-9876543210@g.us",
      fromMe: false,
    },
    messageTimestamp: 1700000000, // seconds
    pushName: "Alice",
    message: {
      conversation: "Hello group!",
    },
    ...overrides,
  };
}

function makeAudioMessage(overrides: Partial<FakeWAMessage> = {}): FakeWAMessage {
  return {
    key: {
      id: "VOICE789",
      remoteJid: "1234567890-9876543210@g.us",
      fromMe: false,
    },
    messageTimestamp: 1700000100,
    pushName: "Bob",
    message: {
      audioMessage: {
        seconds: 30,
        ptt: true,
      },
    },
    ...overrides,
  };
}

function makeStatusBroadcastMessage(): FakeWAMessage {
  return {
    key: {
      id: "STATUS001",
      remoteJid: "status@broadcast",
      fromMe: false,
    },
    messageTimestamp: 1700000200,
    pushName: "Carol",
    message: {
      conversation: "My status update",
    },
  };
}

function makeProtocolMessage(): FakeWAMessage {
  return {
    key: {
      id: "PROTO001",
      remoteJid: "1234567890-9876543210@g.us",
      fromMe: false,
    },
    messageTimestamp: 1700000300,
    pushName: "Dave",
    message: {
      protocolMessage: {
        type: 0, // REVOKE
      } as proto.Message.IProtocolMessage,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mapWaMessage()", () => {
  it("maps a text message: externalId, remoteJid, senderName, sentAt, messageType, textContent", () => {
    const wa = makeTextMessage();
    const result = mapWaMessage(wa as any);

    expect(result).not.toBeNull();
    expect(result!.externalId).toBe("ABCDEF123456");
    expect(result!.remoteJid).toBe("1234567890-9876543210@g.us");
    expect(result!.senderName).toBe("Alice");
    // sentAt should be a Date made from messageTimestamp (seconds → ms)
    expect(result!.sentAt).toBeInstanceOf(Date);
    expect(result!.sentAt.getTime()).toBe(1700000000 * 1000);
    expect(result!.messageType).toBe("text");
    expect(result!.textContent).toBe("Hello group!");
    expect(result!.mediaFilename).toBeNull();
  });

  it("extracts remoteJidAlt (the alternate LID/PN identity) from the key when present", () => {
    const wa = makeTextMessage({
      key: {
        id: "ALT001",
        remoteJid: "972542795343@s.whatsapp.net",
        remoteJidAlt: "4578552635558@lid",
        fromMe: false,
      },
    });
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    expect(result!.remoteJid).toBe("972542795343@s.whatsapp.net");
    expect(result!.remoteJidAlt).toBe("4578552635558@lid");
  });

  it("sets remoteJidAlt to null when the key has no alternate identity", () => {
    const wa = makeTextMessage();
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    expect(result!.remoteJidAlt).toBeNull();
  });

  it("maps extendedTextMessage to text", () => {
    const wa = makeTextMessage({
      message: {
        extendedTextMessage: {
          text: "Extended hello",
        },
      },
    });
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    expect(result!.messageType).toBe("text");
    expect(result!.textContent).toBe("Extended hello");
  });

  it("maps an audio/voice message to type 'media' with null textContent and isVoiceNote=true", () => {
    const wa = makeAudioMessage();
    const result = mapWaMessage(wa as any);

    expect(result).not.toBeNull();
    expect(result!.externalId).toBe("VOICE789");
    expect(result!.senderName).toBe("Bob");
    expect(result!.sentAt.getTime()).toBe(1700000100 * 1000);
    expect(result!.messageType).toBe("media");
    expect(result!.textContent).toBeNull();
    expect(result!.isVoiceNote).toBe(true);
  });

  it("maps a text message with isVoiceNote=false", () => {
    const wa = makeTextMessage();
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    expect(result!.isVoiceNote).toBe(false);
  });

  it("returns null for status@broadcast messages (ignore)", () => {
    const wa = makeStatusBroadcastMessage();
    const result = mapWaMessage(wa as any);
    expect(result).toBeNull();
  });

  it("returns null for protocol/system messages", () => {
    const wa = makeProtocolMessage();
    const result = mapWaMessage(wa as any);
    expect(result).toBeNull();
  });

  it("returns null when message has no key.id", () => {
    const wa = makeTextMessage();
    (wa.key as any).id = undefined;
    const result = mapWaMessage(wa as any);
    expect(result).toBeNull();
  });

  it("returns null when message.message is null/empty", () => {
    const wa = makeTextMessage({ message: null });
    const result = mapWaMessage(wa as any);
    expect(result).toBeNull();
  });

  it("uses key.participant as senderName fallback when pushName is missing in groups", () => {
    const wa = makeTextMessage({
      key: {
        id: "ID001",
        remoteJid: "1234567890-9876543210@g.us",
        fromMe: false,
        participant: "9999@s.whatsapp.net",
      },
      pushName: undefined,
      message: { conversation: "Hi" },
    });
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    // Falls back to key.participant when no pushName
    expect(result!.senderName).toBe("9999@s.whatsapp.net");
  });

  it("maps imageMessage to type 'media'", () => {
    const wa = makeTextMessage({
      message: {
        imageMessage: {
          caption: "Photo caption",
        },
      },
    });
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    expect(result!.messageType).toBe("media");
  });

  it("maps videoMessage to type 'media'", () => {
    const wa = makeTextMessage({
      message: {
        videoMessage: {
          caption: "Video caption",
        },
      },
    });
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    expect(result!.messageType).toBe("media");
  });

  it("maps documentMessage to type 'media' with filename", () => {
    const wa = makeTextMessage({
      message: {
        documentMessage: {
          fileName: "report.pdf",
          mimetype: "application/pdf",
        },
      },
    });
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    expect(result!.messageType).toBe("media");
    expect(result!.mediaFilename).toBe("report.pdf");
  });

  it("converts messageTimestamp from Long-like object correctly", () => {
    const wa = makeTextMessage({
      // Long objects have a toNumber() method
      messageTimestamp: { toNumber: () => 1700000999 } as any,
    });
    const result = mapWaMessage(wa as any);
    expect(result).not.toBeNull();
    expect(result!.sentAt.getTime()).toBe(1700000999 * 1000);
  });
});
