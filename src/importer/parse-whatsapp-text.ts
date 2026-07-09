import type { ImportedMessage, ImportedMessageType } from "./types.js";

type ParsedLineStart = {
  sentAt: Date;
  body: string;
};

const ANDROID_LINE =
  /^(\d{1,2}[/.:-]\d{1,2}[/.:-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\s+-\s+(.+)$/i;

const IOS_LINE =
  /^\[(\d{1,2}[/.:-]\d{1,2}[/.:-]\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\]\s+(.+)$/i;

const ATTACHED_MEDIA = /<attached:\s*([^>]+)>/i;
const FILE_ATTACHED =
  /(?:^|\s)([^\n<>:"/\\|?*]+\.(?:opus|ogg|m4a|mp3|wav|jpg|jpeg|png|gif|webp|mp4|mov|pdf|docx?|xlsx?|pptx?))(?:\s+\(file attached\)|$)/i;

export function parseWhatsAppTextExport(text: string): ImportedMessage[] {
  const messages: ImportedMessage[] = [];
  let current: ImportedMessage | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = cleanExportLine(rawLine);

    if (line.trim() === "") {
      continue;
    }

    const lineStart = parseLineStart(line);

    if (lineStart) {
      if (current) {
        messages.push(current);
      }

      current = parseMessageBody(lineStart.sentAt, lineStart.body);
      continue;
    }

    if (current) {
      current.textContent = `${current.textContent}\n${line}`;
      current.messageType = inferMessageType(current.textContent);
      current.mediaFilename = inferMediaFilename(current.textContent);
    }
  }

  if (current) {
    messages.push(current);
  }

  return messages;
}

function parseLineStart(line: string): ParsedLineStart | null {
  const androidMatch = ANDROID_LINE.exec(line);

  if (androidMatch) {
    return {
      sentAt: parseDayFirstDate(androidMatch[1] ?? "", androidMatch[2] ?? ""),
      body: androidMatch[3] ?? "",
    };
  }

  const iosMatch = IOS_LINE.exec(line);

  if (iosMatch) {
    return {
      sentAt: parseDayFirstDate(iosMatch[1] ?? "", iosMatch[2] ?? ""),
      body: iosMatch[3] ?? "",
    };
  }

  return null;
}

function parseMessageBody(sentAt: Date, body: string): ImportedMessage {
  const senderSplit = splitSender(body);
  const textContent = senderSplit.textContent;
  const mediaFilename = inferMediaFilename(textContent);
  const messageType: ImportedMessageType = senderSplit.senderName
    ? inferMessageType(textContent)
    : "system";

  return {
    senderName: senderSplit.senderName,
    sentAt,
    messageType,
    textContent,
    mediaFilename,
  };
}

function splitSender(body: string): { senderName: string | null; textContent: string } {
  const separatorIndex = body.indexOf(": ");

  if (separatorIndex === -1) {
    return {
      senderName: null,
      textContent: body.trim(),
    };
  }

  return {
    senderName: body.slice(0, separatorIndex).trim(),
    textContent: body.slice(separatorIndex + 2).trim(),
  };
}

function inferMessageType(textContent: string): ImportedMessageType {
  return inferMediaFilename(textContent) ? "media" : "text";
}

function inferMediaFilename(textContent: string): string | null {
  const attachedMatch = ATTACHED_MEDIA.exec(textContent);

  if (attachedMatch?.[1]) {
    return attachedMatch[1].trim();
  }

  const fileMatch = FILE_ATTACHED.exec(textContent);

  if (fileMatch?.[1]) {
    return fileMatch[1].trim();
  }

  return null;
}

function parseDayFirstDate(datePart: string, timePart: string): Date {
  const dateMatch = /^(\d{1,2})[/.:-](\d{1,2})[/.:-](\d{2,4})$/.exec(datePart);

  if (!dateMatch) {
    throw new Error(`Unsupported WhatsApp export date: ${datePart}`);
  }

  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const year = normalizeYear(Number(dateMatch[3]));
  const { hour, minute, second } = parseTime(timePart);

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function normalizeYear(year: number): number {
  if (year < 100) {
    return year >= 70 ? 1900 + year : 2000 + year;
  }

  return year;
}

function parseTime(timePart: string): { hour: number; minute: number; second: number } {
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AP]M))?$/i.exec(timePart.trim());

  if (!timeMatch) {
    throw new Error(`Unsupported WhatsApp export time: ${timePart}`);
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? 0);
  const meridiem = timeMatch[4]?.toUpperCase();

  if (meridiem === "PM" && hour < 12) {
    hour += 12;
  }

  if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }

  return { hour, minute, second };
}

function cleanExportLine(line: string): string {
  return line.replace(/[\u200e\u200f\u202a-\u202e]/g, "");
}
