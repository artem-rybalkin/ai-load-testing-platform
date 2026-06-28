/**
 * Resource CRUD route plugin: webhooks, log-sources, schedules, presets.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import cronValidator from 'node-cron';
import { validateSsrfSafeUrl } from '@alt/shared';
import { checkScheduleQuota } from '../quotas';
import { reloadSchedule, removeSchedule } from '../scheduler';

export async function resourceRoutes(app: FastifyInstance, { pool, rPool }: { pool: Pool; rPool: Pool }): Promise<void> {

  // ── Webhook CRUD ─────────────────────────────────────────────────────────────

  app.post<{ Body: { url: string; events?: string[]; secret?: string; format?: string; workspaceId?: string } }>(
    '/webhooks',
    async (request, reply) => {
      const { url, events = ['failed', 'degraded'], secret, format = 'generic', workspaceId } = request.body;
      if (!url) return reply.code(400).send({ error: 'url is required' });
      const ssrfError = validateSsrfSafeUrl(url);
      if (ssrfError) return reply.code(400).send({ error: ssrfError });
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `INSERT INTO webhooks (url, events, secret, format, project_id, workspace_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [url, events, secret ?? null, format, projectId, workspaceId ?? null]
      );
      return reply.code(201).send({ webhook: rows[0] });
    }
  );

  app.get<{ Querystring: { workspaceId?: string } }>('/webhooks', async (request) => {
    const projectId = request.projectId ?? null;
    const workspaceId = request.query.workspaceId ?? null;
    const { rows } = await rPool.query(
      `SELECT id, url, events, format, created_at FROM webhooks
       WHERE ($1::uuid IS NULL OR project_id = $1::uuid)
         AND ($2::uuid IS NULL OR workspace_id = $2::uuid)
       ORDER BY created_at DESC`,
      [projectId, workspaceId]
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

  // ── Log sources ───────────────────────────────────────────────────────────────

  app.get('/log-sources', async (request) => {
    const projectId = request.projectId ?? null;
    // auth_header deliberately excluded — it can hold a raw bearer/API token and this
    // route is readable by any team member (viewer included), not just admins.
    const { rows } = await rPool.query(
      `SELECT id, name, platform, url_template, metrics_endpoint_template, project_id, created_at
       FROM log_sources WHERE ($1::uuid IS NULL OR project_id = $1::uuid) ORDER BY created_at DESC`,
      [projectId]
    );
    return { logSources: rows };
  });

  app.post<{ Body: { name: string; platform?: string; urlTemplate: string; metricsEndpointTemplate?: string; authHeader?: string } }>(
    '/log-sources',
    async (request, reply) => {
      const { name, platform, urlTemplate, metricsEndpointTemplate, authHeader } = request.body;
      if (!name || !urlTemplate) return reply.code(400).send({ error: 'name and urlTemplate are required' });
      const urlSsrfError = validateSsrfSafeUrl(urlTemplate);
      if (urlSsrfError) return reply.code(400).send({ error: `urlTemplate: ${urlSsrfError}` });
      if (metricsEndpointTemplate) {
        const metricsSsrfError = validateSsrfSafeUrl(metricsEndpointTemplate);
        if (metricsSsrfError) return reply.code(400).send({ error: `metricsEndpointTemplate: ${metricsSsrfError}` });
      }
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `INSERT INTO log_sources (name, platform, url_template, metrics_endpoint_template, auth_header, project_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [name, platform ?? null, urlTemplate, metricsEndpointTemplate ?? null, authHeader ?? null, projectId]
      );
      return reply.code(201).send({ logSource: rows[0] });
    }
  );

  app.put<{ Params: { id: string }; Body: Partial<{ name: string; platform: string | null; urlTemplate: string; metricsEndpointTemplate: string | null; authHeader: string | null }> }>(
    '/log-sources/:id',
    async (request, reply) => {
      const { id } = request.params;
      const updates = request.body;
      if (updates.urlTemplate) {
        const urlSsrfError = validateSsrfSafeUrl(updates.urlTemplate);
        if (urlSsrfError) return reply.code(400).send({ error: `urlTemplate: ${urlSsrfError}` });
      }
      if (updates.metricsEndpointTemplate) {
        const metricsSsrfError = validateSsrfSafeUrl(updates.metricsEndpointTemplate);
        if (metricsSsrfError) return reply.code(400).send({ error: `metricsEndpointTemplate: ${metricsSsrfError}` });
      }
      const sets: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      if (updates.name                    !== undefined) { sets.push(`name = $${i++}`);                      vals.push(updates.name); }
      if (updates.platform                !== undefined) { sets.push(`platform = $${i++}`);                  vals.push(updates.platform); }
      if (updates.urlTemplate             !== undefined) { sets.push(`url_template = $${i++}`);              vals.push(updates.urlTemplate); }
      if (updates.metricsEndpointTemplate !== undefined) { sets.push(`metrics_endpoint_template = $${i++}`); vals.push(updates.metricsEndpointTemplate); }
      if (updates.authHeader              !== undefined) { sets.push(`auth_header = $${i++}`);               vals.push(updates.authHeader); }
      if (sets.length === 0) return reply.code(400).send({ error: 'No fields to update' });
      const projectId = request.projectId ?? null;
      vals.push(id);
      vals.push(projectId);
      const { rows } = await pool.query(`UPDATE log_sources SET ${sets.join(', ')} WHERE id = $${i} AND ($${i + 1}::uuid IS NULL OR project_id = $${i + 1}::uuid) RETURNING *`, vals);
      if (rows.length === 0) return reply.code(404).send({ error: 'Log source not found' });
      return { logSource: rows[0] };
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

  // ── Scheduled tests ───────────────────────────────────────────────────────────

  app.get<{ Querystring: { workspaceId?: string } }>('/schedules', async (request) => {
    const projectId = request.projectId ?? null;
    const workspaceId = request.query.workspaceId ?? null;
    const { rows } = await rPool.query(
      `SELECT * FROM schedules WHERE ($1::uuid IS NULL OR project_id = $1::uuid)
         AND ($2::uuid IS NULL OR workspace_id = $2::uuid) ORDER BY created_at DESC`,
      [projectId, workspaceId]
    );
    return { schedules: rows };
  });

  app.post<{ Body: { name: string; cron: string; type: string; target_url: string; description?: string; options: Record<string, unknown>; thresholds?: Record<string, unknown>; enabled?: boolean; workspaceId?: string } }>(
    '/schedules',
    async (request, reply) => {
      const { name, cron, type, target_url, description, options, thresholds, enabled = true, workspaceId } = request.body;
      if (!name || !cron || !type || !target_url || !options) return reply.code(400).send({ error: 'name, cron, type, target_url, options are required' });
      if (!cronValidator.validate(cron)) return reply.code(400).send({ error: 'Invalid cron expression' });
      if (enabled) {
        const quotaError = await checkScheduleQuota(pool, request.projectId);
        if (quotaError) return reply.code(429).send({ error: quotaError });
      }
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `INSERT INTO schedules (name, cron, type, target_url, description, options, thresholds, enabled, project_id, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [name, cron, type, target_url, description ?? null, JSON.stringify(options), thresholds ? JSON.stringify(thresholds) : null, enabled, projectId, workspaceId ?? null]
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
      if (updates.name       !== undefined) { sets.push(`name = $${i++}`);       vals.push(updates.name); }
      if (updates.cron       !== undefined) { sets.push(`cron = $${i++}`);       vals.push(updates.cron); }
      if (updates.enabled    !== undefined) { sets.push(`enabled = $${i++}`);    vals.push(updates.enabled); }
      if (updates.options    !== undefined) { sets.push(`options = $${i++}`);    vals.push(JSON.stringify(updates.options)); }
      if (updates.thresholds !== undefined) { sets.push(`thresholds = $${i++}`); vals.push(JSON.stringify(updates.thresholds)); }
      if (sets.length === 0) return reply.code(400).send({ error: 'No fields to update' });

      if (updates.enabled === true) {
        const { rows: existingRows } = await pool.query<{ enabled: boolean }>(`SELECT enabled FROM schedules WHERE id = $1`, [id]);
        if (existingRows.length > 0 && !existingRows[0].enabled) {
          const quotaError = await checkScheduleQuota(pool, request.projectId);
          if (quotaError) return reply.code(429).send({ error: quotaError });
        }
      }

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
      const internalApiKeyForCall = process.env.INTERNAL_API_KEY || '';
      const res = await fetch(`${apiUrl}/tests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
          // Trusted internal channel — works even when no global API_KEY is
          // configured (the documented production setup: Team/RBAC on, no
          // separate global key for service-to-service calls).
          ...(internalApiKeyForCall ? { 'X-Internal-Key': internalApiKeyForCall } : {}),
        },
        body: JSON.stringify({
          type: s.type,
          targetUrl: s.target_url,
          description: s.description ?? `Scheduled: ${s.name}`,
          options: s.options,
          thresholds: s.thresholds ?? undefined,
          projectId: s.project_id ?? undefined,
        }),
      });
      const body = await res.json();
      // Only mark the schedule as having run when api-service actually accepted
      // the test — previously this updated unconditionally, so a rejected
      // (e.g. unauthenticated) trigger would still report success and update
      // last_run_at while creating zero tests.
      if (res.ok) {
        await pool.query(`UPDATE schedules SET last_run_at = NOW() WHERE id = $1`, [s.id]);
      }
      return reply.code(res.status).send(body);
    }
  );

  // ── Test presets ──────────────────────────────────────────────────────────────

  app.get<{ Querystring: { workspaceId?: string } }>('/presets', async (request) => {
    const projectId = request.projectId ?? null;
    const workspaceId = request.query.workspaceId ?? null;
    const { rows } = await rPool.query(
      `SELECT * FROM test_presets WHERE ($1::uuid IS NULL OR project_id = $1::uuid)
         AND ($2::uuid IS NULL OR workspace_id = $2::uuid) ORDER BY used_count DESC, created_at DESC`,
      [projectId, workspaceId]
    );
    return { presets: rows };
  });

  app.post<{ Body: { name: string; description?: string; type: string; target_url?: string; options: Record<string, unknown>; thresholds?: Record<string, unknown>; workspaceId?: string } }>(
    '/presets',
    async (request, reply) => {
      const { name, description, type, target_url, options, thresholds, workspaceId } = request.body;
      if (!name || !type || !options) return reply.code(400).send({ error: 'name, type, options are required' });
      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `INSERT INTO test_presets (name, description, type, target_url, options, thresholds, project_id, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [name, description ?? null, type, target_url ?? null, JSON.stringify(options), thresholds ? JSON.stringify(thresholds) : null, projectId, workspaceId ?? null]
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
}
