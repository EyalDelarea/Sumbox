import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig broker block", () => {
  it("provides sensible default broker url", () => {
    const cfg = loadConfig({});
    expect(cfg.broker.url).toBe("amqp://guest:guest@localhost:5672");
  });

  it("honors RABBITMQ_URL override", () => {
    const cfg = loadConfig({ RABBITMQ_URL: "amqp://user:pass@rabbitmq:5672" });
    expect(cfg.broker.url).toBe("amqp://user:pass@rabbitmq:5672");
  });
});

describe("loadConfig logging block", () => {
  it("provides sensible logging defaults", () => {
    const cfg = loadConfig({});
    expect(cfg.logging.level).toBe("info");
  });

  it("honors LOG_LEVEL override", () => {
    const cfg = loadConfig({ LOG_LEVEL: "debug" });
    expect(cfg.logging.level).toBe("debug");
  });
});

describe("loadConfig worker block", () => {
  it("provides sensible worker concurrency default", () => {
    const cfg = loadConfig({});
    expect(cfg.worker.concurrency).toBe(1);
  });

  it("honors WORKER_CONCURRENCY override", () => {
    const cfg = loadConfig({ WORKER_CONCURRENCY: "4" });
    expect(cfg.worker.concurrency).toBe(4);
  });
});

describe("loadConfig whatsapp block (safety guardrail)", () => {
  it("defaults allowSend to FALSE (passive read-only)", () => {
    expect(loadConfig({}).whatsapp.allowSend).toBe(false);
  });

  it("only enables sending when WHATSAPP_ALLOW_SEND is exactly 'true'", () => {
    expect(loadConfig({ WHATSAPP_ALLOW_SEND: "true" }).whatsapp.allowSend).toBe(true);
    expect(loadConfig({ WHATSAPP_ALLOW_SEND: "1" }).whatsapp.allowSend).toBe(false);
    expect(loadConfig({ WHATSAPP_ALLOW_SEND: "yes" }).whatsapp.allowSend).toBe(false);
    expect(loadConfig({ WHATSAPP_ALLOW_SEND: "TRUE" }).whatsapp.allowSend).toBe(false);
  });
});

describe("loadConfig langfuse block", () => {
  it("defaults enabled to FALSE (observability opt-in)", () => {
    expect(loadConfig({}).langfuse.enabled).toBe(false);
  });

  it("only enables when LANGFUSE_ENABLED is exactly 'true'", () => {
    expect(loadConfig({ LANGFUSE_ENABLED: "true" }).langfuse.enabled).toBe(true);
    expect(loadConfig({ LANGFUSE_ENABLED: "1" }).langfuse.enabled).toBe(false);
  });
});

describe("loadConfig opsSweep block", () => {
  it("provides sensible defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.opsSweep.enabled).toBe(true);
    expect(cfg.opsSweep.times).toBe("08:00,18:00");
    expect(cfg.opsSweep.redriveCap).toBe(2);
  });

  it("honors OPS_SWEEP_ENABLED=false override", () => {
    const cfg = loadConfig({ OPS_SWEEP_ENABLED: "false" });
    expect(cfg.opsSweep.enabled).toBe(false);
  });

  it("honors OPS_SWEEP_TIMES override", () => {
    const cfg = loadConfig({ OPS_SWEEP_TIMES: "06:00,20:00" });
    expect(cfg.opsSweep.times).toBe("06:00,20:00");
  });

  it("honors OPS_REDRIVE_CAP=5 override", () => {
    const cfg = loadConfig({ OPS_REDRIVE_CAP: "5" });
    expect(cfg.opsSweep.redriveCap).toBe(5);
  });
});

describe("loadConfig transcription block", () => {
  it("provides sensible defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.transcription.pythonPath).toBe("python3");
    expect(cfg.transcription.model).toBe("ivrit-ai/whisper-large-v3-turbo-ct2");
    expect(cfg.transcription.ffmpegPath).toBe("ffmpeg");
  });

  it("reads overrides from env", () => {
    const cfg = loadConfig({
      TRANSCRIPTION_PYTHON: "/venv/bin/python",
      TRANSCRIPTION_MODEL: "custom-model",
      FFMPEG_PATH: "/usr/local/bin/ffmpeg",
    });
    expect(cfg.transcription.pythonPath).toBe("/venv/bin/python");
    expect(cfg.transcription.model).toBe("custom-model");
    expect(cfg.transcription.ffmpegPath).toBe("/usr/local/bin/ffmpeg");
  });

  it("provides web defaults and honors WEB_PORT", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).web).toEqual({ port: 8787 });
    expect(loadConfig({ WEB_PORT: "9000" } as unknown as NodeJS.ProcessEnv).web).toEqual({
      port: 9000,
    });
  });

  it("provides summarization defaults and honors env overrides", () => {
    const def = loadConfig({} as NodeJS.ProcessEnv);
    expect(def.summarization).toEqual({
      ollamaHost: "http://localhost:11434",
      model: "gemma4:26b",
      numCtx: 32768,
      // Tighter than the old 24000 on purpose. That number was never reachable:
      // it was compared against a chars/4 estimate that under-counted Hebrew ~2x,
      // so a "14.8k" selection was really 32.2k tokens and filled num_ctx. Prompt
      // eval is ~89% of a slow run, so the budget is the latency dial.
      tokenBudget: 18000,
      temperature: 0.7,
      repeatPenalty: 1.1,
      numPredict: 4096,
    });

    const overridden = loadConfig({
      OLLAMA_HOST: "http://box:1234",
      SUMMARY_MODEL: "gemma4:8b",
      SUMMARY_NUM_CTX: "65536",
      SUMMARY_TOKEN_BUDGET: "50000",
      SUMMARY_TEMPERATURE: "0.9",
      SUMMARY_REPEAT_PENALTY: "1.05",
      SUMMARY_NUM_PREDICT: "2048",
    } as unknown as NodeJS.ProcessEnv);
    expect(overridden.summarization).toEqual({
      ollamaHost: "http://box:1234",
      model: "gemma4:8b",
      numCtx: 65536,
      // Under the ceiling for a 64k window ((65536-2048)/1.15 = 55206), so honoured.
      tokenBudget: 50000,
      temperature: 0.9,
      repeatPenalty: 1.05,
      numPredict: 2048,
    });
  });
});

describe("loadConfig summarization budget clamp", () => {
  it("clamps a configured token budget that would crowd the response out of num_ctx", () => {
    // num_ctx is SHARED between prompt and response. Asking for a 30k-token prompt
    // in a 32k window leaves the model nothing to write with — which is exactly how
    // summaries were being cut off mid-sentence (done_reason: 'length').
    const cfg = loadConfig({
      SUMMARY_NUM_CTX: "32768",
      SUMMARY_TOKEN_BUDGET: "30000",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.summarization.tokenBudget).toBeLessThan(30000);
    expect(cfg.summarization.tokenBudget).toBeLessThan(32768 - 2048);
  });
});

describe("loadConfig ask block", () => {
  it("defaults ask.agentic to false and honors ASK_AGENTIC=true", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).ask.agentic).toBe(false);
    expect(loadConfig({ ASK_AGENTIC: "true" } as unknown as NodeJS.ProcessEnv).ask.agentic).toBe(
      true,
    );
  });
});
