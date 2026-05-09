import Fastify from 'fastify';

import { TestRequest, TestType, EnrichedTestRequest } from '@alt/shared';
import { connectQueue, publishTest } from './queue';
import { findExistingScript } from './scripts';

const app = Fastify({ logger: true });

app.get('/health', async (_request, _reply) => ({
  status: 'ok',
  service: 'api-service',
  timestamp: new Date().toISOString()
}));

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

    const test: EnrichedTestRequest = {
      id: crypto.randomUUID(),
      type,
      targetUrl,
      description,
      options,
      createdAt: new Date().toISOString()
    };

    // Перевіряємо чи є збережений скрипт
    const existingScript = await findExistingScript(targetUrl, type);

    if (existingScript) {
      console.log(`Reusing existing script for ${targetUrl} (used ${existingScript.usedCount} times)`);
      test.generatedScript = existingScript.script;
      test.scriptId = existingScript.id;
      test.reusedScript = true;

      // Пропускаємо ai-service, йдемо прямо до worker
      publishTest(test, true);
      return {
        success: true,
        test,
        scriptReused: true,
        scriptUsedCount: existingScript.usedCount
      };
    }

    // Новий URL — генеруємо через AI
    publishTest(test, false);
    return { success: true, test, scriptReused: false };
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