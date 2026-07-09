import path from "node:path";
import unzipper from "unzipper";
import { parseWhatsAppTextExport } from "./parse-whatsapp-text.js";
import type { ImportedMessage } from "./types.js";

const CHAT_TXT_PATTERN = /^_?chat\.txt$/i;
const MEDIA_EXTENSIONS =
  /\.(opus|ogg|m4a|mp3|wav|jpg|jpeg|png|gif|webp|mp4|mov|pdf|docx?|xlsx?|pptx?)$/i;

export type ZipMediaFile = {
  filename: string;
  data: Buffer;
};

export type ZipExtractResult = {
  messages: ImportedMessage[];
  mediaFiles: ZipMediaFile[];
};

export async function extractWhatsAppZip(zipPath: string): Promise<ZipExtractResult> {
  let chatText: string | null = null;
  const mediaFiles: ZipMediaFile[] = [];

  const directory = await unzipper.Open.file(zipPath);

  for (const entry of directory.files) {
    const filename = path.basename(entry.path);

    if (CHAT_TXT_PATTERN.test(filename)) {
      const buffer = await entry.buffer();
      chatText = buffer.toString("utf8");
    } else if (MEDIA_EXTENSIONS.test(filename)) {
      const data = await entry.buffer();
      mediaFiles.push({ filename, data });
    }
  }

  if (chatText === null) {
    throw new Error(`No chat .txt file found in zip: ${zipPath}`);
  }

  return {
    messages: parseWhatsAppTextExport(chatText),
    mediaFiles,
  };
}
