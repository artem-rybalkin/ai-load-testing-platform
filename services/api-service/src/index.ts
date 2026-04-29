import Fastify from 'fastify';

import { TestRequest, TestType } from '@alt/shared';

const app = Fastify({
  logger: true
});

app.get('/health', async (_request, _reply) => {
  return { status: 'ok', service: 'api-service', timestamp: new Date().toISOString() };
});

app.get('/', async (_request, _reply) => {
  return { message: 'AI Load Testing Platform API', version: '1.0.0' };
});

app.post<{ Body: Omit<TestRequest, 'id' | 'createdAt'> }>(
  '/tests',
  async (request, _reply) => {
    const { type, targetUrl, description, options } = request.body;

    const validTypes: TestType[] = ['backend', 'client-side'];
    if (!validTypes.includes(type)) {
      return _reply.code(400).send({ error: `Invalid test type. Use: ${validTypes.join(', ')}` });
    }

    const test: TestRequest = {
      id: crypto.randomUUID(),
      type,
      targetUrl,
      description,
      options,
      createdAt: new Date().toISOString()
    };

    // TODO: відправити в чергу (наступний крок)
    console.log('Test created:', test);

    return { success: true, test };
  }
);


const start = async (): Promise<void> => {
  try {
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    await app.listen({ port, host });
    console.log(`API Service running on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();