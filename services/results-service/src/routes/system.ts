/**
 * System / health route plugin:
 * GET /health, GET /system/ai-status, GET /system/ai-provider,
 * PUT /system/ai-provider, GET /system/live-metric-window,
 * PUT /system/live-metric-window, GET /system/health.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import type { AiProviderName, LiveMetricWindowSec } from '@alt/shared';
import { AI_PROVIDER_NAMES, isProviderConfigured } from '@alt/shared';
import {
  getAiProviderSetting,
  setAiProviderSetting,
  getEffectiveAiProviderSetting,
  getTeamAiProviderSetting,
  getLiveMetricWindowSetting,
  setLiveMetricWindowSetting,
} from '../settings';
import { isConsumerConnected } from '../consumer';
import { redisClient } from '../redis';

export async function systemRoutes(app: FastifyInstance, { pool }: { pool: Pool; rPool: Pool }): Promise<void> {
  // ── GET /health ───────────────────────────────────────────────────────────
  app.get('/health', async (_request, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try { await pool.query('SELECT 1'); checks.database = 'ok'; }
    catch { checks.database = 'error'; healthy = false; }

    checks.queue = isConsumerConnected() ? 'ok' : 'disconnected';
    if (!isConsumerConnected()) healthy = false;

    checks.redis = !redisClient ? 'disabled' : redisClient.status === 'ready' ? 'ok' : 'disconnected';

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'results-service',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // ── GET /system/ai-status ─────────────────────────────────────────────────
  app.get('/system/ai-status', async () => {
    try {
      const { rows } = await pool.query(
        `SELECT status_message, created_at FROM test_results
         WHERE created_at > NOW() - INTERVAL '2 hours'
           AND (status_message ILIKE '%gemini unavailable%'
             OR status_message ILIKE '%quota exceeded%'
             OR status_message ILIKE '%generation failed after%'
             OR status_message ILIKE '%gemini quota exceeded%'
             OR status_message ILIKE '%gemini rate limit%')
         ORDER BY created_at DESC LIMIT 1`,
      );
      if (rows.length === 0) return { quotaExceeded: false };
      return { quotaExceeded: true, message: rows[0].status_message as string, since: rows[0].created_at as string };
    } catch {
      return { quotaExceeded: false };
    }
  });

  // ── GET /system/ai-provider ───────────────────────────────────────────────
  app.get<{ Querystring: { teamId?: string } }>('/system/ai-provider', async (request) => {
    const teamId = request.query?.teamId;
    const available = {
      gemini: isProviderConfigured('gemini'),
      openai: isProviderConfigured('openai'),
      anthropic: isProviderConfigured('anthropic'),
    };
    if (teamId) {
      const [setting, teamSetting] = await Promise.all([
        getEffectiveAiProviderSetting(pool, teamId),
        getTeamAiProviderSetting(pool, teamId),
      ]);
      return { provider: setting.provider, fallbacks: setting.fallbacks, available, isOverride: teamSetting !== null };
    }
    const setting = await getAiProviderSetting(pool);
    return { provider: setting.provider, fallbacks: setting.fallbacks, available };
  });

  // ── PUT /system/ai-provider ───────────────────────────────────────────────
  app.put<{ Body: { provider: AiProviderName; fallbacks?: AiProviderName[] } }>(
    '/system/ai-provider',
    async (request, reply) => {
      if (request.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });
      const { provider, fallbacks } = request.body;
      if (!AI_PROVIDER_NAMES.includes(provider)) {
        return reply.code(400).send({ error: `provider must be one of: ${AI_PROVIDER_NAMES.join(', ')}` });
      }
      const cleanFallbacks = (fallbacks ?? []).filter(f => AI_PROVIDER_NAMES.includes(f) && f !== provider);
      const setting = { provider, fallbacks: cleanFallbacks };
      await setAiProviderSetting(pool, setting);
      return setting;
    },
  );

  // ── GET /system/live-metric-window ────────────────────────────────────────
  app.get('/system/live-metric-window', async () => {
    const windowSec = await getLiveMetricWindowSetting(pool);
    return { windowSec };
  });

  // ── PUT /system/live-metric-window ────────────────────────────────────────
  const LIVE_METRIC_WINDOW_VALUES: LiveMetricWindowSec[] = [10, 30, 60];
  app.put<{ Body: { windowSec: number } }>(
    '/system/live-metric-window',
    async (request, reply) => {
      if (request.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });
      const { windowSec } = request.body;
      if (!LIVE_METRIC_WINDOW_VALUES.includes(windowSec as LiveMetricWindowSec)) {
        return reply.code(400).send({ error: `windowSec must be one of: ${LIVE_METRIC_WINDOW_VALUES.join(', ')}` });
      }
      await setLiveMetricWindowSetting(pool, windowSec as LiveMetricWindowSec);
      return { windowSec };
    },
  );

  // ── GET /system/health ────────────────────────────────────────────────────
  app.get('/system/health', async (_request, reply) => {
    const recorderUrl = process.env.RECORDER_URL || 'http://recorder-service:3007';
    const services = [
      { name: 'api-service',      url: `${process.env.API_SERVICE_URL      || 'http://api-service:3000'}/health` },
      { name: 'ai-service',       url: `${process.env.AI_SERVICE_URL       || 'http://ai-service:3001'}/health` },
      { name: 'worker-backend',   url: `${process.env.WORKER_BACKEND_URL   || 'http://worker-backend:3002'}/health` },
      { name: 'worker-client',    url: `${process.env.WORKER_CLIENT_URL    || 'http://worker-client:3003'}/health` },
      { name: 'recorder-service', url: `${recorderUrl}/health` },
      { name: 'analyser-service', url: `${process.env.ANALYSER_URL         || 'http://analyser-service:3008'}/health` },
    ];

    const results = await Promise.all(
      services.map(async ({ name, url }) => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
          const body = await res.json().catch(() => ({})) as { status?: string; checks?: Record<string, string>; metrics?: Record<string, number> };
          const status = body.status ?? (res.ok ? 'ok' : 'degraded');
          return {
            name,
            status,
            checks: body.checks ?? {},
            ...(body.metrics ? { metrics: body.metrics } : {}),
          };
        } catch {
          return { name, status: 'unreachable', checks: {} };
        }
      }),
    );

    let selfOk = true;
    const selfChecks: Record<string, string> = {};
    try { await pool.query('SELECT 1'); selfChecks.database = 'ok'; } catch { selfChecks.database = 'error'; selfOk = false; }
    selfChecks.queue = isConsumerConnected() ? 'ok' : 'disconnected';
    if (!isConsumerConnected()) selfOk = false;
    results.unshift({ name: 'results-service', status: selfOk ? 'ok' : 'degraded', checks: selfChecks });

    const allHealthy = results.every(r => r.status === 'ok');
    return reply.code(allHealthy ? 200 : 207).send({ healthy: allHealthy, services: results });
  });
}
