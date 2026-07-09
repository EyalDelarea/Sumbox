import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { IvritWhisperTranscriber } from "./ivrit-whisper.js";

// A minimal stand-in for a Node ChildProcess sufficient for open()/close().
function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: string | null;
  };
  proc.stdout = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = vi.fn();
  proc.exitCode = null;
  proc.signalCode = null;
  return proc;
}

async function openWith(proc: ReturnType<typeof fakeProc>, killTimeoutMs: number) {
  const t = new IvritWhisperTranscriber({
    pythonPath: "python3",
    model: "m",
    ffmpegPath: "ffmpeg",
    spawn: (() => proc) as never,
    killTimeoutMs,
  });
  const opening = t.open();
  // Emit the readiness line the worker prints on startup.
  proc.stdout.write(`${JSON.stringify({ ready: true })}\n`);
  await opening;
  return t;
}

describe("IvritWhisperTranscriber.close", () => {
  it("ends stdin and awaits a clean exit without SIGKILL", async () => {
    const proc = fakeProc();
    const t = await openWith(proc, 1000);
    const stdinEnd = vi.spyOn(proc.stdin, "end");

    const closing = t.close();
    // Simulate the Python worker exiting cleanly after stdin EOF.
    proc.exitCode = 0;
    proc.emit("exit", 0);
    await closing;

    expect(stdinEnd).toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("SIGKILLs as a fallback if the worker does not exit within the grace period", async () => {
    const proc = fakeProc();
    const t = await openWith(proc, 20);

    // Never emit "exit" → exitCode stays null → fallback kill must fire.
    await t.close();

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
