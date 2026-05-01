import amqplib from 'amqplib';

import { TestRequest, TestResult, BackendMetrics } from '@alt/shared';

const QUEUE = 'backend-tests';

const simulateBackendTest = async (test: TestRequest): Promise<BackendMetrics> => {
  console.log(`Running backend test for: ${test.targetUrl}`);
  await new Promise(resolve => setTimeout(resolve, 3000));
  return {
    type: 'backend',
    requestsTotal: 1000,
    requestsFailed: 12,
    avgResponseTime: 245,
    p95ResponseTime: 890,
    p99ResponseTime: 1200,
    rps: 33.3
  };
};

const start = async (): Promise<void> => {
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
  await channel.assertQueue(QUEUE, { durable: true });
  channel.prefetch(1);

  console.log('Worker-backend listening on queue:', QUEUE);

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const test: TestRequest = JSON.parse(msg.content.toString());
    console.log(`Received test: ${test.id} — ${test.targetUrl}`);

    try {
      const metrics = await simulateBackendTest(test);

      const result: TestResult = {
        testId: test.id,
        status: 'completed',
        metrics,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      };

      console.log('Test completed:', JSON.stringify(result, null, 2));
      channel.ack(msg);
    } catch (err) {
      console.error('Test failed:', err);
      channel.nack(msg, false, false);
    }
  });
};

start().catch(console.error);