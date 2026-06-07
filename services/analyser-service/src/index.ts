import './tracing';
import Fastify from 'fastify';
import { BackendMetrics, ClientMetrics, SLOThresholds, AnalysisResult } from '@alt/shared';
import { analyzeResult } from './analyzer';
import { generateAiInsights } from './aiInsights';
import { log } from './logger';

const PORT = parseInt(process.env.PORT ?? '3008');

const app = Fastify({ logger: false });

app.get('/health', async (_request, reply) => {
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  return reply.code(200).send({
    status: 'ok',
    service: 'analyser-service',
    checks: {
      gemini: hasGemini ? 'configured' : 'missing_key',
    },
    timestamp: new Date().toISOString(),
  });
});

interface ExternalMetricSource {
  sourceName: string;
  platform: string | null;
  data: string;
}

interface AnalyseBody {
  testId: string;
  targetUrl: string;
  type: string;
  metrics: BackendMetrics | ClientMetrics;
  previousMetrics: BackendMetrics | ClientMetrics | null;
  thresholds?: SLOThresholds | null;
  externalMetrics?: ExternalMetricSource[];
}

app.post<{ Body: AnalyseBody }>('/analyse', async (request, reply) => {
  const { testId, targetUrl, type, metrics, previousMetrics, thresholds, externalMetrics } = request.body;
  const testLog = log.child({ testId });

  testLog.info({ targetUrl, type }, 'Running analysis');

  // 1. Deterministic threshold + regression analysis (always runs)
  const base = analyzeResult(metrics, previousMetrics ?? null, thresholds ?? undefined);

  // 2. AI insights (best-effort; null on failure or missing key)
  const { insights: aiInsights, rateLimited: geminiRateLimited } = await generateAiInsights({
    targetUrl,
    type,
    metrics,
    previousMetrics: previousMetrics ?? null,
    perfStatus: base.perfStatus,
    summary: base.summary,
    thresholdViolations: base.thresholdViolations,
    diffs: base.diffs,
    externalMetrics: externalMetrics ?? [],
  });

  const result: AnalysisResult = {
    ...base,
    ...(aiInsights ? { aiInsights } : {}),
  };

  testLog.info({ perfStatus: result.perfStatus, hasAiInsights: Boolean(aiInsights), geminiRateLimited }, 'Analysis complete');

  return reply.send({ ...result, geminiRateLimited });
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    log.error(err, 'Failed to start analyser-service');
    process.exit(1);
  }
  log.info({ port: PORT }, 'analyser-service listening');
});
