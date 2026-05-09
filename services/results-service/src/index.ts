import Fastify from 'fastify';
import cors from '@fastify/cors';

import { initDb, pool } from './db';
import { startConsumer } from './consumer';

const app = Fastify({ logger: true });

app.get('/health', async () => ({
  status: 'ok',
  service: 'results-service',
  timestamp: new Date().toISOString()
}));

// Результати тестів
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
// Створити запис тесту зі статусом pending
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

// Отримати активні тести
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

// Збережені скрипти
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

// Видалити скрипт (щоб примусово перегенерувати)
app.delete<{ Params: { id: string } }>(
  '/scripts/:id',
  async (request, reply) => {
    const { id } = request.params;
    await pool.query('DELETE FROM test_scripts WHERE id = $1', [id]);
    return reply.code(204).send();
  }
);

const start = async (): Promise<void> => {
  try {
    await app.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
});
    await initDb();
    await startConsumer();
    const port = Number(process.env.PORT) || 3004;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();