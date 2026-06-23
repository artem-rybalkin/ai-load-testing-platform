// Must be imported before all other modules so auto-instrumentation patches load correctly.
// Uses require() so a missing OTel package degrades gracefully instead of crashing the service.
if (process.env.OTEL_SDK_DISABLED !== 'true') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

    // IMPORTANT: NodeSDK only auto-wraps `traceExporter` in its own default processor when
    // `spanProcessors` is omitted entirely — passing `spanProcessors: []` alongside `traceExporter`
    // silently drops Tempo export (verified empirically). So Tempo's exporter is wrapped in its
    // own explicit BatchSpanProcessor here instead of using the `traceExporter` key at all.
    const spanProcessors = [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))];

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

    const sdk = new NodeSDK({
      spanProcessors,
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });
    sdk.start();
    process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw err;
    // OTel packages not available — tracing disabled, service starts normally
  }
}
