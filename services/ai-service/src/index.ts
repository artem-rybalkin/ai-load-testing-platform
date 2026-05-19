import amqplib from 'amqplib';
import Fastify from 'fastify';

import { EnrichedTestRequest } from '@alt/shared';
import { generateScript, compareDescriptions } from './generator';
import { log } from './logger';

const CONSUME_QUEUE      = 'ai-requests';
const BACKEND_QUEUE      = 'backend-tests';
const CLIENT_QUEUE       = 'client-tests';
const DLQ                = `${CONSUME_QUEUE}.dlq`;
const MAX_RETRIES        = 3;
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '3');

let queueConnected = false;

const app = Fastify({ logger: true });

app.get('/health', async (_request, reply) => {
  const healthy = queueConnected;
  return reply.code(healthy ? 200 : 503).send({
    status: healthy ? 'ok' : 'degraded',
    service: 'ai-service',
    checks: { queue: healthy ? 'ok' : 'disconnected' },
    timestamp: new Date().toISOString(),
  });
});

const startConsumer = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');
  const maxRetries = 20;
  const delay = 10000;

  let connection;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info({ attempt, maxRetries }, 'Connecting to RabbitMQ');
      connection = await amqplib.connect(url);
      queueConnected = true;
      break;
    } catch (err) {
      log.error({ attempt, err: (err as Error).message }, 'RabbitMQ connection failed');
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const channel = await connection!.createChannel();

  await channel.assertQueue(CONSUME_QUEUE, { durable: true });
  await channel.assertQueue(DLQ,           { durable: true });
  await channel.assertQueue(BACKEND_QUEUE, { durable: true });
  await channel.assertQueue(CLIENT_QUEUE,  { durable: true });

  channel.prefetch(WORKER_CONCURRENCY);
  log.info({ queue: CONSUME_QUEUE, concurrency: WORKER_CONCURRENCY }, 'AI-service listening');

  channel.consume(CONSUME_QUEUE, async (msg) => {
    if (!msg) return;

    let test: EnrichedTestRequest = JSON.parse(msg.content.toString());
    log.info({ testId: test.id, targetUrl: test.targetUrl }, 'Processing script request');

    try {
      const targetQueue = (test.type === 'backend' || test.type === 'flow') ? BACKEND_QUEUE : CLIENT_QUEUE;

      // Description comparison path: cached script exists and has a stored description
      if (test.cachedScript && test.description) {
        if (test.cachedScriptDescription == null) {
          log.info({ testId: test.id }, 'Cached script has no stored description — regenerating');
          // falls through to generateScript below; clear scriptId so worker overwrites the row
          test = { ...test, scriptId: undefined };
        } else {
          const verdict = await compareDescriptions(test.description, test.cachedScriptDescription);
          log.info({ testId: test.id, verdict }, 'Description comparison result');
          if (verdict === 'REUSE') {
            const reused: EnrichedTestRequest = { ...test, generatedScript: test.cachedScript, reusedScript: true };
            channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(reused)), { persistent: true });
            log.info({ testId: test.id, targetQueue }, 'Script reused after semantic comparison');
            channel.ack(msg);
            return;
          }
          // REGENERATE: clear scriptId so worker overwrites the row with the new script
          test = { ...test, scriptId: undefined };
          log.info({ testId: test.id }, 'Description mismatch — generating new script');
        }
      }

      const script = await generateScript(test);
      const enrichedTest: EnrichedTestRequest = { ...test, generatedScript: script };

      channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(enrichedTest)), { persistent: true });
      log.info({ testId: test.id, targetQueue }, 'Script generated and routed');
      channel.ack(msg);
    } catch (err) {
      log.error({ testId: test.id, err: (err as Error).message }, 'Script generation failed');
      const retryCount = ((msg.properties.headers?.['x-retry-count'] as number) ?? 0);
      if (retryCount < MAX_RETRIES) {
        log.warn({ testId: test.id, retryCount: retryCount + 1 }, 'Retrying AI generation');
        channel.publish('', CONSUME_QUEUE, msg.content, {
          persistent: true,
          headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 }
        });
      } else {
        log.error({ testId: test.id }, 'Max retries exceeded, routing to DLQ');
        channel.sendToQueue(DLQ, msg.content, { persistent: true });
      }
      channel.ack(msg);
    }
  });
};

const start = async (): Promise<void> => {
  try {
    await startConsumer();
    const port = Number(process.env.PORT) || 3001;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
