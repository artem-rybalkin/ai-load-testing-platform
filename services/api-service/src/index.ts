import Fastify from 'fastify';
import cors from '@fastify/cors';

import { TestRequest, TestType, EnrichedTestRequest, BackendTestOptions, SLOThresholds } from '@alt/shared';
import { connectQueue, publishTest, publishCancel, isQueueConnected } from './queue';
import { findExistingScript, checkDbHealth } from './scripts';

const app = Fastify({ logger: true });

app.get('/health', async (_request, reply) => {
  const checks: Record<string, string> = {};
  let healthy = true;

  try { await checkDbHealth(); checks.database = 'ok'; }
  catch { checks.database = 'error'; healthy = false; }

  checks.queue = isQueueConnected() ? 'ok' : 'disconnected';
  if (!isQueueConnected()) healthy = false;

  return reply.code(healthy ? 200 : 503).send({
    status: healthy ? 'ok' : 'degraded',
    service: 'api-service',
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.post<{ Body: Omit<TestRequest, 'id' | 'createdAt'> }>(
  '/tests',
  async (request, reply) => {
    const { type, targetUrl, description, options, thresholds } = request.body;

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
      thresholds,
      createdAt: new Date().toISOString()
    };

    // Завжди створюємо pending запис одразу — щоб ActiveTests хедер показував тест
    await fetch(
      `${process.env.RESULTS_URL || 'http://results-service:3004'}/results/pending`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId: test.id, type: test.type, targetUrl: test.targetUrl })
      }
    );

    // Перевіряємо чи є збережений скрипт
    const backendOpts = type === 'backend' ? (options as BackendTestOptions) : undefined;
    const existingScript = await findExistingScript(targetUrl, type, backendOpts);

    if (existingScript) {
      request.log.info({ targetUrl, usedCount: existingScript.usedCount }, 'Reusing cached script');
      test.generatedScript = existingScript.script;
      test.scriptId = existingScript.id;
      test.reusedScript = true;
      publishTest(test, true);
      return { success: true, test, scriptReused: true, scriptUsedCount: existingScript.usedCount };
    }

    // Новий URL — генеруємо через AI
    publishTest(test, false);
    return { success: true, test, scriptReused: false };
  }
);

app.post<{ Params: { testId: string } }>(
  '/tests/:testId/cancel',
  async (request, reply) => {
    const { testId } = request.params;
    const resultsUrl = process.env.RESULTS_URL || 'http://results-service:3004';

    const res = await fetch(`${resultsUrl}/results/${testId}/cancel`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return reply.code(res.status).send(body);
    }

    publishCancel(testId);
    return { success: true, testId };
  }
);

const start = async (): Promise<void> => {
  try {

    await app.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
});

    await connectQueue();
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();