import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

import { TestRequest, TestType, EnrichedTestRequest, BackendTestOptions, SLOThresholds, FlowStep } from '@alt/shared';
import { connectQueue, publishTest, publishCancel, isQueueConnected } from './queue';
import { findExistingScript, checkDbHealth, stepsToKey, incrementUsedCount } from './scripts';

const parseDurationSeconds = (d: string): number => {
  const m = d.match(/^(\d+)(s|m|h)$/i);
  if (!m) return 0;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  return n; // seconds
};

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  await app.register(cors, {
    origin: allowedOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // API key authentication — exempt /health
  const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (apiKeys.length > 0) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/health') return;
      const key = request.headers['x-api-key'];
      if (!key || !apiKeys.includes(key as string)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    });
  }

  app.get('/health', async (_request, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try { await checkDbHealth(); checks.database = 'ok'; }
    catch { checks.database = 'error'; healthy = false; }

    const queueOk = isQueueConnected();
    checks.queue = queueOk ? 'ok' : 'disconnected';
    if (!queueOk) healthy = false;

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'api-service',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  app.post<{ Body: Omit<TestRequest, 'id' | 'createdAt'> }>(
    '/tests',
    async (request, reply) => {
      const { type, targetUrl, description, options, thresholds, steps, envVars } = request.body;

      const validTypes: TestType[] = ['backend', 'client-side', 'flow'];
      if (!validTypes.includes(type)) {
        return reply.code(400).send({ error: `Invalid test type. Use: ${validTypes.join(', ')}` });
      }
      if (description && description.length > 500) {
        return reply.code(400).send({ error: 'Description must be 500 characters or fewer' });
      }
      if (steps && steps.length > 20) {
        return reply.code(400).send({ error: 'Flow tests support a maximum of 20 steps' });
      }

      // For flow tests, targetUrl defaults to first step's URL
      const effectiveTargetUrl = (type === 'flow' && steps?.length)
        ? (targetUrl || steps[0].url)
        : targetUrl;

      // Validate URL format
      try { new URL(effectiveTargetUrl); } catch {
        return reply.code(400).send({ error: 'Invalid targetUrl — must be a valid URL' });
      }

      const backendOpts = type === 'backend' ? (options as BackendTestOptions) : undefined;
      const flowCacheKey = (type === 'flow' && steps?.length) ? stepsToKey(steps as FlowStep[]) : undefined;

      const test: EnrichedTestRequest = {
        id: crypto.randomUUID(),
        type,
        targetUrl: effectiveTargetUrl,
        description,
        options,
        thresholds,
        steps,
        envVars,
        scriptCacheKey: flowCacheKey,
        createdAt: new Date().toISOString(),
      };

      const rawDuration = (options as BackendTestOptions & { duration?: string }).duration;
      const durationSeconds = rawDuration ? parseDurationSeconds(rawDuration) : undefined;

      await fetch(
        `${process.env.RESULTS_URL || 'http://results-service:3004'}/results/pending`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testId: test.id, type: test.type, targetUrl: test.targetUrl, durationSeconds }),
        }
      );

      const existingScript = await findExistingScript(effectiveTargetUrl, type, backendOpts, undefined, flowCacheKey);

      if (!existingScript) {
        // Cache miss — generate new script
        publishTest(test, false);
        return { success: true, test, scriptReused: false };
      }

      if (!description || type === 'flow') {
        // No description to compare, or flow test (keyed by step hash) — reuse directly
        request.log.info({ targetUrl, usedCount: existingScript.usedCount }, 'Reusing cached script (no description comparison)');
        await incrementUsedCount(existingScript.id);
        test.generatedScript = existingScript.script;
        test.scriptId = existingScript.id;
        test.reusedScript = true;
        publishTest(test, true);
        return { success: true, test, scriptReused: true, scriptUsedCount: existingScript.usedCount };
      }

      // Description provided + cached script — route through ai-service for Gemini comparison
      request.log.info({ targetUrl }, 'Sending to AI for description comparison');
      test.cachedScript = existingScript.script;
      test.cachedScriptDescription = existingScript.description;
      test.scriptId = existingScript.id;
      publishTest(test, false);
      return { success: true, test, scriptReused: false };
    }
  );

  app.post<{ Params: { testId: string } }>(
    '/tests/:testId/cancel',
    async (request, reply) => {
      const { testId } = request.params;
      const resultsUrl = process.env.RESULTS_URL || 'http://results-service:3004';

      const res = await fetch(`${resultsUrl}/results/${testId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return reply.code(res.status).send(body);
      }

      publishCancel(testId);
      return { success: true, testId };
    }
  );

  return app;
};

const start = async (): Promise<void> => {
  try {
    await connectQueue();
    const app = await buildApp();
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

if (!process.env.VITEST) {
  start();
}
