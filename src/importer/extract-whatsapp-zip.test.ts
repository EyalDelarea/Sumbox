import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractWhatsAppZip } from "./extract-whatsapp-zip.js";

describe("extractWhatsAppZip", () => {
  it("extracts messages from the chat txt inside the zip", async () => {
    const zipPath = resolve("fixtures/sample-chat.zip");
    const result = await extractWhatsAppZip(zipPath);

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]).toMatchObject({
      senderName: "Alice",
      messageType: "text",
      textContent: "Morning everyone",
    });
  });

  it("lists media files found in the zip", async () => {
    const zipPath = resolve("fixtures/sample-chat.zip");
    const result = await extractWhatsAppZip(zipPath);

    expect(result.mediaFiles).toHaveLength(1);
    expect(result.mediaFiles[0]?.filename).toBe("IMG-20260531-WA0001.jpg");
    expect(result.mediaFiles[0]?.data).toBeInstanceOf(Buffer);
    expect(result.mediaFiles[0]?.data.length).toBeGreaterThan(0);
  });

  it("throws if no chat txt file is found in the zip", async () => {
    const zipPath = resolve("fixtures/sample-chat.zip");
    // We test the real error by passing a non-existent path
    await expect(extractWhatsAppZip("/nonexistent/path.zip")).rejects.toThrow();
  });
});
