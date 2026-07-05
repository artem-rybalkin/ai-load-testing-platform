import './tracing';
import amqplib from 'amqplib';
import Fastify from 'fastify';

import { EnrichedTestRequest, connectWithBackoff } from '@alt/shared';
import { log } from './logger';
import { processAiRequest } from './processor';

export const CONSUME_QUEUE = 'ai-requests';
export const BACKEND_QUEUE = 'backend-tests';
export const CLIENT_QUEUE  = 'client-tests';
export const DLQ           = `${CONSUME_QUEUE}.dlq`;
const WORKER_CONCURRENCY   = parseInt(process.env.WORKER_CONCURRENCY ?? '3');

let queueConnected = false;
let reconnecting = false;

export const app = Fastify({ logger: true });

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

export const startConsumer = async (): Promise<void> => {
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

  const resultsUrl = process.env.RESULTS_URL || 'http://results-service:3004';

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

    await processAiRequest(test, { channel, msg, resultsUrl });
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

if (!process.env.VITEST) {
  start();
}
