import type { WAMessage } from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { extractMediaDescriptor } from "./media-descriptor.js";

function imageMsg(): WAMessage {
  return {
    key: { remoteJid: "123@s.whatsapp.net", id: "ABC", fromMe: false },
    message: {
      imageMessage: {
        mediaKey: new Uint8Array([1, 2, 3]),
        directPath: "/v/t62.7118-24/path",
        url: "https://mmg.whatsapp.net/x",
        mimetype: "image/jpeg",
        fileEncSha256: new Uint8Array([9, 9]),
        fileSha256: new Uint8Array([8, 8]),
        mediaKeyTimestamp: 1700000000,
        fileLength: 4242,
      },
    },
  } as unknown as WAMessage;
}

describe("extractMediaDescriptor", () => {
  it("extracts image fields and a round-trippable proto blob", () => {
    const d = extractMediaDescriptor(imageMsg());
    expect(d).not.toBeNull();
    expect(d!.mediaKind).toBe("image");
    expect(d!.mimeType).toBe("image/jpeg");
    expect(d!.directPath).toBe("/v/t62.7118-24/path");
    expect(d!.url).toBe("https://mmg.whatsapp.net/x");
    expect(Buffer.from(d!.mediaKey!)).toEqual(Buffer.from([1, 2, 3]));
    expect(d!.fileLength).toBe(4242);
    const decoded = proto.WebMessageInfo.decode(d!.waMessage);
    expect(decoded.message?.imageMessage?.directPath).toBe("/v/t62.7118-24/path");
  });

  it("returns null for a text-only message", () => {
    const text = {
      key: { remoteJid: "1@s.whatsapp.net", id: "T", fromMe: false },
      message: { conversation: "hello" },
    } as unknown as WAMessage;
    expect(extractMediaDescriptor(text)).toBeNull();
  });

  it("parses the signed-URL expiry (oe, hex unix) into urlExpiresAt", () => {
    const msg = {
      key: { remoteJid: "1@s.whatsapp.net", id: "E", fromMe: false },
      message: {
        imageMessage: {
          mediaKey: new Uint8Array([1]),
          directPath: "/v/t62/x.enc?ccb=11-4&oh=01_abc&oe=696CBBBE&_nc_sid=5e03e0",
          url: "https://mmg.whatsapp.net/v/t62/x.enc?ccb=11-4&oh=01_abc&oe=696CBBBE&_nc_sid=5e03e0",
        },
      },
    } as unknown as WAMessage;
    // 0x696CBBBE = 1768733630 (2026-01-18T10:53:50Z)
    expect(extractMediaDescriptor(msg)!.urlExpiresAt).toBe(0x696cbbbe);
  });

  it("urlExpiresAt is null when no oe param is present", () => {
    expect(extractMediaDescriptor(imageMsg())!.urlExpiresAt).toBeNull();
  });

  it("classifies a voice note as audio", () => {
    const audio = {
      key: { remoteJid: "1@s.whatsapp.net", id: "V", fromMe: false },
      message: { audioMessage: { mediaKey: new Uint8Array([7]), directPath: "/a", ptt: true } },
    } as unknown as WAMessage;
    expect(extractMediaDescriptor(audio)!.mediaKind).toBe("audio");
  });
});
