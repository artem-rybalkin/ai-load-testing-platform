import amqplib from 'amqplib';

import { EnrichedTestRequest, TestRequest } from '@alt/shared';

export const QUEUES = {
  AI_REQUESTS: 'ai-requests',
  BACKEND: 'backend-tests',
  CLIENT: 'client-tests'
} as const;

let channel: amqplib.Channel | null = null;

export const connectQueue = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL || 'amqp://alt_user:alt_password@localhost:5672';
  const maxRetries = 20;
  const delay = 10000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Connecting to RabbitMQ (attempt ${attempt}/${maxRetries})...`);
      const connection = await amqplib.connect(url);
      channel = await connection.createChannel();

      await channel.assertQueue(QUEUES.AI_REQUESTS, { durable: true });
      await channel.assertQueue(QUEUES.BACKEND, { durable: true });
      await channel.assertQueue(QUEUES.CLIENT, { durable: true });

      console.log('Connected to RabbitMQ');
      return;
    } catch (err) {
      console.error(`RabbitMQ connection failed (attempt ${attempt}):`, (err as Error).message);
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

export const publishTest = (test: EnrichedTestRequest, skipAI: boolean): void => {
  if (!channel) throw new Error('Queue not connected');

  const message = Buffer.from(JSON.stringify(test));
  if (skipAI) {
    const targetQueue = test.type === 'backend' ? QUEUES.BACKEND : QUEUES.CLIENT;
    channel.sendToQueue(targetQueue, message, { persistent: true });
    console.log(`Test ${test.id} routed directly to ${targetQueue} (script reused)`);
  } else {
    channel.sendToQueue(QUEUES.AI_REQUESTS, message, { persistent: true });
    console.log(`Test ${test.id} sent to AI for script generation`);
  }
};