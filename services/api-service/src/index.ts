import Fastify from 'fastify';

import { TestRequest, TestType } from '@alt/shared';
import { connectQueue, publishTest } from './queue';

const app = Fastify({ logger: true });

app.get('/health', async (_request, _reply) => {
  return {
    status: 'ok',
    service: 'api-service',
    timestamp: new Date().toISOString()
  };
});

app.post<{ Body: Omit<TestRequest, 'id' | 'createdAt'> }>(
  '/tests',
  async (request, reply) => {
    const { type, targetUrl, description, options } = request.body;

    const validTypes: TestType[] = ['backend', 'client-side'];
    if (!validTypes.includes(type)) {
      return reply.code(400).send({
        error: `Invalid test type. Use: ${validTypes.join(', ')}`
      });
    }

    const test: TestRequest = {
      id: crypto.randomUUID(),
      type,
      targetUrl,
      description,
      options,
      createdAt: new Date().toISOString()
    };

    publishTest(test);

    return { success: true, test };
  }
);

const start = async (): Promise<void> => {
  try {
    await connectQueue();
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();