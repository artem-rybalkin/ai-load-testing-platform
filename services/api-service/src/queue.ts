import amqplib from 'amqplib';

import { EnrichedTestRequest } from '@alt/shared';
import { log } from './logger';

export const QUEUES = {
  AI_REQUESTS: 'ai-requests',
  BACKEND: 'backend-tests',
  CLIENT:  'client-tests',
} as const;

// Fanout exchange — every worker replica gets every cancel message
const CANCEL_EXCHANGE = 'cancel-fanout';

let channel: amqplib.Channel | null = null;

export const isQueueConnected = (): boolean => channel !== null;

export const connectQueue = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');
  const maxRetries = 20;
  const delay = 10000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info({ attempt, maxRetries }, 'Connecting to RabbitMQ');
      const connection = await amqplib.connect(url);
      channel = await connection.createChannel();

      await channel.assertQueue(QUEUES.AI_REQUESTS,  { durable: true });
      await channel.assertQueue(QUEUES.BACKEND,      { durable: true });
      await channel.assertQueue(QUEUES.CLIENT,       { durable: true });
      await channel.assertExchange(CANCEL_EXCHANGE,  'fanout', { durable: true });

      log.info('Connected to RabbitMQ');
      return;
    } catch (err) {
      log.error({ attempt, err: (err as Error).message }, 'RabbitMQ connection failed');
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
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
