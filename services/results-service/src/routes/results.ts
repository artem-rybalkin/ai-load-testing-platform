/**
 * Result route plugin: internal callbacks, result CRUD, scripts,
 * live metrics, execution log, baseline management, compare/trend,
 * and PDF/CSV report generation.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import PDFDocument from 'pdfkit';
import type { SLOThresholds, BackendMetrics, ClientMetrics } from '@alt/shared';
import { broadcast } from '../ws';
import { recordAudit } from '../audit';
import { analyzeResult } from '../analyzer';
import { getAiCapability } from './helpers';
import { downsampleLivePoints } from '../liveMetricsDownsample';

export async function resultRoutes(app: FastifyInstance, { pool, rPool }: { pool: Pool; rPool: Pool }): Promise<void> {

  // ── POST /results/:testId/message (internal) ──────────────────────────────
  app.post<{ Params: { testId: string }; Body: { message: string } }>(
    '/results/:testId/message',
    async (request, reply) => {
      try {
        const { testId } = request.params;
        await pool.query(
          `UPDATE test_results SET status_message = $1
           WHERE test_id = $2 AND status NOT IN ('failed', 'completed', 'cancelled')`,
          [request.body.message, testId],
        );
        return { success: true };
      } catch {
        return reply.code(500).send({ error: 'Failed to update status message' });
      }
    },
  );

  // ── POST /results/:testId/fail (internal) ─────────────────────────────────
  app.post<{ Params: { testId: string }; Body: { executionLog?: string | null } }>(
    '/results/:testId/fail',
    async (request, reply) => {
      try {
        const { testId } = request.params;
        const executionLog = request.body?.executionLog ?? null;
        const { rowCount } = await pool.query(
          `UPDATE test_results SET status = 'failed', completed_at = NOW(), status_message = NULL,
           execution_log = COALESCE($2, execution_log)
           WHERE test_id = $1 AND status IN ('pending', 'running')`,
          [testId, executionLog],
        );
        if (rowCount) {
          broadcast({ type: 'test:status', testId, status: 'failed', perfStatus: null });
          broadcast({ type: 'tests:changed' });
        }
        return { success: true };
      } catch {
        return reply.code(500).send({ error: 'Failed to mark test as failed' });
      }
    },
  );

  // ── POST /results/:testId/running (internal) ──────────────────────────────
  app.post<{ Params: { testId: string } }>(
    '/results/:testId/running',
    async (request, reply) => {
      try {
        const { testId } = request.params;
        await pool.query(
          `UPDATE test_results SET status = 'running', started_at = NOW(), status_message = NULL WHERE test_id = $1`,
          [testId],
        );
        broadcast({ type: 'test:status', testId, status: 'running', perfStatus: null });
        broadcast({ type: 'tests:changed' });
        return { success: true };
      } catch {
        return reply.code(500).send({ error: 'Failed to mark test as running' });
      }
    },
  );

  // ── POST /results/pending (internal) ─────────────────────────────────────
  app.post<{ Body: { testId: string; type: string; targetUrl: string; durationSeconds?: number; steps?: unknown[]; testData?: unknown[]; projectId?: string; workspaceId?: string } }>(
    '/results/pending',
    async (request, reply) => {
      try {
        const { testId, type, targetUrl, durationSeconds, steps, testData, projectId, workspaceId } = request.body;
        await pool.query(
          `INSERT INTO test_results (test_id, type, target_url, status, duration_seconds, steps, test_data, project_id, workspace_id)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)
           ON CONFLICT (test_id) DO NOTHING`,
          [testId, type, targetUrl, durationSeconds ?? null, steps ? JSON.stringify(steps) : null, testData ? JSON.stringify(testData) : null, projectId ?? null, workspaceId ?? null],
        );
        return { success: true };
      } catch {
        return reply.code(500).send({ error: 'Failed to create pending result' });
      }
    },
  );

  // ── POST /results/:testId/cancel (internal) ───────────────────────────────
  app.post<{ Params: { testId: string }; Body: { projectId?: string | null } }>(
    '/results/:testId/cancel',
    async (request, reply) => {
      const { testId } = request.params;
      const projectId = request.body?.projectId ?? null;
      // Unlike the read-side ($N::uuid IS NULL OR project_id = $N::uuid) pattern —
      // where a null *caller* projectId means "auth disabled, show everything" —
      // a missing projectId here must NOT be treated as unrestricted access: this
      // route has no session of its own (matched as an internal callback), so a
      // caller with no proof of ownership must be refused whenever the target row
      // actually belongs to a team. A row with no owner (project_id IS NULL, e.g.
      // legacy/dev-mode data) can still be cancelled by anyone, same as before.
      const { rowCount } = await pool.query(
        `UPDATE test_results SET status = 'cancelled', status_message = NULL
         WHERE test_id = $1 AND status IN ('pending', 'running')
           AND (project_id IS NULL OR project_id = $2::uuid)`,
        [testId, projectId],
      );
      if (!rowCount) return reply.code(404).send({ error: 'Test not found or already finished' });
      broadcast({ type: 'test:status', testId, status: 'cancelled', perfStatus: null });
      broadcast({ type: 'tests:changed' });
      return { success: true, testId };
    },
  );

  // ── POST /results/:testId/log-line (internal) ─────────────────────────────
  // Body is a batch — workers buffer stdout/stderr lines client-side (createBatcher,
  // @alt/shared) and flush periodically instead of one HTTP request per line.
  app.post<{ Params: { testId: string }; Body: { lines: Array<{ level: string; line: string }> } }>(
    '/results/:testId/log-line',
    async (request, reply) => {
      const { testId } = request.params;
      const { lines } = request.body ?? {};
      if (!Array.isArray(lines) || lines.some(l => typeof l?.level !== 'string' || typeof l?.line !== 'string')) {
        return reply.code(400).send({ error: 'lines must be an array of { level, line }' });
      }
      reply.send({ success: true });
      for (const { level, line } of lines) {
        broadcast({ type: 'test:log', testId, level, line });
      }
      return reply;
    },
  );

  // ── GET /results ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { before?: string; limit?: string; workspaceId?: string } }>(
    '/results',
    async (request, reply) => {
      try {
        const rawLimit = parseInt(request.query.limit ?? '50');
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
        const before = request.query.before;
        const projectId = request.projectId ?? null;
        const workspaceId = request.query.workspaceId ?? null;

        // List views only ever render summary fields — excluding the large columns
        // (script, execution_log, analysis, steps, test_data) avoids shipping them
        // for every row in what's often a 50-200 row response.
        const LIST_COLUMNS = `
          r.id, r.test_id, r.type, r.target_url, r.status, r.perf_status, r.metrics,
          r.is_baseline, r.created_at, r.completed_at, r.started_at, r.duration_seconds,
          r.status_message, s.description AS script_description`;

        const { rows } = before
          ? await rPool.query(
              `SELECT ${LIST_COLUMNS}
               FROM test_results r
               LEFT JOIN test_scripts s ON r.script_id = s.id
               WHERE ($1::uuid IS NULL OR r.project_id = $1::uuid)
                 AND ($2::uuid IS NULL OR r.workspace_id = $2::uuid)
                 AND r.created_at < $3
               ORDER BY r.created_at DESC LIMIT $4`,
              [projectId, workspaceId, before, limit],
            )
          : await rPool.query(
              `SELECT ${LIST_COLUMNS}
               FROM test_results r
               LEFT JOIN test_scripts s ON r.script_id = s.id
               WHERE ($1::uuid IS NULL OR r.project_id = $1::uuid)
                 AND ($2::uuid IS NULL OR r.workspace_id = $2::uuid)
               ORDER BY r.created_at DESC LIMIT $3`,
              [projectId, workspaceId, limit],
            );
        return { results: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].created_at : null };
      } catch {
        return reply.code(500).send({ error: 'Failed to fetch results' });
      }
    },
  );

  // ── GET /results/active ───────────────────────────────────────────────────
  app.get('/results/active', async (request, reply) => {
    try {
      const projectId = request.projectId ?? null;
      const { rows } = await rPool.query(
        `SELECT test_id, type, target_url, status, created_at
         FROM test_results
         WHERE status IN ('pending', 'running')
           AND ($1::uuid IS NULL OR project_id = $1::uuid)
         ORDER BY created_at DESC`,
        [projectId],
      );
      return { active: rows };
    } catch {
      return reply.code(500).send({ error: 'Failed to fetch active tests' });
    }
  });

  // ── GET /results/compare ──────────────────────────────────────────────────
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
        [[a, b], projectId],
      );
      if (rows.length < 2) return reply.code(404).send({ error: 'One or both results not found' });
      const [resultA, resultB] = rows[0].test_id === a ? [rows[0], rows[1]] : [rows[1], rows[0]];
      return { resultA, resultB };
    },
  );

  // ── GET /results/trend ────────────────────────────────────────────────────
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
        [url, n, projectId],
      );
      return { url, trend: rows.reverse() };
    },
  );

  // ── GET /results/:testId ──────────────────────────────────────────────────
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
        [testId, projectId],
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Result not found' });
      }
      return { result: rows[0] };
    },
  );

  // ── GET /scripts ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { workspaceId?: string } }>('/scripts', async (request, reply) => {
    try {
      const projectId = request.projectId ?? null;
      const workspaceId = request.query.workspaceId ?? null;
      const { rows } = await rPool.query(
        `SELECT id, target_url, test_type, used_count, created_at, updated_at
         FROM test_scripts
         WHERE ($1::uuid IS NULL OR project_id = $1::uuid)
           AND ($2::uuid IS NULL OR workspace_id = $2::uuid)
         ORDER BY used_count DESC`,
        [projectId, workspaceId],
      );
      return { scripts: rows };
    } catch {
      return reply.code(500).send({ error: 'Failed to fetch scripts' });
    }
  });

  // ── GET /scripts/:id ──────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/scripts/:id',
    async (request, reply) => {
      const { id } = request.params;
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        'SELECT * FROM test_scripts WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)',
        [id, projectId],
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Script not found' });
      }
      return { script: rows[0] };
    },
  );

  // ── DELETE /scripts/:id ───────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/scripts/:id',
    async (request, reply) => {
      const { id } = request.params;
      const projectId = request.projectId ?? null;
      try {
        await pool.query(
          'DELETE FROM test_scripts WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)',
          [id, projectId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23503') {
          return reply.code(409).send({ error: 'Cannot delete: this script is still referenced elsewhere' });
        }
        throw err;
      }
      await recordAudit(pool, { teamId: projectId, userId: request.user?.id, action: 'delete', resourceType: 'script', resourceId: id });
      return reply.code(204).send();
    },
  );

  // ── POST /results/:testId/live (internal) ─────────────────────────────────
  app.post<{
    Params: { testId: string };
    Body: { timestamp: string; vus: number; rps: number; avgResponseTime: number; errorRate: number; clientErrorRate?: number; serverErrorRate?: number; stepMetrics?: Array<{ name: string; avgResponseTime: number; rps: number; errorRate: number }> };
  }>('/results/:testId/live', async (request, reply) => {
    const { testId } = request.params;
    const { timestamp, vus, rps, avgResponseTime, errorRate, clientErrorRate, serverErrorRate, stepMetrics } = request.body;
    try {
      await pool.query(
        `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate, client_error_rate, server_error_rate, step_metrics)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [testId, timestamp, vus, rps, avgResponseTime, errorRate, clientErrorRate ?? 0, serverErrorRate ?? 0, stepMetrics ? JSON.stringify(stepMetrics) : null],
      );
      reply.send({ success: true });
      setImmediate(() => broadcast({ type: 'test:live', testId, point: { timestamp, vus, rps, avgResponseTime, errorRate, clientErrorRate: clientErrorRate ?? 0, serverErrorRate: serverErrorRate ?? 0, stepMetrics } }));
      return reply;
    } catch {
      return reply.code(500).send({ error: 'Failed to save live metric' });
    }
  });

  // ── GET /results/:testId/live ─────────────────────────────────────────────
  app.get<{ Params: { testId: string } }>(
    '/results/:testId/live',
    async (request, reply) => {
      const { testId } = request.params;
      const projectId = request.projectId ?? null;
      try {
        const { rows } = await rPool.query(
          `SELECT lm.timestamp, lm.vus, lm.rps, lm.avg_response_time AS "avgResponseTime", lm.error_rate AS "errorRate",
                  lm.client_error_rate AS "clientErrorRate", lm.server_error_rate AS "serverErrorRate", lm.step_metrics AS "stepMetrics"
           FROM live_metrics lm
           LEFT JOIN test_results tr ON tr.test_id = lm.test_id
           WHERE lm.test_id = $1 AND ($2::uuid IS NULL OR tr.project_id = $2::uuid)
           ORDER BY lm.timestamp ASC`,
          [testId, projectId],
        );
        return { points: downsampleLivePoints(rows) };
      } catch {
        return reply.code(500).send({ error: 'Failed to fetch live metrics' });
      }
    },
  );

  // ── GET /results/:testId/log ──────────────────────────────────────────────
  app.get<{ Params: { testId: string } }>(
    '/results/:testId/log',
    async (request, reply) => {
      const { testId } = request.params;
      const projectId = request.projectId ?? null;
      try {
        const { rows } = await rPool.query(
          `SELECT tr.execution_log AS "executionLog"
           FROM test_results tr
           WHERE tr.test_id = $1 AND ($2::uuid IS NULL OR tr.project_id = $2::uuid)`,
          [testId, projectId],
        );
        if (rows.length === 0) return reply.code(404).send({ error: 'Not found' });
        return { log: rows[0].executionLog ?? null };
      } catch {
        return reply.code(500).send({ error: 'Failed to fetch execution log' });
      }
    },
  );

  // ── POST /results/:testId/baseline ────────────────────────────────────────
  app.post<{ Params: { testId: string } }>(
    '/results/:testId/baseline',
    async (request, reply) => {
      const { testId } = request.params;
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `SELECT target_url, type FROM test_results
         WHERE test_id = $1 AND status = 'completed' AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
        [testId, projectId],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Completed result not found' });
      const { target_url, type } = rows[0];
      await pool.query(
        `UPDATE test_results SET is_baseline = FALSE
         WHERE target_url = $1 AND type = $2 AND ($3::uuid IS NULL OR project_id = $3::uuid)`,
        [target_url, type, projectId],
      );
      await pool.query(
        `UPDATE test_results SET is_baseline = TRUE WHERE test_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
        [testId, projectId],
      );
      return { success: true, testId };
    },
  );

  // ── DELETE /results/:testId/baseline ──────────────────────────────────────
  app.delete<{ Params: { testId: string } }>(
    '/results/:testId/baseline',
    async (request, reply) => {
      const projectId = request.projectId ?? null;
      await pool.query(
        `UPDATE test_results SET is_baseline = FALSE WHERE test_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
        [request.params.testId, projectId],
      );
      return reply.code(204).send();
    },
  );

  // ── GET /results/:testId/report.pdf ──────────────────────────────────────
  app.get<{ Params: { testId: string } }>(
    '/results/:testId/report.pdf',
    async (request, reply) => {
      const { testId } = request.params;
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `SELECT r.*, s.script FROM test_results r LEFT JOIN test_scripts s ON r.script_id = s.id
         WHERE r.test_id = $1 AND ($2::uuid IS NULL OR r.project_id = $2::uuid)`,
        [testId, projectId],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Result not found' });

      const result = rows[0];

      // AI-8: Executive summary
      let execSummary = '';
      if (result.metrics && result.perf_status) {
        const ai = await getAiCapability(pool);
        if (ai.configured) {
          try {
            const m = result.metrics;
            const summaryCtx = {
              url: result.target_url, type: result.type, perfStatus: result.perf_status,
              p95: m.p95ResponseTime, avg: m.avgResponseTime, rps: m.rps,
              errorRate: m.requestsTotal > 0 ? ((m.requestsFailed / m.requestsTotal) * 100).toFixed(1) : '0',
              analysis: result.analysis?.summary,
            };
            execSummary = (await ai.generateText(
              `Write a 3-sentence executive summary of this load test result for a non-technical manager. Be clear, factual, and end with a recommendation.
Data: ${JSON.stringify(summaryCtx)}
Return only the summary text, no JSON, no markdown.`,
            )).trim();
          } catch { /* non-fatal */ }
        }
      }

      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));

      doc.fontSize(20).font('Helvetica-Bold').text('Load Test Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').fillColor('#666')
        .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown(1);

      if (execSummary) {
        doc.fontSize(11).font('Helvetica-Oblique').fillColor('#333')
          .text(execSummary, { align: 'left' });
        doc.moveDown(1);
      }

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
      await recordAudit(pool, { teamId: projectId, userId: request.user?.id, action: 'export_pdf', resourceType: 'test_result', resourceId: testId });
      const pdf = Buffer.concat(chunks);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="report-${testId.slice(0, 8)}.pdf"`)
        .send(pdf);
    },
  );

  // ── GET /results/:testId/report.csv ──────────────────────────────────────
  app.get<{ Params: { testId: string } }>(
    '/results/:testId/report.csv',
    async (request, reply) => {
      const { testId } = request.params;
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `SELECT * FROM test_results WHERE test_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
        [testId, projectId],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Result not found' });

      const result = rows[0];
      const csvEscape = (v: unknown): string => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines: string[] = ['metric,value'];
      const add = (k: string, v: unknown): number => lines.push(`${csvEscape(k)},${csvEscape(v)}`);

      add('testId', result.test_id);
      add('url', result.target_url);
      add('type', result.type);
      add('status', result.status);
      add('perfStatus', result.perf_status ?? '');
      add('startedAt', result.started_at ? new Date(result.started_at).toISOString() : '');
      add('completedAt', result.completed_at ? new Date(result.completed_at).toISOString() : '');

      const m = result.metrics;
      if (m?.type === 'backend') {
        add('requestsTotal', m.requestsTotal);
        add('requestsFailed', m.requestsFailed);
        add('rps', m.rps);
        add('avgResponseTime', m.avgResponseTime);
        add('p50ResponseTime', m.p50ResponseTime);
        add('p95ResponseTime', m.p95ResponseTime);
        add('p99ResponseTime', m.p99ResponseTime);
      } else if (m?.type === 'client') {
        add('lcp', m.lcp);
        add('fcp', m.fcp);
        add('ttfb', m.ttfb);
        add('fid', m.fid);
        add('cls', m.cls);
        if (m.inp != null) add('inp', m.inp);
        if (m.tbt != null) add('tbt', m.tbt);
        if (m.tti != null) add('tti', m.tti);
      }

      if (m?.stepMetrics?.length) {
        lines.push('');
        lines.push('step,avgResponseTime,p95ResponseTime,requestsTotal,requestsFailed');
        for (const s of m.stepMetrics) {
          lines.push([s.name, s.avgResponseTime, s.p95ResponseTime, s.requestsTotal, s.requestsFailed].map(csvEscape).join(','));
        }
      }

      const csv = lines.join('\n') + '\n';
      await recordAudit(pool, { teamId: projectId, userId: request.user?.id, action: 'export_csv', resourceType: 'test_result', resourceId: testId });
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', `attachment; filename="report-${testId.slice(0, 8)}.csv"`)
        .send(csv);
    },
  );

  // ── GET /results/suggest-settings (preview, no AI) ───────────────────────
  // NOTE: GET /results/suggest-settings and GET /results/suggest-thresholds
  // and GET /results/preview-thresholds are in routes/ai.ts (they are AI-assist
  // endpoints even though they start with /results/).

  // ── (analyzeResult imported for preview-thresholds in ai.ts) ─────────────
  // exported from this module for convenience
  void analyzeResult; // satisfies linter — actual usage is in ai.ts
}
