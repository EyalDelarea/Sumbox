/**
 * langfuse.ts — opt-in OpenTelemetry exporter that streams the agentic @Aida
 * loop to a LOCAL, self-hosted Langfuse (docker-compose.langfuse.yml).
 *
 * AI SDK v7 telemetry is a global registry: once `registerTelemetry(new
 * LangfuseVercelAiSdkIntegration())` runs and an OTel `NodeSDK` with a
 * `LangfuseSpanProcessor` is started, every `generateText` call that opts in
 * (see agentic-answer.ts) emits step/tool/token/latency spans to Langfuse — no
 * per-call tracer plumbing needed.
 *
 * Credentials + endpoint come from the environment the Langfuse SDK already
 * reads: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASEURL (all local;
 * see .env.example). This module is loaded ONLY when LANGFUSE_ENABLED=true (the
 * collector dynamic-imports it), so the OTel dependency tree never loads on the
 * default path.
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { registerTelemetry } from "ai";

/** The slice of the OTel NodeSDK we use — narrowed so tests can inject a fake. */
export type OtelSdk = { start: () => void; shutdown: () => Promise<void> };

export type LangfuseTelemetryDeps = {
  /** Build (but don't start) the OTel SDK wired to the Langfuse span processor. */
  makeSdk: () => OtelSdk;
  /** Register the Langfuse integration with the AI SDK telemetry registry. */
  register: () => void;
  log?: (msg: string) => void;
};

export type LangfuseTelemetry = {
  start: () => void;
  shutdown: () => Promise<void>;
};

/** Real wiring: OTel NodeSDK + Langfuse span processor + AI SDK integration. */
export function defaultLangfuseDeps(): LangfuseTelemetryDeps {
  return {
    makeSdk: () => new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] }),
    register: () => registerTelemetry(new LangfuseVercelAiSdkIntegration()),
  };
}

/**
 * Wrap the OTel SDK + Langfuse integration behind start()/shutdown().
 *
 * - `start()` is idempotent: a second call is a no-op, so wiring it into more
 *   than one entrypoint can't double-register the integration.
 * - `shutdown()` flushes the pending span batch. Call it on process exit —
 *   otherwise the last trace(s) never reach Langfuse. Safe before start and
 *   safe to call twice.
 */
export function createLangfuseTelemetry(deps: LangfuseTelemetryDeps): LangfuseTelemetry {
  let sdk: OtelSdk | null = null;
  return {
    start() {
      if (sdk) return;
      sdk = deps.makeSdk();
      sdk.start();
      deps.register();
      deps.log?.("langfuse telemetry started");
    },
    async shutdown() {
      if (!sdk) return;
      const running = sdk;
      sdk = null;
      await running.shutdown();
    },
  };
}
