// Must be called before all other module imports so OTel auto-instrumentation patches load first.
// Uses require() so a missing OTel package degrades gracefully instead of crashing the service.

let sdkInstance: { shutdown(): Promise<void> } | null = null;
let shutdownPromise: Promise<void> | null = null;

/**
 * Flushes buffered spans and shuts down the OTel SDK, if `initTracing()` actually
 * started one (a no-op otherwise — e.g. `OTEL_SDK_DISABLED=true` or the OTel
 * packages aren't installed). Safe to call more than once — e.g. once from this
 * module's own process signal handlers and once from a service's own graceful
 * shutdown sequence — the underlying `sdk.shutdown()` only ever runs once.
 *
 * Each service should `await` this before `process.exit()` in its own shutdown
 * handler; otherwise `process.exit()` can win the race against the async flush
 * and the most recent spans (including any Langfuse LLM-call traces) are lost.
 */
export function shutdownTracing(): Promise<void> {
  if (!sdkInstance) return Promise.resolve();
  if (!shutdownPromise) {
    shutdownPromise = sdkInstance.shutdown().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[tracing] shutdown failed:', err);
    });
  }
  return shutdownPromise;
}

/**
 * Initialise OpenTelemetry tracing.
 *
 * @param withLangfuse - When true, conditionally adds LangfuseSpanProcessor when
 *   LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY are set. Required for services that call
 *   generateAIText() (ai-service, results-service, analyser-service, recorder-service).
 *   The other 3 services (api-service, worker-backend, worker-client) pass false / omit it.
 */
export function initTracing(withLangfuse = false): void {
  if (process.env.OTEL_SDK_DISABLED === 'true') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
    const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });

    let sdk: { start(): void; shutdown(): Promise<void> };

    if (withLangfuse) {
      // IMPORTANT: NodeSDK only auto-wraps `traceExporter` in its own default processor when
      // `spanProcessors` is omitted entirely — passing `spanProcessors: []` alongside `traceExporter`
      // silently drops Tempo export (verified empirically). So Tempo's exporter is wrapped in its
      // own explicit BatchSpanProcessor here instead of using the `traceExporter` key at all.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
      const spanProcessors: unknown[] = [new BatchSpanProcessor(exporter)];

      // Langfuse — LLM-call tracing for generateAIText() (@alt/shared). Additive: only registered
      // when both keys are set; Tempo export above is unaffected either way.
      if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { LangfuseSpanProcessor } = require('@langfuse/otel');
          spanProcessors.push(new LangfuseSpanProcessor());
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw err;
        }
      }

      sdk = new NodeSDK({
        spanProcessors,
        instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
      });
    } else {
      sdk = new NodeSDK({
        traceExporter: exporter,
        instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
      });
    }

    sdk.start();
    sdkInstance = sdk;
    // Safety net for services that don't (yet) explicitly await shutdownTracing()
    // in their own shutdown sequence — shutdownTracing() is idempotent, so a
    // service that also calls it explicitly won't double-shutdown.
    process.on('SIGTERM', () => { void shutdownTracing(); });
    process.on('SIGINT', () => { void shutdownTracing(); });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw err;
    // OTel packages not available — tracing disabled, service starts normally
  }
}
