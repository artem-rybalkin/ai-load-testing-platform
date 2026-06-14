import './tracing'; // must be first — OTel patches modules at import time
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';

import { TestRequest, TestType, EnrichedTestRequest, BackendTestOptions, FlowStep, TeamRole } from '@alt/shared';
import { connectQueue, publishTest, publishCancel, isQueueConnected, getWorkerConsumerCount } from './queue';
import { findExistingScript, checkDbHealth, stepsToKey, incrementUsedCount, pool } from './scripts';
import { getApiSession, hashApiKey } from './session';
import { checkTestQuota } from './quotas';
import { redisClient } from './redis';

// Augment Fastify request type — must be at module level
declare module 'fastify' {
  interface FastifyRequest { projectId: string | undefined; role: TeamRole | null; }
}

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const internalHeaders = (extra?: Record<string, string>): Record<string, string> => ({
  ...(INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {}),
  ...extra,
});

// Parses k6-style durations, including compound forms like "1h30m" or "1m30s"
// and decimals like "1.5m". Returns null if the string contains no recognizable
// duration component — callers must reject these rather than silently treating
// them as 0s (which would bypass the duration quota check).
const parseDurationSeconds = (d: string): number | null => {
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s|ms)/gi;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'h') total += n * 3600;
    else if (unit === 'm') total += n * 60;
    else if (unit === 'ms') total += n / 1000;
    else total += n;
  }
  return matched ? Math.round(total) : null;
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

  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX) || 600,
    timeWindow: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
    redis: redisClient,
    skipOnError: true,
    allowList: (request) => request.url === '/health',
  });

  // API key authentication — exempt /health
  const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const sessionSecret = process.env.SESSION_SECRET || '';

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;

    const apiKeyHeader = request.headers['x-api-key'] as string | undefined;

    // Per-team API key — scopes the request to one team regardless of global
    // API_KEYS / session config. Checked first since it's the most specific.
    if (apiKeyHeader && !apiKeys.includes(apiKeyHeader)) {
      const keyHash = hashApiKey(apiKeyHeader);
      try {
        const { rows } = await pool.query<{ team_id: string }>(
          `SELECT team_id FROM team_api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
          [keyHash]
        );
        if (rows.length > 0) {
          pool.query(`UPDATE team_api_keys SET last_used_at = NOW() WHERE key_hash = $1`, [keyHash]).catch(() => {});
          request.projectId = rows[0].team_id;
          request.role = 'admin';
          return;
        }
      } catch {
        // team_api_keys lookup unavailable — fall through to global API key / session checks
      }
    }

    if (apiKeys.length > 0) {
      if (!apiKeyHeader || !apiKeys.includes(apiKeyHeader)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    }

    if (sessionSecret) {
      const session = await getApiSession(pool, request.cookies?.['alt_session']);
      if (!session) return reply.code(401).send({ error: 'Not authenticated' });

      // A session with no current team (or no longer a member of it) has no
      // access to project-scoped resources. Unlike results-service, api-service
      // has no /teams or /orgs routes to except — every route here is project-scoped.
      if (session.role === null) {
        return reply.code(403).send({ error: 'No team selected — create or join a team first' });
      }

      request.projectId = session.projectId ?? undefined;
      request.role = session.role;
    } else {
      request.projectId = undefined;
      request.role = null;
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

    checks.redis = !redisClient ? 'disabled' : redisClient.status === 'ready' ? 'ok' : 'disconnected';

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
      const { type, targetUrl, description, options, thresholds, steps, envVars, testData, csvData, csvFilename, customScript, projectId: bodyProjectId } = request.body;

      // Internal callers authenticated via the global API_KEYS list (e.g. the
      // scheduler) may scope a test to a specific team by passing `projectId`.
      const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
      const isGlobalKeyAuth = apiKeys.length > 0 && !!apiKeyHeader && apiKeys.includes(apiKeyHeader);
      const effectiveProjectId = (isGlobalKeyAuth && bodyProjectId) ? bodyProjectId : request.projectId;

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
        projectId: effectiveProjectId,
        scriptCacheKey: flowCacheKey,
        createdAt: new Date().toISOString(),
      };

      const rawDuration = (options as BackendTestOptions & { duration?: string }).duration;
      let durationSeconds: number | undefined;
      if (rawDuration) {
        const parsed = parseDurationSeconds(rawDuration);
        if (parsed === null) {
          return reply.code(400).send({ error: 'Invalid duration format — use values like "30s", "5m", "1h30m"' });
        }
        durationSeconds = parsed;
      }

      const quotaError = await checkTestQuota(pool, effectiveProjectId, { type, options, durationSeconds });
      if (quotaError) {
        return reply.code(429).send({ error: quotaError });
      }

      // Create pending record for UI display — non-blocking; a slow or unavailable
      // results-service must not prevent the test from being queued.
      fetch(
        `${process.env.RESULTS_URL || 'http://results-service:3004'}/results/pending`,
        {
          method: 'POST',
          headers: internalHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ testId: test.id, type: test.type, targetUrl: test.targetUrl, durationSeconds, steps: test.steps, testData: test.testData, projectId: test.projectId }),
          signal: AbortSignal.timeout(5000),
        }
      ).catch(() => {});

      const resultsUrl = process.env.RESULTS_URL || 'http://results-service:3004';

      const postMessage = (message: string) =>
        fetch(`${resultsUrl}/results/${test.id}/message`, {
          method: 'POST',
          headers: internalHeaders({ 'Content-Type': 'application/json' }),
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

      const existingScript = await findExistingScript(effectiveTargetUrl, type, backendOpts, undefined, flowCacheKey, effectiveProjectId);

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

      const res = await fetch(`${resultsUrl}/results/${testId}/cancel`, { method: 'POST', headers: internalHeaders() });
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
