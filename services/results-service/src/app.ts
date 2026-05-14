import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';

export const buildApp = async (pool: Pool): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'results-service',
    timestamp: new Date().toISOString()
  }));

  app.get('/results', async (_request, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.*, s.script
         FROM test_results r
         LEFT JOIN test_scripts s ON r.script_id = s.id
         ORDER BY r.created_at DESC LIMIT 50`
      );
      return { results: rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch results' });
    }
  });

  app.post<{ Body: { testId: string; type: string; targetUrl: string } }>(
    '/results/pending',
    async (request, reply) => {
      try {
        const { testId, type, targetUrl } = request.body;
        await pool.query(
          `INSERT INTO test_results (test_id, type, target_url, status)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (test_id) DO NOTHING`,
          [testId, type, targetUrl]
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
        `SELECT r.*, s.script
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
    Body: { timestamp: string; vus: number; rps: number; avgResponseTime: number; errorRate: number };
  }>('/results/:testId/live', async (request, reply) => {
    const { testId } = request.params;
    const { timestamp, vus, rps, avgResponseTime, errorRate } = request.body;
    try {
      await pool.query(
        `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testId, timestamp, vus, rps, avgResponseTime, errorRate]
      );
      return { success: true };
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
          `SELECT timestamp, vus, rps, avg_response_time AS "avgResponseTime", error_rate AS "errorRate"
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

  return app;
};
