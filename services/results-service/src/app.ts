import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';
import PDFDocument from 'pdfkit';
import { isConsumerConnected } from './consumer';
import { reloadSchedule, removeSchedule } from './scheduler';
import { setupWebSocketServer, broadcast } from './ws';

export const buildApp = async (
  pool: Pool,
  opts: { logger?: boolean } = {}
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: opts.logger ?? false });

  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  await app.register(cors, { origin: allowedOrigin, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });

  // Attach WebSocket server to Fastify's underlying http.Server.
  // Handles GET /ws upgrade without any Fastify plugin — works with Fastify v5.
  setupWebSocketServer(app.server);

  // API key authentication — exempt /health and internal /results/pending
  const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (apiKeys.length > 0) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/health' || request.url === '/system/ai-status' || request.url === '/results/pending' || request.url.endsWith('/running') || request.url.endsWith('/fail') || request.url.endsWith('/message')) return;
      const key = request.headers['x-api-key'];
      if (!key || !apiKeys.includes(key as string)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    });
  }

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
             OR status_message ILIKE '%generation failed after%')
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

  app.get('/results', async (_request, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.*, s.description AS script_description
         FROM test_results r
         LEFT JOIN test_scripts s ON r.script_id = s.id
         ORDER BY r.created_at DESC LIMIT 50`
      );
      return { results: rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch results' });
    }
  });

  app.post<{ Body: { testId: string; type: string; targetUrl: string; durationSeconds?: number; steps?: unknown[] } }>(
    '/results/pending',
    async (request, reply) => {
      try {
        const { testId, type, targetUrl, durationSeconds, steps } = request.body;
        await pool.query(
          `INSERT INTO test_results (test_id, type, target_url, status, duration_seconds, steps)
           VALUES ($1, $2, $3, 'pending', $4, $5)
           ON CONFLICT (test_id) DO NOTHING`,
          [testId, type, targetUrl, durationSeconds ?? null, steps ? JSON.stringify(steps) : null]
        );
        return { success: true };
      } catch (err) {
        return reply.code(500).send({ error: 'Failed to create pending result' });
      }
    }
  );

  app.get('/results/active', async (_request, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT test_id, type, target_url, status, created_at
         FROM test_results
         WHERE status IN ('pending', 'running')
         ORDER BY created_at DESC`
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
      const { rows } = await pool.query(
        `SELECT r.*, s.script, s.description AS script_description
         FROM test_results r
         LEFT JOIN test_scripts s ON r.script_id = s.id
         WHERE r.test_id = $1`,
        [testId]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Result not found' });
      }
      return { result: rows[0] };
    }
  );

  app.get('/scripts', async (_request, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, target_url, test_type, used_count, created_at, updated_at
         FROM test_scripts
         ORDER BY used_count DESC`
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
      const { rows } = await pool.query(
        'SELECT * FROM test_scripts WHERE id = $1',
        [id]
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
        const { rows } = await pool.query(
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
      await pool.query('DELETE FROM test_scripts WHERE id = $1', [id]);
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
      const { rows } = await pool.query(
        `SELECT r.*, s.script, s.description AS script_description FROM test_results r
         LEFT JOIN test_scripts s ON r.script_id = s.id
         WHERE r.test_id = ANY($1)`,
        [[a, b]]
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
      const { rows } = await pool.query(
        `SELECT test_id, type, status, metrics, perf_status, created_at
         FROM test_results
         WHERE target_url = $1 AND status = 'completed'
         ORDER BY created_at DESC
         LIMIT $2`,
        [url, n]
      );
      return { url, trend: rows.reverse() };
    }
  );

  // ── f7: Webhook CRUD ──────────────────────────────────────────────────────
  app.post<{ Body: { url: string; events?: string[]; secret?: string } }>(
    '/webhooks',
    async (request, reply) => {
      const { url, events = ['failed', 'degraded'], secret } = request.body;
      if (!url) return reply.code(400).send({ error: 'url is required' });
      const { rows } = await pool.query(
        `INSERT INTO webhooks (url, events, secret) VALUES ($1, $2, $3) RETURNING *`,
        [url, events, secret ?? null]
      );
      return reply.code(201).send({ webhook: rows[0] });
    }
  );

  app.get('/webhooks', async () => {
    const { rows } = await pool.query(`SELECT id, url, events, created_at FROM webhooks ORDER BY created_at DESC`);
    return { webhooks: rows };
  });

  app.delete<{ Params: { id: string } }>(
    '/webhooks/:id',
    async (request, reply) => {
      await pool.query(`DELETE FROM webhooks WHERE id = $1`, [request.params.id]);
      return reply.code(204).send();
    }
  );

  // ── Log sources ──────────────────────────────────────────────────────────
  app.get('/log-sources', async () => {
    const { rows } = await pool.query(`SELECT * FROM log_sources ORDER BY created_at DESC`);
    return { logSources: rows };
  });

  app.post<{ Body: { name: string; platform?: string; urlTemplate: string } }>(
    '/log-sources',
    async (request, reply) => {
      const { name, platform, urlTemplate } = request.body;
      if (!name || !urlTemplate) return reply.code(400).send({ error: 'name and urlTemplate are required' });
      const { rows } = await pool.query(
        `INSERT INTO log_sources (name, platform, url_template) VALUES ($1,$2,$3) RETURNING *`,
        [name, platform ?? null, urlTemplate]
      );
      return reply.code(201).send({ logSource: rows[0] });
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/log-sources/:id',
    async (request, reply) => {
      await pool.query(`DELETE FROM log_sources WHERE id = $1`, [request.params.id]);
      return reply.code(204).send();
    }
  );

  // ── s2: Scheduled tests ───────────────────────────────────────────────────
  app.get('/schedules', async () => {
    const { rows } = await pool.query(`SELECT * FROM schedules ORDER BY created_at DESC`);
    return { schedules: rows };
  });

  app.post<{ Body: { name: string; cron: string; type: string; target_url: string; description?: string; options: Record<string, unknown>; thresholds?: Record<string, unknown>; enabled?: boolean } }>(
    '/schedules',
    async (request, reply) => {
      const { name, cron, type, target_url, description, options, thresholds, enabled = true } = request.body;
      if (!name || !cron || !type || !target_url || !options) return reply.code(400).send({ error: 'name, cron, type, target_url, options are required' });
      const { rows } = await pool.query(
        `INSERT INTO schedules (name, cron, type, target_url, description, options, thresholds, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [name, cron, type, target_url, description ?? null, JSON.stringify(options), thresholds ? JSON.stringify(thresholds) : null, enabled]
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
      vals.push(id);
      const { rows } = await pool.query(`UPDATE schedules SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
      if (rows.length === 0) return reply.code(404).send({ error: 'Schedule not found' });
      await reloadSchedule(pool, id);
      return { schedule: rows[0] };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/schedules/:id',
    async (request, reply) => {
      removeSchedule(request.params.id);
      await pool.query(`DELETE FROM schedules WHERE id = $1`, [request.params.id]);
      return reply.code(204).send();
    }
  );

  app.post<{ Params: { id: string } }>(
    '/schedules/:id/run',
    async (request, reply) => {
      const { rows } = await pool.query(`SELECT * FROM schedules WHERE id = $1`, [request.params.id]);
      if (rows.length === 0) return reply.code(404).send({ error: 'Schedule not found' });
      const s = rows[0];
      const apiUrl = process.env.API_URL || 'http://api-service:3000';
      const res = await fetch(`${apiUrl}/tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: s.type, targetUrl: s.target_url, description: s.description ?? `Scheduled: ${s.name}`, options: s.options, thresholds: s.thresholds ?? undefined }),
      });
      const body = await res.json();
      await pool.query(`UPDATE schedules SET last_run_at = NOW() WHERE id = $1`, [s.id]);
      return reply.code(res.status).send(body);
    }
  );

  // ── s3: Test presets ─────────────────────────────────────────────────────
  app.get('/presets', async () => {
    const { rows } = await pool.query(`SELECT * FROM test_presets ORDER BY used_count DESC, created_at DESC`);
    return { presets: rows };
  });

  app.post<{ Body: { name: string; description?: string; type: string; target_url?: string; options: Record<string, unknown>; thresholds?: Record<string, unknown> } }>(
    '/presets',
    async (request, reply) => {
      const { name, description, type, target_url, options, thresholds } = request.body;
      if (!name || !type || !options) return reply.code(400).send({ error: 'name, type, options are required' });
      const { rows } = await pool.query(
        `INSERT INTO test_presets (name, description, type, target_url, options, thresholds)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [name, description ?? null, type, target_url ?? null, JSON.stringify(options), thresholds ? JSON.stringify(thresholds) : null]
      );
      return reply.code(201).send({ preset: rows[0] });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/presets/:id',
    async (request, reply) => {
      const { rows } = await pool.query(
        `UPDATE test_presets SET used_count = used_count + 1 WHERE id = $1 RETURNING *`,
        [request.params.id]
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Preset not found' });
      return { preset: rows[0] };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/presets/:id',
    async (request, reply) => {
      await pool.query(`DELETE FROM test_presets WHERE id = $1`, [request.params.id]);
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
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));

      // Header
      doc.fontSize(20).font('Helvetica-Bold').text('Load Test Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').fillColor('#666')
        .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown(1);

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
