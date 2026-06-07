import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { Pool } from 'pg';
import PDFDocument from 'pdfkit';
import cronValidator from 'node-cron';
import { isConsumerConnected } from './consumer';
import { reloadSchedule, removeSchedule } from './scheduler';
import { setupWebSocketServer, broadcast } from './ws';
import { findOrCreateProject } from './db';
import { signSession, verifySession, SessionPayload } from './session';

// Augment Fastify request type with session payload — must be at module level
declare module 'fastify' {
  interface FastifyRequest {
    session: SessionPayload | null;
    projectId: string | undefined;
  }
}

export const buildApp = async (
  pool: Pool,
  opts: { logger?: boolean; readPool?: Pool } = {}
): Promise<FastifyInstance> => {
  // Use read replica for GET queries when available; fall back to primary pool
  const rPool = opts.readPool ?? pool;
  const app = Fastify({ logger: opts.logger ?? false });

  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  await app.register(cors, { origin: allowedOrigin, credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
  await app.register(cookie);

  // Attach WebSocket server to Fastify's underlying http.Server.
  // Handles GET /ws upgrade without any Fastify plugin — works with Fastify v5.
  setupWebSocketServer(app.server);

  const sessionSecret = process.env.SESSION_SECRET || '';
  const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

  // Internal endpoints called by backend services (no cookie) — always exempt
  const internalPaths = new Set(['/health', '/system/ai-status', '/results/pending', '/ws']);
  const internalSuffixes = ['/running', '/fail', '/message', '/live'];
  const isInternal = (url: string) =>
    internalPaths.has(url.split('?')[0]) ||
    internalSuffixes.some(s => url.split('?')[0].endsWith(s));

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (url === '/auth/login' || url === '/auth/logout' || url === '/auth/me') return;
    if (isInternal(request.url)) return;

    // API key auth (existing, kept for backward compat)
    if (apiKeys.length > 0) {
      const key = request.headers['x-api-key'];
      if (!key || !apiKeys.includes(key as string)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    }

    // Session auth — only enforced when SESSION_SECRET is configured
    if (sessionSecret) {
      const session = verifySession(request.cookies['alt_session'], sessionSecret);
      if (!session) return reply.code(401).send({ error: 'Not authenticated' });
      request.session = session;
      request.projectId = session.projectId;
    } else {
      request.session = null;
      request.projectId = undefined;
    }
  });

  // ── Auth endpoints ────────────────────────────────────────────────────────
  app.post<{ Body: { username: string; projectName: string } }>(
    '/auth/login',
    async (request, reply) => {
      const { username, projectName } = request.body ?? {};
      if (!username?.trim() || !projectName?.trim()) {
        return reply.code(400).send({ error: 'username and projectName are required' });
      }
      if (!sessionSecret) {
        // Auth disabled — return a dummy session so the UI works in dev
        return { projectId: 'dev', username: username.trim(), projectName: projectName.trim() };
      }
      const projectId = await findOrCreateProject(projectName.trim(), pool);
      const payload: SessionPayload = { projectId, username: username.trim(), projectName: projectName.trim().toLowerCase() };
      const cookieValue = signSession(payload, sessionSecret);
      reply.setCookie('alt_session', cookieValue, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60,
        ...(process.env.DOMAIN ? { domain: `.${process.env.DOMAIN}` } : {}),
      });
      return payload;
    }
  );

  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie('alt_session', { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (request, reply) => {
    if (!sessionSecret) return { projectId: 'dev', username: 'dev', projectName: 'dev' };
    const session = verifySession(request.cookies?.['alt_session'], sessionSecret);
    if (!session) return reply.code(401).send({ error: 'Not authenticated' });
    return session;
  });

  app.get('/health', async (_request, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try { await pool.query('SELECT 1'); checks.database = 'ok'; }
    catch { checks.database = 'error'; healthy = false; }

    checks.queue = isConsumerConnected() ? 'ok' : 'disconnected';
    if (!isConsumerConnected()) healthy = false;

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'results-service',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/system/ai-status', async (_request, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT status_message, created_at FROM test_results
         WHERE created_at > NOW() - INTERVAL '2 hours'
           AND (status_message ILIKE '%gemini unavailable%'
             OR status_message ILIKE '%quota exceeded%'
             OR status_message ILIKE '%generation failed after%'
             OR status_message ILIKE '%gemini quota exceeded%'
             OR status_message ILIKE '%gemini rate limit%')
         ORDER BY created_at DESC LIMIT 1`
      );
      if (rows.length === 0) return { quotaExceeded: false };
      return { quotaExceeded: true, message: rows[0].status_message as string, since: rows[0].created_at as string };
    } catch {
      return { quotaExceeded: false };
    }
  });

  app.get('/system/health', async (_request, reply) => {
    const recorderUrl = process.env.RECORDER_URL || 'http://recorder-service:3007';
    const services = [
      { name: 'api-service',       url: `${process.env.API_SERVICE_URL || 'http://api-service:3000'}/health` },
      { name: 'ai-service',        url: `${process.env.AI_SERVICE_URL  || 'http://ai-service:3001'}/health` },
      { name: 'worker-backend',    url: `${process.env.WORKER_BACKEND_URL || 'http://worker-backend:3002'}/health` },
      { name: 'worker-client',     url: `${process.env.WORKER_CLIENT_URL  || 'http://worker-client:3003'}/health` },
      { name: 'recorder-service',  url: `${recorderUrl}/health` },
      { name: 'analyser-service',  url: `${process.env.ANALYSER_URL || 'http://analyser-service:3008'}/health` },
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
      })
    );

    // Also include self
    let selfOk = true;
    const selfChecks: Record<string, string> = {};
    try { await pool.query('SELECT 1'); selfChecks.database = 'ok'; } catch { selfChecks.database = 'error'; selfOk = false; }
    selfChecks.queue = isConsumerConnected() ? 'ok' : 'disconnected';
    if (!isConsumerConnected()) selfOk = false;
    results.unshift({ name: 'results-service', status: selfOk ? 'ok' : 'degraded', checks: selfChecks });

    const allHealthy = results.every(r => r.status === 'ok');
    return reply.code(allHealthy ? 200 : 207).send({ healthy: allHealthy, services: results });
  });

  app.post<{ Params: { testId: string }; Body: { message: string } }>(
    '/results/:testId/message',
    async (request, reply) => {
      try {
        const { testId } = request.params;
        await pool.query(
          `UPDATE test_results SET status_message = $1 WHERE test_id = $2`,
          [request.body.message, testId]
        );
        return { success: true };
      } catch {
        return reply.code(500).send({ error: 'Failed to update status message' });
      }
    }
  );

  app.post<{ Params: { testId: string } }>(
    '/results/:testId/fail',
    async (request, reply) => {
      try {
        const { testId } = request.params;
        const { rowCount } = await pool.query(
          `UPDATE test_results SET status = 'failed', completed_at = NOW(), status_message = NULL WHERE test_id = $1 AND status IN ('pending', 'running')`,
          [testId]
        );
        if (rowCount) {
          broadcast({ type: 'test:status', testId, status: 'failed', perfStatus: null });
          broadcast({ type: 'tests:changed' });
        }
        return { success: true };
      } catch (err) {
        return reply.code(500).send({ error: 'Failed to mark test as failed' });
      }
    }
  );

  app.post<{ Params: { testId: string } }>(
    '/results/:testId/running',
    async (request, reply) => {
      try {
        const { testId } = request.params;
        await pool.query(
          `UPDATE test_results SET status = 'running', started_at = NOW(), status_message = NULL WHERE test_id = $1`,
          [testId]
        );
        broadcast({ type: 'test:status', testId, status: 'running', perfStatus: null });
        broadcast({ type: 'tests:changed' });
        return { success: true };
      } catch (err) {
        return reply.code(500).send({ error: 'Failed to mark test as running' });
      }
    }
  );

  app.get<{ Querystring: { before?: string; limit?: string } }>(
    '/results',
    async (request, reply) => {
      try {
        const rawLimit = parseInt(request.query.limit ?? '50');
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
        const before = request.query.before;
        const projectId = request.projectId ?? null;

        const { rows } = before
          ? await rPool.query(
              `SELECT r.*, s.description AS script_description
               FROM test_results r
               LEFT JOIN test_scripts s ON r.script_id = s.id
               WHERE ($1::uuid IS NULL OR r.project_id = $1::uuid)
                 AND r.created_at < $2
               ORDER BY r.created_at DESC LIMIT $3`,
              [projectId, before, limit]
            )
          : await rPool.query(
              `SELECT r.*, s.description AS script_description
               FROM test_results r
               LEFT JOIN test_scripts s ON r.script_id = s.id
               WHERE ($1::uuid IS NULL OR r.project_id = $1::uuid)
               ORDER BY r.created_at DESC LIMIT $2`,
              [projectId, limit]
            );
        return { results: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].created_at : null };
      } catch (err) {
        return reply.code(500).send({ error: 'Failed to fetch results' });
      }
    }
  );

  app.post<{ Body: { testId: string; type: string; targetUrl: string; durationSeconds?: number; steps?: unknown[]; testData?: unknown[]; projectId?: string } }>(
    '/results/pending',
    async (request, reply) => {
      try {
        const { testId, type, targetUrl, durationSeconds, steps, testData, projectId } = request.body;
        await pool.query(
          `INSERT INTO test_results (test_id, type, target_url, status, duration_seconds, steps, test_data, project_id)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
           ON CONFLICT (test_id) DO NOTHING`,
          [testId, type, targetUrl, durationSeconds ?? null, steps ? JSON.stringify(steps) : null, testData ? JSON.stringify(testData) : null, projectId ?? null]
        );
        return { success: true };
      } catch (err) {
        return reply.code(500).send({ error: 'Failed to create pending result' });
      }
    }
  );

  app.get('/results/active', async (request, reply) => {
    try {
      const projectId = request.projectId ?? null;
      const { rows } = await rPool.query(
        `SELECT test_id, type, target_url, status, created_at
         FROM test_results
         WHERE status IN ('pending', 'running')
           AND ($1::uuid IS NULL OR project_id = $1::uuid)
         ORDER BY created_at DESC`,
        [projectId]
      );
      return { active: rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch active tests' });
    }
  });

  app.get<{ Params: { testId: string } }>(
    '/results/:testId',
    async (request, reply) => {
      const { testId } = request.params;
      const projectId = request.projectId ?? null;
      const { rows } = await rPool.query(
        `SELECT r.*, s.script, s.description AS script_description
         FROM test_results r
         LEFT JOIN test_scripts s ON r.script_id = s.id
         WHERE r.test_id = $1 AND ($2::uuid IS NULL OR r.project_id = $2::uuid)`,
        [testId, projectId]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Result not found' });
      }
      return { result: rows[0] };
    }
  );

  app.get('/scripts', async (request, reply) => {
    try {
      const projectId = request.projectId ?? null;
      const { rows } = await rPool.query(
        `SELECT id, target_url, test_type, used_count, created_at, updated_at
         FROM test_scripts
         WHERE ($1::uuid IS NULL OR project_id = $1::uuid)
         ORDER BY used_count DESC`,
        [projectId]
      );
      return { scripts: rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch scripts' });
    }
  });

  app.get<{ Params: { id: string } }>(
    '/scripts/:id',
    async (request, reply) => {
      const { id } = request.params;
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        'SELECT * FROM test_scripts WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)',
        [id, projectId]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Script not found' });
      }
      return { script: rows[0] };
    }
  );

  app.post<{
    Params: { testId: string };
    Body: { timestamp: string; vus: number; rps: number; avgResponseTime: number; errorRate: number; stepMetrics?: Array<{ name: string; avgResponseTime: number; rps: number; errorRate: number }> };
  }>('/results/:testId/live', async (request, reply) => {
    const { testId } = request.params;
    const { timestamp, vus, rps, avgResponseTime, errorRate, stepMetrics } = request.body;
    try {
      await pool.query(
        `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate, step_metrics)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [testId, timestamp, vus, rps, avgResponseTime, errorRate, stepMetrics ? JSON.stringify(stepMetrics) : null]
      );
      reply.send({ success: true });
      // Broadcast after the HTTP response is flushed so the worker isn't blocked
      setImmediate(() => broadcast({ type: 'test:live', testId, point: { timestamp, vus, rps, avgResponseTime, errorRate, stepMetrics } }));
      return reply;
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to save live metric' });
    }
  });

  app.get<{ Params: { testId: string } }>(
    '/results/:testId/live',
    async (request, reply) => {
      const { testId } = request.params;
      try {
        const { rows } = await rPool.query(
          `SELECT timestamp, vus, rps, avg_response_time AS "avgResponseTime", error_rate AS "errorRate", step_metrics AS "stepMetrics"
           FROM live_metrics WHERE test_id = $1 ORDER BY timestamp ASC`,
          [testId]
        );
        return { points: rows };
      } catch (err) {
        return reply.code(500).send({ error: 'Failed to fetch live metrics' });
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/scripts/:id',
    async (request, reply) => {
      const { id } = request.params;
      const projectId = request.projectId ?? null;
      await pool.query('DELETE FROM test_scripts WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)', [id, projectId]);
      return reply.code(204).send();
    }
  );

  // ── r2: Test cancellation ─────────────────────────────────────────────────
  app.post<{ Params: { testId: string } }>(
    '/results/:testId/cancel',
    async (request, reply) => {
      const { testId } = request.params;
      const { rowCount } = await pool.query(
        `UPDATE test_results SET status = 'cancelled', status_message = NULL
         WHERE test_id = $1 AND status IN ('pending', 'running')`,
        [testId]
      );
      if (!rowCount) return reply.code(404).send({ error: 'Test not found or already finished' });
      broadcast({ type: 'test:status', testId, status: 'cancelled', perfStatus: null });
      broadcast({ type: 'tests:changed' });
      return { success: true, testId };
    }
  );

  // ── f1: Baseline management ───────────────────────────────────────────────
  app.post<{ Params: { testId: string } }>(
    '/results/:testId/baseline',
    async (request, reply) => {
      const { testId } = request.params;
      const { rows } = await pool.query(
        `SELECT target_url, type FROM test_results WHERE test_id = $1 AND status = 'completed'`,
        [testId]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Completed result not found' });
      const { target_url, type } = rows[0];
      await pool.query(
        `UPDATE test_results SET is_baseline = FALSE WHERE target_url = $1 AND type = $2`,
        [target_url, type]
      );
      await pool.query(`UPDATE test_results SET is_baseline = TRUE WHERE test_id = $1`, [testId]);
      return { success: true, testId };
    }
  );

  app.delete<{ Params: { testId: string } }>(
    '/results/:testId/baseline',
    async (request, reply) => {
      await pool.query(`UPDATE test_results SET is_baseline = FALSE WHERE test_id = $1`, [request.params.testId]);
      return reply.code(204).send();
    }
  );

  // ── f5: Manual run comparison ─────────────────────────────────────────────
  app.get<{ Querystring: { a: string; b: string } }>(
    '/results/compare',
    async (request, reply) => {
      const { a, b } = request.query;
      if (!a || !b) return reply.code(400).send({ error: 'Query params a and b are required' });
      const projectId = request.projectId ?? null;
      const { rows } = await rPool.query(
        `SELECT r.*, s.script, s.description AS script_description FROM test_results r
         LEFT JOIN test_scripts s ON r.script_id = s.id
         WHERE r.test_id = ANY($1) AND ($2::uuid IS NULL OR r.project_id = $2::uuid)`,
        [[a, b], projectId]
      );
      if (rows.length < 2) return reply.code(404).send({ error: 'One or both results not found' });
      const [resultA, resultB] = rows[0].test_id === a ? [rows[0], rows[1]] : [rows[1], rows[0]];
      return { resultA, resultB };
    }
  );

  // ── f6: Trend chart per URL ───────────────────────────────────────────────
  app.get<{ Querystring: { url: string; limit?: string } }>(
    '/results/trend',
    async (request, reply) => {
      const { url, limit } = request.query;
      if (!url) return reply.code(400).send({ error: 'Query param url is required' });
      const n = Math.min(parseInt(limit ?? '20', 10), 100);
      const projectId = request.projectId ?? null;
      const { rows } = await rPool.query(
        `SELECT test_id, type, status, metrics, perf_status, created_at
         FROM test_results
         WHERE target_url = $1 AND status = 'completed'
           AND ($3::uuid IS NULL OR project_id = $3::uuid)
         ORDER BY created_at DESC
         LIMIT $2`,
        [url, n, projectId]
      );
      return { url, trend: rows.reverse() };
    }
  );

  // ── f7: Webhook CRUD ──────────────────────────────────────────────────────
  app.post<{ Body: { url: string; events?: string[]; secret?: string; format?: string } }>(
    '/webhooks',
    async (request, reply) => {
      const { url, events = ['failed', 'degraded'], secret, format = 'generic' } = request.body;
      if (!url) return reply.code(400).send({ error: 'url is required' });
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `INSERT INTO webhooks (url, events, secret, format, project_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [url, events, secret ?? null, format, projectId]
      );
      return reply.code(201).send({ webhook: rows[0] });
    }
  );

  app.get('/webhooks', async (request) => {
    const projectId = request.projectId ?? null;
    const { rows } = await rPool.query(
      `SELECT id, url, events, format, created_at FROM webhooks
       WHERE ($1::uuid IS NULL OR project_id = $1::uuid)
       ORDER BY created_at DESC`,
      [projectId]
    );
    return { webhooks: rows };
  });

  app.delete<{ Params: { id: string } }>(
    '/webhooks/:id',
    async (request, reply) => {
      const projectId = request.projectId ?? null;
      await pool.query(`DELETE FROM webhooks WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`, [request.params.id, projectId]);
      return reply.code(204).send();
    }
  );

  // ── External metrics fetcher (used by AI insights + diagnose) ──────────────
  /**
   * For each log source that has a metrics_endpoint_template configured,
   * interpolate the test timestamps, fetch the API, and return truncated JSON.
   * Never throws — returns [] on any error so AI analysis is never blocked.
   */
  async function fetchExternalMetrics(
    targetUrl: string,
    startedAt: string | null,
    completedAt: string | null,
  ): Promise<Array<{ sourceName: string; platform: string | null; data: string }>> {
    const { rows } = await pool.query(
      `SELECT name, platform, metrics_endpoint_template, auth_header
       FROM log_sources WHERE metrics_endpoint_template IS NOT NULL`
    );
    if (rows.length === 0) return [];

    const started  = startedAt  ? new Date(startedAt)  : new Date(Date.now() - 3_600_000);
    const completed = completedAt ? new Date(completedAt) : new Date();

    const interpolate = (template: string) =>
      template
        .replaceAll('{startedAtMs}',      String(started.getTime()))
        .replaceAll('{completedAtMs}',    String(completed.getTime()))
        .replaceAll('{startedAtS}',       String(Math.floor(started.getTime() / 1000)))
        .replaceAll('{completedAtS}',     String(Math.floor(completed.getTime() / 1000)))
        .replaceAll('{startedAtISO}',     started.toISOString())
        .replaceAll('{completedAtISO}',   completed.toISOString())
        .replaceAll('{targetUrl}',        targetUrl)
        .replaceAll('{targetUrlEncoded}', encodeURIComponent(targetUrl));

    const results: Array<{ sourceName: string; platform: string | null; data: string }> = [];

    await Promise.allSettled(
      rows.map(async (row: { name: string; platform: string | null; metrics_endpoint_template: string; auth_header: string | null }) => {
        try {
          const url = interpolate(row.metrics_endpoint_template);
          const headers: Record<string, string> = { 'Accept': 'application/json' };
          if (row.auth_header) headers['Authorization'] = row.auth_header;

          const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
          if (!res.ok) return;
          const text = await res.text();
          results.push({
            sourceName: row.name,
            platform: row.platform,
            data: text.slice(0, 3000), // cap at 3 KB per source
          });
        } catch { /* non-fatal */ }
      })
    );

    return results;
  }

  // ── AI-5: Cron natural-language assistant ───────────────────────────────
  app.post<{ Body: { phrase: string } }>(
    '/ai/cron',
    async (request, reply) => {
      const { phrase } = request.body;
      if (!phrase) return reply.code(400).send({ error: 'phrase is required' });
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });
        const result = await model.generateContent(
          `Convert this plain-English schedule description to a standard cron expression (5 fields: minute hour day month weekday).
Also provide a short human-readable preview confirming when it runs.

Description: "${phrase}"

Return ONLY valid JSON: {"cron": "* * * * *", "preview": "Every minute"}`
        );
        const text = result.response.text().trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return JSON.parse(match[0]);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── AI-7: Trend regression narrative ────────────────────────────────────
  app.post<{ Body: { trend: Array<{ created_at: string; metrics: Record<string, number>; perf_status?: string }> } }>(
    '/ai/trend-narrative',
    async (request, reply) => {
      const { trend } = request.body;
      if (!trend || trend.length < 3) return reply.code(422).send({ error: 'Need at least 3 trend points' });
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });
      try {
        const summary = trend.map(t => ({
          date: t.created_at,
          p95: t.metrics.p95ResponseTime ?? t.metrics.p95_response_time,
          rps: t.metrics.rps,
          perfStatus: t.perf_status,
        }));
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });
        const result = await model.generateContent(
          `You are a performance engineer. Write a 2-sentence plain-English summary of this load test trend. Focus on what changed and what it means for the system.

Trend data (chronological):
${JSON.stringify(summary, null, 2)}

Return ONLY valid JSON: {"narrative": "<2 sentences>"}`
        );
        const text = result.response.text().trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return JSON.parse(match[0]);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── AI-9: Optimal VU/duration recommendation ─────────────────────────────
  app.get<{ Querystring: { url: string; type?: string } }>(
    '/results/suggest-settings',
    async (request, reply) => {
      const { url, type = 'backend' } = request.query;
      if (!url) return reply.code(400).send({ error: 'url is required' });
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });
      try {
        const projectId = request.projectId ?? null;
        const { rows } = await pool.query(
          `SELECT metrics, perf_status FROM test_results
           WHERE target_url = $1 AND type = $2 AND status = 'completed'
             AND ($3::uuid IS NULL OR project_id = $3::uuid)
           ORDER BY created_at DESC LIMIT 5`,
          [url, type, projectId]
        );
        const history = rows.map((r: { metrics: Record<string,number>; perf_status: string }) => ({
          vus: r.metrics.vus, p95: r.metrics.p95ResponseTime, rps: r.metrics.rps, perfStatus: r.perf_status,
        }));
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });
        const result = await model.generateContent(
          `Suggest sensible load test settings for this URL: ${url}
Type: ${type}
${history.length > 0 ? `Recent run history:\n${JSON.stringify(history, null, 2)}` : 'No previous runs — suggest conservative defaults.'}

Return ONLY valid JSON:
{"vus": <number>, "duration": "<e.g. 1m>", "profile": "load|spike|soak|capacity", "reasoning": "<one sentence>"}`
        );
        const text = result.response.text().trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return JSON.parse(match[0]);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── AI-11: Webhook alert noise prediction ───────────────────────────────
  app.post<{ Body: { events: string[] } }>(
    '/ai/webhook-noise',
    async (request, reply) => {
      const { events } = request.body;
      if (!events?.length) return reply.code(400).send({ error: 'events is required' });
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });
      try {
        const { rows } = await pool.query(
          `SELECT perf_status, COUNT(*) as count
           FROM test_results WHERE status = 'completed' AND perf_status IS NOT NULL
           GROUP BY perf_status`
        );
        if (rows.length === 0) return { warning: null, message: 'Not enough run history to predict noise' };
        const dist = Object.fromEntries(rows.map((r: { perf_status: string; count: string }) => [r.perf_status, parseInt(r.count)]));
        const total = Object.values(dist).reduce((a, b) => a + b, 0);

        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });
        const result = await model.generateContent(
          `Analyse this load test result distribution and predict whether a webhook firing on [${events.join(', ')}] would be too noisy or never fire.

Historical result distribution (${total} total runs):
${JSON.stringify(dist)}

Return ONLY valid JSON:
{"level": "noisy|ok|silent", "message": "<one sentence warning or confirmation>"}`
        );
        const text = result.response.text().trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return { warning: null };
        const parsed = JSON.parse(match[0]) as { level: string; message: string };
        return { level: parsed.level, warning: parsed.level !== 'ok' ? parsed.message : null, message: parsed.message };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── AI-14: Preset name + tag suggestion ──────────────────────────────────
  app.post<{ Body: { url: string; type: string; vus?: number; duration?: string; profile?: string; stepCount?: number } }>(
    '/ai/preset-name',
    async (request, reply) => {
      const { url, type, vus, duration, profile, stepCount } = request.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });
        const result = await model.generateContent(
          `Suggest a short, descriptive name and 2-3 tags for a load test preset with these settings:
URL: ${url || 'n/a'}, Type: ${type}, VUs: ${vus ?? 'n/a'}, Duration: ${duration ?? 'n/a'}, Profile: ${profile ?? 'load'}${stepCount ? `, Steps: ${stepCount}` : ''}

Name should be concise (max 50 chars), human-readable, and describe what is being tested.
Tags should be lowercase, single words or hyphenated (e.g. "e2e", "smoke", "auth-flow").

Return ONLY valid JSON: {"name": "<name>", "tags": ["tag1", "tag2"]}`
        );
        const text = result.response.text().trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return JSON.parse(match[0]);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── AI-10: Parameterisation suggestions ─────────────────────────────────
  app.post<{ Body: { steps: Array<{ url: string; method: string; body?: string }> } }>(
    '/ai/param-suggestions',
    async (request, reply) => {
      const { steps } = request.body;
      if (!steps || steps.length === 0) return reply.code(400).send({ error: 'steps is required' });
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });
        const result = await model.generateContent(
          `You are an expert in load testing. Analyse these HTTP steps and identify any hardcoded values in URLs or request bodies that should be parameterised (user IDs, emails, product IDs, search terms, session tokens, etc.).
Suggest test-data column names for a CSV/JSON data file.

Steps:
${JSON.stringify(steps.slice(0, 20), null, 2)}

Return ONLY valid JSON:
{"columns": ["column_name_1", "column_name_2"], "reasoning": "<one sentence>"}`
        );
        const text = result.response.text().trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return JSON.parse(match[0]);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── AI-1: Threshold suggestions ─────────────────────────────────────────
  app.get<{ Querystring: { url: string; type?: string } }>(
    '/results/suggest-thresholds',
    async (request, reply) => {
      const { url, type = 'backend' } = request.query;
      if (!url) return reply.code(400).send({ error: 'url is required' });

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });

      try {
        const projectId = request.projectId ?? null;
        const { rows } = await pool.query(
          `SELECT metrics, perf_status, created_at
           FROM test_results
           WHERE target_url = $1 AND type = $2 AND status = 'completed' AND metrics IS NOT NULL
             AND ($3::uuid IS NULL OR project_id = $3::uuid)
           ORDER BY created_at DESC LIMIT 10`,
          [url, type, projectId]
        );
        if (rows.length < 2) {
          return reply.code(422).send({ error: 'Not enough completed runs to suggest thresholds (need at least 2)' });
        }

        const history = rows.map((r: { metrics: Record<string,number>; perf_status: string; created_at: string }) => ({
          p95: r.metrics.p95ResponseTime ?? r.metrics.p95_response_time,
          avg: r.metrics.avgResponseTime ?? r.metrics.avg_response_time,
          errorRate: r.metrics.requestsTotal > 0
            ? ((r.metrics.requestsFailed / r.metrics.requestsTotal) * 100).toFixed(2)
            : '0',
          rps: r.metrics.rps,
          perfStatus: r.perf_status,
          date: r.created_at,
        }));

        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });

        const prompt = `You are a performance engineering expert. Based on the following load test history for ${url}, suggest SLO threshold values that are realistic but meaningful (not so loose they never fire, not so tight they always fire).

Test history (last ${rows.length} runs):
${JSON.stringify(history, null, 2)}

Return ONLY valid JSON with this shape (all times in ms, rates as %):
{
  "p95": <number>,
  "avg": <number>,
  "errorRate": <number>,
  "reasoning": "<one sentence explaining the choices>"
}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return reply.code(500).send({ error: 'AI returned unexpected response' });

        const suggestions = JSON.parse(jsonMatch[0]);
        return { suggestions, runsAnalysed: rows.length };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── AI-4: Error root-cause diagnosis ────────────────────────────────────
  app.get<{ Params: { testId: string } }>(
    '/results/:testId/diagnose',
    async (request, reply) => {
      const { testId } = request.params;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });

      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `SELECT target_url, type, metrics, started_at, completed_at FROM test_results WHERE test_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
        [testId, projectId]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Result not found' });

      const { target_url, type, metrics, started_at, completed_at } = rows[0] as { target_url: string; type: string; metrics: Record<string, unknown>; started_at: string | null; completed_at: string | null };
      const externalMetrics = await fetchExternalMetrics(target_url, started_at, completed_at);
      const eb = metrics.errorBreakdown as Record<string, number> | undefined;
      const total = (metrics.requestsTotal as number) || 1;

      const errorCount = !eb ? 0 : (eb.clientError ?? 0) + (eb.serverError ?? 0) + (eb.timeout ?? 0) + (eb.networkError ?? 0);
      if (!eb || errorCount === 0) {
        return { diagnoses: [], message: 'No errors to diagnose' };
      }

      const errorSummary = {
        targetUrl: target_url,
        testType: type,
        totalRequests: metrics.requestsTotal,
        errorBreakdown: eb,
        errorRates: {
          clientError: `${((eb.clientError / total) * 100).toFixed(1)}%`,
          serverError: `${((eb.serverError / total) * 100).toFixed(1)}%`,
          timeout:     `${((eb.timeout / total) * 100).toFixed(1)}%`,
          networkError:`${((eb.networkError / total) * 100).toFixed(1)}%`,
        },
        p95ResponseTime: metrics.p95ResponseTime,
        avgResponseTime: metrics.avgResponseTime,
      };

      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });

        const externalSection = externalMetrics.length > 0
          ? `\n\nExternal observability data (from configured integrations):\n${externalMetrics.map(e => `--- ${e.sourceName}${e.platform ? ` (${e.platform})` : ''} ---\n${e.data}`).join('\n\n')}`
          : '';

        const prompt = `You are a performance engineering expert. A k6 load test produced the following error breakdown. Diagnose each non-zero error category with a likely root cause and one concrete next step.${externalSection ? ' Use the external observability data to enrich your diagnosis where relevant.' : ''}

Test data:
${JSON.stringify(errorSummary, null, 2)}${externalSection}

Return ONLY valid JSON array. Include only categories with count > 0:
[
  {
    "category": "serverError|clientError|timeout|networkError",
    "count": <number>,
    "likelyCause": "<one sentence>",
    "nextStep": "<one concrete action>"
  }
]`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) return { diagnoses: [], message: 'AI returned unexpected response' };
        return { diagnoses: JSON.parse(match[0]) };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── Log sources ──────────────────────────────────────────────────────────
  app.get('/log-sources', async (request) => {
    const projectId = request.projectId ?? null;
    const { rows } = await rPool.query(
      `SELECT * FROM log_sources WHERE ($1::uuid IS NULL OR project_id = $1::uuid) ORDER BY created_at DESC`,
      [projectId]
    );
    return { logSources: rows };
  });

  app.post<{ Body: { name: string; platform?: string; urlTemplate: string; metricsEndpointTemplate?: string; authHeader?: string } }>(
    '/log-sources',
    async (request, reply) => {
      const { name, platform, urlTemplate, metricsEndpointTemplate, authHeader } = request.body;
      if (!name || !urlTemplate) return reply.code(400).send({ error: 'name and urlTemplate are required' });
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `INSERT INTO log_sources (name, platform, url_template, metrics_endpoint_template, auth_header, project_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [name, platform ?? null, urlTemplate, metricsEndpointTemplate ?? null, authHeader ?? null, projectId]
      );
      return reply.code(201).send({ logSource: rows[0] });
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/log-sources/:id',
    async (request, reply) => {
      const projectId = request.projectId ?? null;
      await pool.query(`DELETE FROM log_sources WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`, [request.params.id, projectId]);
      return reply.code(204).send();
    }
  );

  // ── s2: Scheduled tests ───────────────────────────────────────────────────
  app.get('/schedules', async (request) => {
    const projectId = request.projectId ?? null;
    const { rows } = await rPool.query(
      `SELECT * FROM schedules WHERE ($1::uuid IS NULL OR project_id = $1::uuid) ORDER BY created_at DESC`,
      [projectId]
    );
    return { schedules: rows };
  });

  app.post<{ Body: { name: string; cron: string; type: string; target_url: string; description?: string; options: Record<string, unknown>; thresholds?: Record<string, unknown>; enabled?: boolean } }>(
    '/schedules',
    async (request, reply) => {
      const { name, cron, type, target_url, description, options, thresholds, enabled = true } = request.body;
      if (!name || !cron || !type || !target_url || !options) return reply.code(400).send({ error: 'name, cron, type, target_url, options are required' });
      if (!cronValidator.validate(cron)) return reply.code(400).send({ error: 'Invalid cron expression' });
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `INSERT INTO schedules (name, cron, type, target_url, description, options, thresholds, enabled, project_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [name, cron, type, target_url, description ?? null, JSON.stringify(options), thresholds ? JSON.stringify(thresholds) : null, enabled, projectId]
      );
      await reloadSchedule(pool, rows[0].id);
      return reply.code(201).send({ schedule: rows[0] });
    }
  );

  app.put<{ Params: { id: string }; Body: Partial<{ name: string; cron: string; enabled: boolean; options: Record<string, unknown>; thresholds: Record<string, unknown> }> }>(
    '/schedules/:id',
    async (request, reply) => {
      const { id } = request.params;
      const updates = request.body;
      const sets: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      if (updates.name     !== undefined) { sets.push(`name = $${i++}`);    vals.push(updates.name); }
      if (updates.cron     !== undefined) { sets.push(`cron = $${i++}`);    vals.push(updates.cron); }
      if (updates.enabled  !== undefined) { sets.push(`enabled = $${i++}`); vals.push(updates.enabled); }
      if (updates.options  !== undefined) { sets.push(`options = $${i++}`); vals.push(JSON.stringify(updates.options)); }
      if (updates.thresholds !== undefined) { sets.push(`thresholds = $${i++}`); vals.push(JSON.stringify(updates.thresholds)); }
      if (sets.length === 0) return reply.code(400).send({ error: 'No fields to update' });
      const projectId = request.projectId ?? null;
      vals.push(id);
      vals.push(projectId);
      const { rows } = await pool.query(`UPDATE schedules SET ${sets.join(', ')} WHERE id = $${i} AND ($${i + 1}::uuid IS NULL OR project_id = $${i + 1}::uuid) RETURNING *`, vals);
      if (rows.length === 0) return reply.code(404).send({ error: 'Schedule not found' });
      await reloadSchedule(pool, id);
      return { schedule: rows[0] };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/schedules/:id',
    async (request, reply) => {
      const projectId = request.projectId ?? null;
      removeSchedule(request.params.id);
      await pool.query(`DELETE FROM schedules WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`, [request.params.id, projectId]);
      return reply.code(204).send();
    }
  );

  app.post<{ Params: { id: string } }>(
    '/schedules/:id/run',
    async (request, reply) => {
      const projectId = request.projectId ?? null;
      const { rows } = await rPool.query(
        `SELECT * FROM schedules WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
        [request.params.id, projectId]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Schedule not found' });
      const s = rows[0];
      const apiUrl = process.env.API_URL || 'http://api-service:3000';
      const apiKey = process.env.API_KEY || '';
      const res = await fetch(`${apiUrl}/tests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: JSON.stringify({ type: s.type, targetUrl: s.target_url, description: s.description ?? `Scheduled: ${s.name}`, options: s.options, thresholds: s.thresholds ?? undefined }),
      });
      const body = await res.json();
      await pool.query(`UPDATE schedules SET last_run_at = NOW() WHERE id = $1`, [s.id]);
      return reply.code(res.status).send(body);
    }
  );

  // ── s3: Test presets ─────────────────────────────────────────────────────
  app.get('/presets', async (request) => {
    const projectId = request.projectId ?? null;
    const { rows } = await rPool.query(
      `SELECT * FROM test_presets WHERE ($1::uuid IS NULL OR project_id = $1::uuid) ORDER BY used_count DESC, created_at DESC`,
      [projectId]
    );
    return { presets: rows };
  });

  app.post<{ Body: { name: string; description?: string; type: string; target_url?: string; options: Record<string, unknown>; thresholds?: Record<string, unknown> } }>(
    '/presets',
    async (request, reply) => {
      const { name, description, type, target_url, options, thresholds } = request.body;
      if (!name || !type || !options) return reply.code(400).send({ error: 'name, type, options are required' });
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `INSERT INTO test_presets (name, description, type, target_url, options, thresholds, project_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [name, description ?? null, type, target_url ?? null, JSON.stringify(options), thresholds ? JSON.stringify(thresholds) : null, projectId]
      );
      return reply.code(201).send({ preset: rows[0] });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/presets/:id',
    async (request, reply) => {
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `UPDATE test_presets SET used_count = used_count + 1 WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid) RETURNING *`,
        [request.params.id, projectId]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Preset not found' });
      return { preset: rows[0] };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/presets/:id',
    async (request, reply) => {
      const projectId = request.projectId ?? null;
      await pool.query(`DELETE FROM test_presets WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`, [request.params.id, projectId]);
      return reply.code(204).send();
    }
  );

  // ── r6: PDF report ────────────────────────────────────────────────────────
  app.get<{ Params: { testId: string } }>(
    '/results/:testId/report.pdf',
    async (request, reply) => {
      const { testId } = request.params;
      const { rows } = await pool.query(
        `SELECT r.*, s.script FROM test_results r LEFT JOIN test_scripts s ON r.script_id = s.id WHERE r.test_id = $1`,
        [testId]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Result not found' });

      const result = rows[0];

      // AI-8: Executive summary
      let execSummary = '';
      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey && result.metrics && result.perf_status) {
        try {
          const m = result.metrics;
          const summaryCtx = {
            url: result.target_url, type: result.type, perfStatus: result.perf_status,
            p95: m.p95ResponseTime, avg: m.avgResponseTime, rps: m.rps,
            errorRate: m.requestsTotal > 0 ? ((m.requestsFailed / m.requestsTotal) * 100).toFixed(1) : '0',
            analysis: result.analysis?.summary,
          };
          const { GoogleGenerativeAI } = await import('@google/generative-ai');
          const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });
          const r = await model.generateContent(
            `Write a 3-sentence executive summary of this load test result for a non-technical manager. Be clear, factual, and end with a recommendation.
Data: ${JSON.stringify(summaryCtx)}
Return only the summary text, no JSON, no markdown.`
          );
          execSummary = r.response.text().trim();
        } catch { /* non-fatal */ }
      }

      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));

      // Header
      doc.fontSize(20).font('Helvetica-Bold').text('Load Test Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').fillColor('#666')
        .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown(1);

      // AI-8: Executive summary block
      if (execSummary) {
        doc.fontSize(11).font('Helvetica-Oblique').fillColor('#333')
          .text(execSummary, { align: 'left' });
        doc.moveDown(1);
      }

      // Summary box
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text('Test Summary');
      doc.moveDown(0.3);
      const summary = [
        ['Test ID',    result.test_id],
        ['URL',        result.target_url],
        ['Type',       result.type],
        ['Status',     result.status],
        ['Perf status', result.perf_status ?? '—'],
        ['Started',    result.started_at ? new Date(result.started_at).toLocaleString() : '—'],
        ['Completed',  result.completed_at ? new Date(result.completed_at).toLocaleString() : '—'],
      ];
      doc.fontSize(10).font('Helvetica');
      for (const [k, v] of summary) {
        doc.text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(String(v ?? '—')).font('Helvetica');
      }

      // Metrics
      if (result.metrics) {
        doc.moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text('Metrics');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica');
        const m = result.metrics;
        const metricRows: [string, unknown][] = m.type === 'backend'
          ? [
              ['Total requests',  m.requestsTotal],
              ['Failed requests', m.requestsFailed],
              ['Requests/sec',    m.rps?.toFixed(2)],
              ['Avg response',    `${Math.round(m.avgResponseTime)}ms`],
              ['p50 response',    `${Math.round(m.p50ResponseTime ?? 0)}ms`],
              ['p95 response',    `${Math.round(m.p95ResponseTime)}ms`],
              ['p99 response',    `${Math.round(m.p99ResponseTime)}ms`],
            ]
          : [
              ['LCP',  `${Math.round(m.lcp)}ms`],
              ['FCP',  `${Math.round(m.fcp)}ms`],
              ['TTFB', `${Math.round(m.ttfb)}ms`],
              ['FID',  `${Math.round(m.fid)}ms`],
              ['CLS',  m.cls?.toFixed(3)],
            ];
        for (const [k, v] of metricRows) {
          doc.text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(String(v ?? '—')).font('Helvetica');
        }
        if (m.type === 'client' && m.lighthouseScore) {
          doc.moveDown(0.5).font('Helvetica-Bold').text('Lighthouse Scores').font('Helvetica');
          const lh = m.lighthouseScore;
          for (const [k, v] of [['Performance', lh.performance], ['Accessibility', lh.accessibility], ['Best Practices', lh.bestPractices], ['SEO', lh.seo]] as [string, number][]) {
            doc.text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(`${v}/100`).font('Helvetica');
          }
        }
      }

      // Analysis
      if (result.analysis) {
        const a = result.analysis;
        doc.moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text('Performance Analysis');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').text(`Status: `, { continued: true })
          .font('Helvetica-Bold')
          .fillColor(a.perfStatus === 'passed' ? '#16a34a' : a.perfStatus === 'degraded' ? '#d97706' : '#dc2626')
          .text(a.perfStatus)
          .fillColor('#111').font('Helvetica');
        doc.text(`Summary: ${a.summary}`);
        if (a.thresholdViolations?.length) {
          doc.moveDown(0.5).font('Helvetica-Bold').text('Threshold violations:').font('Helvetica');
          for (const v of a.thresholdViolations) doc.text(`  • ${v}`);
        }
        if (a.diffs?.length) {
          doc.moveDown(0.5).font('Helvetica-Bold').text('Metric diffs vs baseline/previous:').font('Helvetica');
          for (const d of a.diffs) {
            const sign = d.diffPercent > 0 ? '+' : '';
            doc.text(`  ${d.metric}: ${d.current} (${sign}${d.diffPercent}%) — ${d.status}`);
          }
        }
      }

      doc.end();

      await new Promise<void>(resolve => doc.on('end', resolve));
      const pdf = Buffer.concat(chunks);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="report-${testId.slice(0, 8)}.pdf"`)
        .send(pdf);
    }
  );

  return app;
};
