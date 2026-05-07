import amqplib from 'amqplib';
import Fastify from 'fastify';

import { TestRequest } from '@alt/shared';
import { generateScript } from './generator';

const CONSUME_QUEUE = 'ai-requests';
const BACKEND_QUEUE = 'backend-tests';
const CLIENT_QUEUE = 'client-tests';

const app = Fastify({ logger: true });

app.get('/health', async () => ({
  status: 'ok',
  service: 'ai-service',
  timestamp: new Date().toISOString()
}));

const startConsumer = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL || 'amqp://alt_user:alt_password@localhost:5672';
  const maxRetries = 10;
  const delay = 5000;

  let connection;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Connecting to RabbitMQ (attempt ${attempt}/${maxRetries})...`);
      connection = await amqplib.connect(url);
      break;
    } catch (err) {
      console.error(`Connection failed (attempt ${attempt}):`, (err as Error).message);
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const channel = await connection!.createChannel();

  await channel.assertQueue(CONSUME_QUEUE, { durable: true });
  await channel.assertQueue(BACKEND_QUEUE, { durable: true });
  await channel.assertQueue(CLIENT_QUEUE, { durable: true });

  channel.prefetch(1);
  console.log('AI-service listening on queue:', CONSUME_QUEUE);

  channel.consume(CONSUME_QUEUE, async (msg) => {
    if (!msg) return;

    const test: TestRequest = JSON.parse(msg.content.toString());
    console.log(`Generating script for test: ${test.id}`);

    try {
      const script = await generateScript(test);

      // Додаємо згенерований скрипт до тесту
      const enrichedTest = { ...test, generatedScript: script };

      // Роутимо в правильну чергу
      const targetQueue = test.type === 'backend' ? BACKEND_QUEUE : CLIENT_QUEUE;
      channel.sendToQueue(
        targetQueue,
        Buffer.from(JSON.stringify(enrichedTest)),
        { persistent: true }
      );

      console.log(`Script generated and routed to: ${targetQueue}`);
      channel.ack(msg);
    } catch (err) {
      console.error('Script generation failed:', err);
      channel.nack(msg, false, false);
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