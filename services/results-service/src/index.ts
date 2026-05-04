import Fastify from 'fastify';

import { initDb, pool } from './db';
import { startConsumer } from './consumer';

const app = Fastify({ logger: true });

app.get('/health', async () => {
  return { status: 'ok', service: 'results-service', timestamp: new Date().toISOString() };
});

app.get('/results', async (_request, reply) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM test_results ORDER BY created_at DESC LIMIT 50'
    );
    return { results: rows };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to fetch results' });
  }
});

app.get<{ Params: { testId: string } }>(
  '/results/:testId',
  async (request, reply) => {
    const { testId } = request.params;
    const { rows } = await pool.query(
      'SELECT * FROM test_results WHERE test_id = $1',
      [testId]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Result not found' });
    }

    return { result: rows[0] };
  }
);

const start = async (): Promise<void> => {
  try {
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