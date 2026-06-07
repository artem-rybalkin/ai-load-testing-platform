import './tracing'; // must be first — OTel patches modules at import time
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';

import { TestRequest, TestType, EnrichedTestRequest, BackendTestOptions, SLOThresholds, FlowStep } from '@alt/shared';
import { connectQueue, publishTest, publishCancel, isQueueConnected, getWorkerConsumerCount } from './queue';
import { findExistingScript, checkDbHealth, stepsToKey, incrementUsedCount } from './scripts';
import { verifySession } from './session';

// Augment Fastify request type — must be at module level
declare module 'fastify' {
  interface FastifyRequest { projectId: string | undefined; }
}

const parseDurationSeconds = (d: string): number => {
  const m = d.match(/^(\d+)(s|m|h)$/i);
  if (!m) return 0;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  return n; // seconds
};

/**
 * Remove fields that must never leave the api-service boundary:
 *  - envVars    — caller-supplied credentials passed to k6 as --env flags
 *  - testData   — parameterization rows (may contain usernames/passwords)
 *  - csvData    — base64-encoded CSV with the same concerns
 *  - csvFilename — unnecessary metadata once the test is queued
 *  - generatedScript / cachedScript / cachedScriptDescription
 *                 — internal pipeline state; large blobs
 */
const safeTestResponse = ({
  envVars: _ev,
  testData: _td,
  csvData: _cd,
  csvFilename: _cf,
  customScript: _cscript,
  generatedScript: _gs,
  cachedScript: _cs,
  cachedScriptDescription: _csd,
  ...safe
}: EnrichedTestRequest) => safe;

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  await app.register(cors, {
    origin: allowedOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);

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

  const sessionSecret = process.env.SESSION_SECRET || '';

  // Session auth runs after API key hook
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    if (sessionSecret) {
      const session = verifySession(request.cookies?.['alt_session'], sessionSecret);
      if (!session) return reply.code(401).send({ error: 'Not authenticated' });
      request.projectId = session.projectId;
    } else {
      request.projectId = undefined;
    }
  });

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
      const { type, targetUrl, description, options, thresholds, steps, envVars, testData, csvData, csvFilename, customScript } = request.body;

      const validTypes: TestType[] = ['backend', 'client-side', 'flow'];
      if (!validTypes.includes(type)) {
        return reply.code(400).send({ error: `Invalid test type. Use: ${validTypes.join(', ')}` });
      }
      if (description && description.length > 500) {
        return reply.code(400).send({ error: 'Description must be 500 characters or fewer' });
      }
      if (steps && steps.length > 50) {
        return reply.code(400).send({ error: 'Flow tests support a maximum of 50 steps' });
      }

      // For flow tests, targetUrl defaults to first step's URL
      const effectiveTargetUrl = (type === 'flow' && steps?.length)
        ? (targetUrl || steps[0].url)
        : targetUrl;

      // Validate URL format and scheme
      let parsedUrl: URL;
      try { parsedUrl = new URL(effectiveTargetUrl); } catch {
        return reply.code(400).send({ error: 'Invalid targetUrl — must be a valid URL' });
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return reply.code(400).send({ error: 'Invalid targetUrl — must use http or https' });
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
        testData,
        csvData,
        csvFilename,
        customScript,
        projectId: request.projectId,
        scriptCacheKey: flowCacheKey,
        createdAt: new Date().toISOString(),
      };

      const rawDuration = (options as BackendTestOptions & { duration?: string }).duration;
      const durationSeconds = rawDuration ? parseDurationSeconds(rawDuration) : undefined;

      // Create pending record for UI display — non-blocking; a slow or unavailable
      // results-service must not prevent the test from being queued.
      fetch(
        `${process.env.RESULTS_URL || 'http://results-service:3004'}/results/pending`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testId: test.id, type: test.type, targetUrl: test.targetUrl, durationSeconds, steps: test.steps, testData: test.testData, projectId: test.projectId }),
          signal: AbortSignal.timeout(5000),
        }
      ).catch(() => {});

      const resultsUrl = process.env.RESULTS_URL || 'http://results-service:3004';

      const postMessage = (message: string) =>
        fetch(`${resultsUrl}/results/${test.id}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        }).catch(() => {});

      const warnIfNoWorker = async () => {
        const consumers = await getWorkerConsumerCount(type);
        if (consumers === 0) {
          const label = type === 'client-side' ? 'browser (Puppeteer)' : 'backend (k6)';
          postMessage(`No ${label} worker is running — test will start when a worker comes online`).catch(() => {});
        }
      };

      const tryPublish = (skipAI: boolean) => {
        try {
          publishTest(test, skipAI);
        } catch (err) {
          postMessage(`Test could not be queued — message broker unavailable. Restart the api-service when RabbitMQ recovers. (${(err as Error).message})`);
          throw err;
        }
      };

      // Custom script path — bypass AI and script cache entirely
      if (customScript) {
        if (customScript.length > 512 * 1024) {
          return reply.code(400).send({ error: 'Custom script must be 512 KB or smaller' });
        }
        test.generatedScript = customScript;
        tryPublish(true);
        warnIfNoWorker();
        return { success: true, test: safeTestResponse(test), scriptReused: false };
      }

      const existingScript = await findExistingScript(effectiveTargetUrl, type, backendOpts, undefined, flowCacheKey, request.projectId);

      if (!existingScript) {
        // Cache miss — generate new script
        tryPublish(false);
        warnIfNoWorker();
        return { success: true, test: safeTestResponse(test), scriptReused: false };
      }

      if (!description || type === 'flow') {
        // No description to compare, or flow test (keyed by step hash) — reuse directly
        request.log.info({ targetUrl, usedCount: existingScript.usedCount }, 'Reusing cached script (no description comparison)');
        await incrementUsedCount(existingScript.id);
        test.generatedScript = existingScript.script;
        test.scriptId = existingScript.id;
        test.reusedScript = true;
        tryPublish(true);
        warnIfNoWorker();
        return { success: true, test: safeTestResponse(test), scriptReused: true, scriptUsedCount: existingScript.usedCount };
      }

      // Description provided + cached script — route through ai-service for Gemini comparison
      request.log.info({ targetUrl }, 'Sending to AI for description comparison');
      test.cachedScript = existingScript.script;
      test.cachedScriptDescription = existingScript.description;
      test.scriptId = existingScript.id;
      tryPublish(false);
      warnIfNoWorker();
      return { success: true, test: safeTestResponse(test), scriptReused: false };
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
