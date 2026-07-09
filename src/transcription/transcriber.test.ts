import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IvritWhisperTranscriber } from "./ivrit-whisper.js";
import { buildFfmpegArgs } from "./transcriber.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WORKER = path.resolve(__dirname, "__fixtures__/fake-worker.mjs");

describe("buildFfmpegArgs", () => {
  it("builds 16kHz mono WAV conversion args", () => {
    const args = buildFfmpegArgs("/in/voice.opus", "/tmp/out.wav");
    expect(args).toEqual([
      "-i",
      "/in/voice.opus",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
      "-y",
      "/tmp/out.wav",
    ]);
  });
});

describe("IvritWhisperTranscriber (fake worker)", () => {
  it("opens, returns text for a good file, and closes", async () => {
    const t = new IvritWhisperTranscriber({
      pythonPath: "node",
      workerScript: FAKE_WORKER,
      model: "unused",
      ffmpegPath: "ffmpeg",
    });
    await t.open();
    const result = await t.transcribe("/x/good.wav");
    expect(result.text).toBe("שלום עולם");
    await t.close();
  });

  it("rejects when the worker reports a per-file error", async () => {
    const t = new IvritWhisperTranscriber({
      pythonPath: "node",
      workerScript: FAKE_WORKER,
      model: "unused",
      ffmpegPath: "ffmpeg",
    });
    await t.open();
    await expect(t.transcribe("/x/bad.wav")).rejects.toThrow("boom");
    await t.close();
  });
});
