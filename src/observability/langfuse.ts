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

/** Local Langfuse endpoints. Anything else is refused — the SDK's own default
 *  is the PUBLIC cloud, and spans carry chat content, so a non-local baseUrl
 *  would leak message content off-device (the project's one absolute rule). */
export function isLocalLangfuseUrl(url: string): boolean {
  let host: string;
  try {
    // URL keeps IPv6 literals bracketed ("[::1]") — strip them to compare.
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

export type LangfuseEndpoint = { baseUrl: string; publicKey: string; secretKey: string };

// registerTelemetry() appends to a global list with no removal API; guard so a
// restart within one process can't register a second integration (double spans).
let integrationRegistered = false;

/** Real wiring: OTel NodeSDK + Langfuse span processor + AI SDK integration.
 *  Throws if `baseUrl` is not local — never fall back to the SDK's cloud URL. */
export function defaultLangfuseDeps(endpoint: LangfuseEndpoint): LangfuseTelemetryDeps {
  if (!isLocalLangfuseUrl(endpoint.baseUrl)) {
    throw new Error(
      `Langfuse baseUrl must be local (got ${endpoint.baseUrl}); refusing to start so chat content stays on-device.`,
    );
  }
  return {
    // baseUrl/keys are pinned explicitly — with no params the exporter would
    // resolve to https://cloud.langfuse.com.
    makeSdk: () =>
      new NodeSDK({
        spanProcessors: [
          new LangfuseSpanProcessor({
            baseUrl: endpoint.baseUrl,
            publicKey: endpoint.publicKey,
            secretKey: endpoint.secretKey,
          }),
        ],
      }),
    register: () => {
      if (integrationRegistered) return;
      registerTelemetry(new LangfuseVercelAiSdkIntegration());
      integrationRegistered = true;
    },
  };
}

/**
 * Wrap the OTel SDK + Langfuse integration behind start()/shutdown().
 *
 * - `start()` is idempotent: a second call is a no-op, so wiring it into more
 *   than one entrypoint can't double-register the integration.
 * - `shutdown()` flushes the pending span batch and should be awaited on
 *   process exit to give the last trace(s) their best chance to reach Langfuse
 *   (the collector's stop() is best-effort per this codebase's teardown style).
 *   Safe before start and safe to call twice.
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
