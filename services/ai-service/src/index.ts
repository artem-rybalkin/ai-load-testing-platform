import './tracing';
import amqplib from 'amqplib';
import Fastify from 'fastify';

import { EnrichedTestRequest, connectWithBackoff, drainInFlight, EnrichedTestRequestSchema } from '@alt/shared';
import { shutdownTracing } from '@alt/tracing';
import { log } from './logger';
import { processAiRequest } from './processor';

export const CONSUME_QUEUE = 'ai-requests';
export const BACKEND_QUEUE = 'backend-tests';
export const CLIENT_QUEUE  = 'client-tests';
export const DLQ           = `${CONSUME_QUEUE}.dlq`;
const WORKER_CONCURRENCY   = parseInt(process.env.WORKER_CONCURRENCY ?? '3');

// generateScript/compareDescriptions' own retry loop can wait up to 60s+120s on
// 429s before giving up, plus actual provider call time — this must be long
// enough to outlast that so a SIGTERM doesn't cut off an in-flight generation
// mid-retry, which would leave its AMQP message unacked and get redelivered
// (potentially double-generating and double-dispatching the same test).
const DRAIN_TIMEOUT_MS = 200_000;

let queueConnected = false;
let reconnecting = false;
let activeConnection: amqplib.ChannelModel | null = null;
let activeChannel: amqplib.Channel | null = null;
let activeConsumerTag: string | null = null;
let inFlightMessages = 0;

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
  activeConnection = connection;
  activeChannel = channel;
  log.info({ queue: CONSUME_QUEUE, concurrency: WORKER_CONCURRENCY }, 'AI-service listening');

  const resultsUrl = process.env.RESULTS_URL || 'http://results-service:3004';

  const { consumerTag } = await channel.consume(CONSUME_QUEUE, async (msg) => {
    if (!msg) return;

    let test: EnrichedTestRequest;
    try {
      test = EnrichedTestRequestSchema.parse(JSON.parse(msg.content.toString()));
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Malformed message on ai-requests — routing to DLQ');
      channel.sendToQueue(DLQ, msg.content, { persistent: true });
      channel.ack(msg);
      return;
    }
    log.info({ testId: test.id, targetUrl: test.targetUrl }, 'Processing script request');

    inFlightMessages++;
    try {
      await processAiRequest(test, { channel, msg, resultsUrl });
    } finally {
      inFlightMessages--;
    }
  });
  activeConsumerTag = consumerTag;
};

async function shutdown(signal: string): Promise<void> {
  log.info({ signal, inFlight: inFlightMessages }, 'Shutting down — draining in-flight requests before exit');
  try {
    // Stop new deliveries — in-flight messages keep running to completion on this
    // same channel (cancel does not affect messages already delivered to us).
    if (activeChannel && activeConsumerTag) await activeChannel.cancel(activeConsumerTag);
  } catch (_) { /* best-effort — a KEDA scale-down still shouldn't hang forever on this */ }

  await drainInFlight(() => inFlightMessages, DRAIN_TIMEOUT_MS);
  if (inFlightMessages > 0) {
    log.warn({ remaining: inFlightMessages }, 'Shutdown drain deadline reached with requests still in flight — exiting anyway');
  }

  try {
    if (activeChannel) await activeChannel.close();
    if (activeConnection) await activeConnection.close();
  } catch (_) { /* ignore close errors during shutdown */ }

  try {
    await app.close();
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Error closing Fastify app');
  }

  await shutdownTracing();
  process.exit(0);
}

if (!process.env.VITEST) {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

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
