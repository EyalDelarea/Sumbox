import { describe, expect, it } from "vitest";
import { isSticker, kindFromFilename } from "./media-kind.js";

describe("kindFromFilename", () => {
  it("returns 'image' for .jpg", () => {
    expect(kindFromFilename("photo.jpg")).toBe("image");
  });

  it("returns 'image' for .jpeg", () => {
    expect(kindFromFilename("photo.jpeg")).toBe("image");
  });

  it("returns 'image' for .png", () => {
    expect(kindFromFilename("screenshot.png")).toBe("image");
  });

  it("returns 'image' for .gif", () => {
    expect(kindFromFilename("anim.gif")).toBe("image");
  });

  it("returns 'image' for .webp", () => {
    expect(kindFromFilename("sticker.webp")).toBe("image");
  });

  it("returns 'image' for uppercase extension", () => {
    expect(kindFromFilename("PHOTO.JPG")).toBe("image");
  });

  it("returns 'video' for .mp4", () => {
    expect(kindFromFilename("clip.mp4")).toBe("video");
  });

  it("returns 'video' for .mov", () => {
    expect(kindFromFilename("clip.mov")).toBe("video");
  });

  it("returns 'video' for uppercase extension", () => {
    expect(kindFromFilename("CLIP.MP4")).toBe("video");
  });

  it("returns null for audio file (.opus)", () => {
    expect(kindFromFilename("audio.opus")).toBeNull();
  });

  it("returns null for unknown extension", () => {
    expect(kindFromFilename("file.pdf")).toBeNull();
  });

  it("returns null for null filename", () => {
    expect(kindFromFilename(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(kindFromFilename("")).toBeNull();
  });

  it("handles filename with path separators", () => {
    expect(kindFromFilename("/data/media/IMG-001.jpg")).toBe("image");
  });
});

describe("isSticker", () => {
  it("returns true when isStickerFlag is true", () => {
    expect(isSticker(null, true)).toBe(true);
  });

  it("returns false when isStickerFlag is false and filename is not sticker", () => {
    expect(isSticker("photo.jpg", false)).toBe(false);
  });

  it("returns false when isStickerFlag is false and filename is null", () => {
    expect(isSticker(null, false)).toBe(false);
  });

  it("returns false when isStickerFlag is undefined and filename is not sticker", () => {
    expect(isSticker("photo.jpg")).toBe(false);
  });

  it("returns false when isStickerFlag is undefined and filename is null", () => {
    expect(isSticker(null)).toBe(false);
  });

  it("returns true when isStickerFlag is true regardless of filename", () => {
    expect(isSticker("photo.jpg", true)).toBe(true);
    expect(isSticker("clip.mp4", true)).toBe(true);
  });
});
