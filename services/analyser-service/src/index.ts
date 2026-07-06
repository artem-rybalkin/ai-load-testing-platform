import './tracing';
import Fastify, { FastifyInstance } from 'fastify';
import { BackendMetrics, ClientMetrics, SLOThresholds, AnalysisResult } from '@alt/shared';
import { analyzeResult } from './analyzer';
import { generateAiInsights } from './aiInsights';
import { log } from './logger';

const PORT = parseInt(process.env.PORT ?? '3008');

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
  teamId?: string | null;
}

// ── App factory (exported for testing) ───────────────────────────────────────

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // This service is server-to-server only — results-service's consumer.ts is
  // the sole caller. Unlike the internal-callback convention elsewhere in this
  // codebase (401 on mismatch, no-op when INTERNAL_API_KEY is empty), auth here
  // is unconditional: an empty/unset INTERNAL_API_KEY blocks every request
  // rather than falling open, because a POST /analyse call directly triggers a
  // real (costed) Gemini/OpenAI/Anthropic call — there is no safe "auth
  // disabled" mode for an endpoint that spends money per request.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const internalApiKey = process.env.INTERNAL_API_KEY || '';
    const header = request.headers['x-internal-key'];
    if (!internalApiKey || header !== internalApiKey) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

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

  app.post<{ Body: AnalyseBody }>('/analyse', async (request, reply) => {
    const { testId, targetUrl, type, metrics, previousMetrics, thresholds, externalMetrics, teamId } = request.body;
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
      teamId: teamId ?? null,
    });

    const result: AnalysisResult = {
      ...base,
      ...(aiInsights ? { aiInsights } : {}),
    };

    testLog.info({ perfStatus: result.perfStatus, hasAiInsights: Boolean(aiInsights), geminiRateLimited }, 'Analysis complete');

    return reply.send({ ...result, geminiRateLimited });
  });

  return app;
}

if (process.env.VITEST !== 'true') {
  const app = buildApp();
  app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
      log.error(err, 'Failed to start analyser-service');
      process.exit(1);
    }
    log.info({ port: PORT }, 'analyser-service listening');
  });
}
