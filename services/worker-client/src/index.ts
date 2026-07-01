import './tracing';
import amqplib from 'amqplib';
import { Browser } from 'puppeteer';
import Fastify from 'fastify';
import * as os from 'os';

import { TestRequest, TestResult, connectWithBackoff, internalHeaders } from '@alt/shared';
import { log } from './logger';
import { handleRetry, MAX_RETRIES } from './retry';
import { runClientTest, avgNum, avgResourceBreakdown } from './runner';

// Re-export for backwards compatibility (metrics.test.ts imports from ../index)
export { avgNum, avgResourceBreakdown };

const QUEUE              = 'client-tests';
const CANCEL_EXCHANGE    = 'cancel-fanout';
let queueConnected = false;
let reconnecting = false;
let connection: amqplib.ChannelModel | null = null;
let channel: amqplib.Channel | null = null;

// Rolling CPU usage sampled every 5 seconds
let cpuPercent = 0;
let _lastCpu = process.cpuUsage();
let _lastCpuTime = Date.now();
setInterval(() => {
  const delta = process.cpuUsage(_lastCpu);
  const elapsed = (Date.now() - _lastCpuTime) * 1000;
  cpuPercent = elapsed > 0 ? Math.min(100, Math.round(((delta.user + delta.system) / elapsed) * 100)) : 0;
  _lastCpu = process.cpuUsage();
  _lastCpuTime = Date.now();
}, 5000);

const RESULTS_QUEUE      = 'test-results';
const DLQ                = `${QUEUE}.dlq`;
const MAX_TEST_DURATION_MS = parseInt(process.env.PUPPETEER_MAX_DURATION_MS ?? '300000'); // 5 min
const NAV_TIMEOUT_MS = parseInt(process.env.PUPPETEER_NAV_TIMEOUT_MS ?? '60000'); // 1 min
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '2');

const runningBrowsers  = new Map<string, Browser>();
const cancelledTests   = new Set<string>();

// ── Execution log helpers ─────────────────────────────────────────────────────

const RESULTS_URL = process.env.RESULTS_URL || 'http://results-service:3004';

const postLogLine = async (testId: string, level: string, line: string): Promise<void> => {
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/log-line`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ level, line }),
    });
  } catch { /* best-effort */ }
};

/** Reconnect with capped exponential backoff (1s -> 30s), retrying forever until RabbitMQ is back. */
const scheduleReconnect = (): void => {
  if (reconnecting) return;
  reconnecting = true;
  connectWithBackoff(start, {
    onRetry: (err, attempt, nextDelayMs) =>
      log.error({ attempt, err: err.message, nextDelayMs }, 'RabbitMQ reconnect failed — retrying'),
  }).then(() => {
    reconnecting = false;
  });
};

const start = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');

  connection = await connectWithBackoff(() => amqplib.connect(url), {
    onRetry: (err, attempt, nextDelayMs) =>
      log.error({ attempt, err: err.message, nextDelayMs }, 'RabbitMQ connection failed — retrying'),
  });
  const conn = connection;

  conn.on('error', (err) => {
    log.error({ err: (err as Error).message }, 'RabbitMQ connection error');
  });
  conn.on('close', () => {
    log.warn('RabbitMQ connection closed — reconnecting');
    queueConnected = false;
    scheduleReconnect();
  });

  channel = await conn.createChannel();
  const ch = channel;
  ch.on('error', (err) => {
    log.error({ err: (err as Error).message }, 'RabbitMQ channel error');
    queueConnected = false;
  });
  await ch.assertQueue(QUEUE,         { durable: true });
  await ch.assertQueue(DLQ,           { durable: true });
  await ch.assertQueue(RESULTS_QUEUE, { durable: true });

  // s1: exclusive cancel queue per replica bound to fanout exchange
  await ch.assertExchange(CANCEL_EXCHANGE, 'fanout', { durable: true });
  const { queue: cancelQueue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
  await ch.bindQueue(cancelQueue, CANCEL_EXCHANGE, '');

  queueConnected = true;
  ch.prefetch(WORKER_CONCURRENCY);
  log.info({ queue: QUEUE, concurrency: WORKER_CONCURRENCY }, 'Worker-client listening');

  // r2: cancel consumer — closes running Puppeteer browser by testId
  ch.consume(cancelQueue, async (msg) => {
    if (!msg) return;
    const { testId } = JSON.parse(msg.content.toString()) as { testId: string };
    const browser = runningBrowsers.get(testId);
    if (browser) {
      log.info({ testId }, 'Cancelling client test');
      cancelledTests.add(testId);
      await browser.close().catch(() => {});
    }
    ch.ack(msg);
  }, { noAck: false });

  ch.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const rawTest: TestRequest = JSON.parse(msg.content.toString());
    // Docker containers cannot reach the host via 'localhost' — rewrite to host.docker.internal.
    const test: TestRequest = {
      ...rawTest,
      targetUrl: rawTest.targetUrl.replace(/\blocalhost\b/g, 'host.docker.internal'),
    };
    log.info({ testId: test.id, targetUrl: test.targetUrl }, 'Received client test');

    try {
      fetch(`${RESULTS_URL}/results/${test.id}/running`, { method: 'POST', headers: internalHeaders() }).catch(() => {});

      const { metrics, executionLog } = await runClientTest(test, {
        maxDurationMs: MAX_TEST_DURATION_MS,
        navTimeoutMs:  NAV_TIMEOUT_MS,
        resultsUrl:    RESULTS_URL,
        runningBrowsers,
        postLogLine,
      });

      // r2: check if cancelled while running
      if (cancelledTests.has(test.id)) {
        cancelledTests.delete(test.id);
        log.info({ testId: test.id }, 'Client test cancelled during execution');
        ch.ack(msg);
        return;
      }

      const result: TestResult = {
        testId: test.id,
        targetUrl: test.targetUrl,
        status: 'completed',
        metrics,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      ch.sendToQueue(RESULTS_QUEUE, Buffer.from(JSON.stringify({ ...result, thresholds: test.thresholds, projectId: test.projectId, executionLog })), { persistent: true });
      log.info({ testId: test.id, metrics }, 'Client test completed');
      ch.ack(msg);
    } catch (err) {
      log.error({ testId: test.id, err: (err as Error).message }, 'Client test failed');
      const retryCount = Number(msg.properties.headers?.['x-retry-count'] ?? 0);
      if (retryCount >= MAX_RETRIES) {
        const partialLog = (err as { partialLog?: string }).partialLog;
        fetch(`${RESULTS_URL}/results/${test.id}/fail`, {
          method: 'POST',
          headers: internalHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ executionLog: partialLog ?? null }),
        }).catch(() => {});
      }
      handleRetry(ch, msg, QUEUE, DLQ, test.id);
    }
  });
};

const startHealthServer = async (): Promise<void> => {
  const app = Fastify({ logger: false });
  app.get('/health', async (_req, reply) => {
    const checks: Record<string, string> = {};
    checks.queue = queueConnected ? 'ok' : 'disconnected';

    const mem = process.memoryUsage();
    const memoryMb = Math.round(mem.rss / 1024 / 1024);
    const memoryPercent = Math.round(mem.rss / os.totalmem() * 100);
    const activeTests = runningBrowsers.size;
    const saturated = activeTests >= WORKER_CONCURRENCY && WORKER_CONCURRENCY > 0;
    if (saturated) checks.capacity = 'saturated';

    const status = !queueConnected ? 'degraded' : saturated ? 'saturated' : 'ok';
    return reply.code(queueConnected ? 200 : 503).send({
      status,
      service: 'worker-client',
      checks,
      metrics: { cpuPercent, memoryMb, memoryPercent, activeTests, maxTests: WORKER_CONCURRENCY },
      timestamp: new Date().toISOString(),
    });
  });
  const port = Number(process.env.PORT) || 3003;
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'Worker-client health server listening');
};

startHealthServer().catch(err => log.error({ err: (err as Error).message }, 'Health server failed'));
start().catch(err => log.error({ err: (err as Error).message }, 'Worker-client startup failed'));

async function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down gracefully');
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (_) { /* ignore close errors during shutdown */ }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
