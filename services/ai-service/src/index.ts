import './tracing';
import amqplib from 'amqplib';
import Fastify from 'fastify';

import { EnrichedTestRequest, connectWithBackoff } from '@alt/shared';
import { generateScript, compareDescriptions } from './generator';
import { log } from './logger';

const CONSUME_QUEUE      = 'ai-requests';
const BACKEND_QUEUE      = 'backend-tests';
const CLIENT_QUEUE       = 'client-tests';
const DLQ                = `${CONSUME_QUEUE}.dlq`;
const MAX_RETRIES        = 3;
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '3');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const internalHeaders = (extra?: Record<string, string>): Record<string, string> => ({
  ...(INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {}),
  ...extra,
});

let queueConnected = false;
let reconnecting = false;

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

/** Reconnect with capped exponential backoff (1s -> 30s), retrying forever until RabbitMQ is back. */
const scheduleReconnect = (): void => {
  if (reconnecting) return;
  reconnecting = true;
  connectWithBackoff(startConsumer, {
    onRetry: (err, attempt, nextDelayMs) =>
      log.error({ attempt, err: err.message, nextDelayMs }, 'RabbitMQ reconnect failed — retrying'),
  }).then(() => {
    reconnecting = false;
  });
};

const startConsumer = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');

  const connection = await connectWithBackoff(() => amqplib.connect(url), {
    onRetry: (err, attempt, nextDelayMs) =>
      log.error({ attempt, err: err.message, nextDelayMs }, 'RabbitMQ connection failed — retrying'),
  });

  connection.on('error', (err) => {
    log.error({ err: (err as Error).message }, 'RabbitMQ connection error');
  });
  connection.on('close', () => {
    log.warn('RabbitMQ connection closed — reconnecting');
    queueConnected = false;
    scheduleReconnect();
  });

  const channel = await connection.createChannel();
  channel.on('error', (err) => {
    log.error({ err: (err as Error).message }, 'RabbitMQ channel error');
    queueConnected = false;
  });

  await channel.assertQueue(CONSUME_QUEUE, { durable: true });
  await channel.assertQueue(DLQ,           { durable: true });
  await channel.assertQueue(BACKEND_QUEUE, { durable: true });
  await channel.assertQueue(CLIENT_QUEUE,  { durable: true });

  channel.prefetch(WORKER_CONCURRENCY);
  queueConnected = true;
  log.info({ queue: CONSUME_QUEUE, concurrency: WORKER_CONCURRENCY }, 'AI-service listening');

  channel.consume(CONSUME_QUEUE, async (msg) => {
    if (!msg) return;

    let test: EnrichedTestRequest;
    try {
      test = JSON.parse(msg.content.toString());
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Malformed message on ai-requests — routing to DLQ');
      channel.sendToQueue(DLQ, msg.content, { persistent: true });
      channel.ack(msg);
      return;
    }
    log.info({ testId: test.id, targetUrl: test.targetUrl }, 'Processing script request');

    const resultsUrl = process.env.RESULTS_URL || 'http://results-service:3004';
    const postMessage = (message: string): Promise<Response | void> =>
      fetch(`${resultsUrl}/results/${test.id}/message`, {
        method: 'POST',
        headers: internalHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message }),
      }).catch((err: Error) => log.debug({ testId: test.id, err: err.message }, 'postMessage delivery failed'));

    try {
      const targetQueue = (test.type === 'backend' || test.type === 'flow') ? BACKEND_QUEUE : CLIENT_QUEUE;

      // Description comparison path: cached script exists and has a stored description
      if (test.cachedScript && test.description) {
        if (test.cachedScriptDescription == null) {
          log.info({ testId: test.id }, 'Cached script has no stored description — regenerating');
          // falls through to generateScript below; clear scriptId so worker overwrites the row
          test = { ...test, scriptId: undefined };
        } else {
          // Skip Gemini comparison if descriptions are identical (saves quota)
          const same = test.description.trim().toLowerCase() === test.cachedScriptDescription.trim().toLowerCase();
          const verdict = same ? 'REUSE' : await compareDescriptions(test.description, test.cachedScriptDescription, test.projectId);
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

      await postMessage('Generating test script with AI…');
      const script = await generateScript(test);
      await postMessage('Script ready — starting test…');
      const enrichedTest: EnrichedTestRequest = { ...test, generatedScript: script };

      channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(enrichedTest)), { persistent: true });
      log.info({ testId: test.id, targetQueue }, 'Script generated and routed');
      channel.ack(msg);
    } catch (err) {
      log.error({ testId: test.id, err: (err as Error).message }, 'Script generation failed');
      const retryCount = ((msg.properties.headers?.['x-retry-count'] as number) ?? 0);
      if (retryCount < MAX_RETRIES) {
        const attemptsLeft = MAX_RETRIES - retryCount;
        await postMessage(`Gemini unavailable — retrying… (${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} left)`);
        log.warn({ testId: test.id, retryCount: retryCount + 1 }, 'Retrying AI generation');
        channel.publish('', CONSUME_QUEUE, msg.content, {
          persistent: true,
          headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 }
        });
      } else {
        await postMessage('Script generation failed after 3 attempts — test could not start');
        log.error({ testId: test.id }, 'Max retries exceeded, routing to DLQ');
        channel.sendToQueue(DLQ, msg.content, { persistent: true });
        fetch(`${resultsUrl}/results/${test.id}/fail`, { method: 'POST', headers: internalHeaders() }).catch(() => {});
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
