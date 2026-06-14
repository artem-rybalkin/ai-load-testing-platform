import amqplib from 'amqplib';

import { EnrichedTestRequest, connectWithBackoff } from '@alt/shared';
import { log } from './logger';

export const QUEUES = {
  AI_REQUESTS: 'ai-requests',
  BACKEND: 'backend-tests',
  CLIENT:  'client-tests',
} as const;

// Fanout exchange — every worker replica gets every cancel message
const CANCEL_EXCHANGE = 'cancel-fanout';

let channel: amqplib.Channel | null = null;
let reconnecting = false;

export const isQueueConnected = (): boolean => channel !== null;

const setupConnection = async (url: string): Promise<void> => {
  const connection = await amqplib.connect(url);

  connection.on('error', (err) => {
    log.error({ err: (err as Error).message }, 'RabbitMQ connection error');
  });
  connection.on('close', () => {
    log.warn('RabbitMQ connection closed — reconnecting');
    channel = null;
    scheduleReconnect(url);
  });

  channel = await connection.createChannel();
  channel.on('error', (err) => {
    log.error({ err: (err as Error).message }, 'RabbitMQ channel error');
    channel = null;
  });

  await channel.assertQueue(QUEUES.AI_REQUESTS,  { durable: true });
  await channel.assertQueue(QUEUES.BACKEND,      { durable: true });
  await channel.assertQueue(QUEUES.CLIENT,       { durable: true });
  await channel.assertExchange(CANCEL_EXCHANGE,  'fanout', { durable: true });
};

/** Reconnect with capped exponential backoff (1s -> 30s), retrying forever until RabbitMQ is back. */
const scheduleReconnect = (url: string): void => {
  if (reconnecting) return;
  reconnecting = true;
  connectWithBackoff(() => setupConnection(url), {
    onRetry: (err, attempt, nextDelayMs) =>
      log.error({ attempt, err: err.message, nextDelayMs }, 'RabbitMQ reconnect failed — retrying'),
  }).then(() => {
    reconnecting = false;
    log.info('Reconnected to RabbitMQ');
  });
};

export const connectQueue = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');

  await connectWithBackoff(() => setupConnection(url), {
    onRetry: (err, attempt, nextDelayMs) =>
      log.error({ attempt, err: err.message, nextDelayMs }, 'RabbitMQ connection failed — retrying'),
  });
  log.info('Connected to RabbitMQ');
};

export const getWorkerConsumerCount = async (testType: string): Promise<number> => {
  if (!channel) return 0;
  try {
    const queueName = (testType === 'backend' || testType === 'flow') ? QUEUES.BACKEND : QUEUES.CLIENT;
    const info = await channel.checkQueue(queueName);
    return info.consumerCount;
  } catch {
    return 0;
  }
};

export const publishCancel = (testId: string): void => {
  if (!channel) throw new Error('Queue not connected');
  // Publish to fanout exchange — all worker replicas receive this
  channel.publish(CANCEL_EXCHANGE, '', Buffer.from(JSON.stringify({ testId })));
  log.info({ testId }, 'Cancel signal published to fanout exchange');
};

export const publishTest = (test: EnrichedTestRequest, skipAI: boolean): void => {
  if (!channel) throw new Error('Queue not connected');

  const message = Buffer.from(JSON.stringify(test));
  if (skipAI) {
    const targetQueue = (test.type === 'backend' || test.type === 'flow') ? QUEUES.BACKEND : QUEUES.CLIENT;
    channel.sendToQueue(targetQueue, message, { persistent: true });
    log.info({ testId: test.id, queue: targetQueue }, 'Test routed directly to worker (script reused)');
  } else {
    channel.sendToQueue(QUEUES.AI_REQUESTS, message, { persistent: true });
    log.info({ testId: test.id }, 'Test sent to AI for script generation');
  }
};
