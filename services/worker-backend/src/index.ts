import './tracing';
import amqplib from 'amqplib';
import { ChildProcess } from 'child_process';
import { Pool } from 'pg';
import * as os from 'os';
import Fastify from 'fastify';

import { trace } from '@opentelemetry/api';
import { EnrichedTestRequest, TestResult, connectWithBackoff, internalHeaders } from '@alt/shared';
import { log } from './logger';
import { runK6Test, handleRetry, GRACE_PERIOD_MS, LIVE_INTERVAL_MS } from './runner';

let queueConnected = false;
let connection: amqplib.ChannelModel | null = null;
let channel: amqplib.Channel | null = null;

// Rolling CPU usage sampled every 5 seconds
let cpuPercent = 0;
let _lastCpu = process.cpuUsage();
let _lastCpuTime = Date.now();
setInterval(() => {
  const delta = process.cpuUsage(_lastCpu);
  const elapsed = (Date.now() - _lastCpuTime) * 1000; // µs
  cpuPercent = elapsed > 0 ? Math.min(100, Math.round(((delta.user + delta.system) / elapsed) * 100)) : 0;
  _lastCpu = process.cpuUsage();
  _lastCpuTime = Date.now();
}, 5000);

const QUEUE            = 'backend-tests';
const CANCEL_EXCHANGE  = 'cancel-fanout';  // fanout — all replicas get every cancel
const RESULTS_QUEUE    = 'test-results';
const DLQ              = `${QUEUE}.dlq`;
const RESULTS_URL      = process.env.RESULTS_URL || 'http://results-service:3004';
const MAX_TEST_DURATION_MS = parseInt(process.env.K6_MAX_DURATION_MS ?? '600000'); // 10 min
const WORKER_CONCURRENCY   = parseInt(process.env.WORKER_CONCURRENCY ?? '1');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Track in-progress k6 processes for cancellation
const runningTests   = new Map<string, ChildProcess>();
const cancelledTests = new Set<string>();

const saveScript = async (
  targetUrl: string,
  script: string,
  scriptId?: string,
  description?: string,
  projectId?: string,
  workspaceId?: string,
): Promise<string> => {
  if (scriptId) {
    await pool.query(
      'UPDATE test_scripts SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
      [scriptId]
    );
    return scriptId;
  }
  const { rows } = await pool.query(
    `INSERT INTO test_scripts (target_url, test_type, script, description, project_id, workspace_id)
     VALUES ($1, 'backend', $2, $3, $4, $5)
     ON CONFLICT (target_url, test_type) DO UPDATE
     SET script = EXCLUDED.script, description = EXCLUDED.description, updated_at = NOW(),
         project_id = COALESCE(test_scripts.project_id, EXCLUDED.project_id),
         workspace_id = COALESCE(test_scripts.workspace_id, EXCLUDED.workspace_id)
     RETURNING id`,
    [targetUrl, script, description ?? null, projectId ?? null, workspaceId ?? null]
  );
  return rows[0].id;
};

// Status transitions go through results-service's REST endpoints rather than
// writing test_results directly: those endpoints both clear the stale
// status_message AND broadcast the test:status WebSocket event.
const notifyRunning = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/running`, { method: 'POST', headers: internalHeaders() }); }
  catch { /* best-effort */ }
};

const notifyFailed = async (testId: string, executionLog?: string): Promise<void> => {
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/fail`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ executionLog: executionLog ?? null }),
    });
  }
  catch { /* best-effort */ }
};

const notifyCancelled = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/cancel`, { method: 'POST', headers: internalHeaders() }); }
  catch { /* best-effort */ }
};

const postLogLine = async (testId: string, level: string, line: string): Promise<void> => {
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/log-line`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ level, line }),
    });
  } catch { /* best-effort */ }
};

const postLiveMetric = async (testId: string, point: import('@alt/shared').LiveMetricPoint): Promise<void> => {
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/live`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(point)
    });
  } catch { /* best-effort */ }
};

let reconnecting = false;

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
  const url        = process.env.RABBITMQ_URL;
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

  // s1: each replica gets its own exclusive cancel queue bound to the fanout exchange
  await ch.assertExchange(CANCEL_EXCHANGE, 'fanout', { durable: true });
  const { queue: cancelQueue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
  await ch.bindQueue(cancelQueue, CANCEL_EXCHANGE, '');

  queueConnected = true;
  ch.prefetch(WORKER_CONCURRENCY);
  log.info({ queue: QUEUE, concurrency: WORKER_CONCURRENCY }, 'Worker-backend listening');

  // r2: cancel consumer — kills running k6 processes by testId
  ch.consume(cancelQueue, async (msg) => {
    if (!msg) return;
    const { testId } = JSON.parse(msg.content.toString()) as { testId: string };
    const proc = runningTests.get(testId);
    if (proc) {
      log.info({ testId }, 'Cancelling k6 test');
      cancelledTests.add(testId);
      proc.kill('SIGTERM');
    }
    ch.ack(msg);
  }, { noAck: false });

  ch.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const test: EnrichedTestRequest = JSON.parse(msg.content.toString());
    const testLog = log.child({ testId: test.id, targetUrl: test.targetUrl });
    testLog.info('Received backend test');

    // Tag the active OTel span so traces are searchable by testId in Tempo
    const span = trace.getActiveSpan();
    if (span) { span.setAttribute('test.id', test.id); span.setAttribute('test.url', test.targetUrl); }

    // r2: skip if already cancelled
    const { rows: statusRows } = await pool.query(
      `SELECT status FROM test_results WHERE test_id = $1`, [test.id]
    );
    if (statusRows[0]?.status === 'cancelled') {
      testLog.info('Test was cancelled before execution, skipping');
      ch.ack(msg);
      return;
    }

    try {
      const { metrics, executionLog } = await runK6Test(
        test.id,
        test.generatedScript!,
        test.envVars,
        test.testData,
        test.csvData,
        {
          runningTests,
          notifyRunning,
          postLogLine,
          postLiveMetric,
          maxDurationMs:  MAX_TEST_DURATION_MS,
          gracePeriodMs:  GRACE_PERIOD_MS,
          liveIntervalMs: LIVE_INTERVAL_MS,
        },
      );

      // r2: check if the test was cancelled while running
      if (cancelledTests.has(test.id)) {
        cancelledTests.delete(test.id);
        await notifyCancelled(test.id);
        testLog.info('Test cancelled during execution');
        ch.ack(msg);
        return;
      }

      const scriptSaveKey = test.scriptCacheKey ?? test.targetUrl;
      const scriptId = await saveScript(scriptSaveKey, test.generatedScript!, test.scriptId, test.description, test.projectId, test.workspaceId);

      const result: TestResult = {
        testId: test.id,
        targetUrl: test.targetUrl,
        status: 'completed',
        metrics,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      };

      ch.sendToQueue(
        RESULTS_QUEUE,
        Buffer.from(JSON.stringify({ ...result, scriptId, reusedScript: test.reusedScript, thresholds: test.thresholds, projectId: test.projectId, executionLog })),
        { persistent: true }
      );

      testLog.info({ requestsTotal: metrics.requestsTotal, rps: metrics.rps, p95: metrics.p95ResponseTime, errorRate: (metrics.requestsFailed / (metrics.requestsTotal || 1) * 100).toFixed(2) }, 'k6 test completed');
      testLog.debug({ metrics }, 'k6 test full metrics');
      ch.ack(msg);
    } catch (err) {
      testLog.error({ err: (err as Error).message }, 'Test failed');
      const partialLog = (err as { partialLog?: string }).partialLog;
      await notifyFailed(test.id, partialLog);
      handleRetry(ch, msg, QUEUE, DLQ, test.id);
    }
  });
};

const startHealthServer = async (): Promise<void> => {
  const app = Fastify({ logger: false });
  app.get('/health', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;
    try { await pool.query('SELECT 1'); checks.database = 'ok'; }
    catch { checks.database = 'error'; healthy = false; }
    checks.queue = queueConnected ? 'ok' : 'disconnected';
    if (!queueConnected) healthy = false;

    const mem = process.memoryUsage();
    const memoryMb = Math.round(mem.rss / 1024 / 1024);
    const memoryPercent = Math.round(mem.rss / os.totalmem() * 100);
    const activeTests = runningTests.size;
    const saturated = activeTests >= WORKER_CONCURRENCY && WORKER_CONCURRENCY > 0;
    if (saturated) checks.capacity = 'saturated';

    const status = !healthy ? 'degraded' : saturated ? 'saturated' : 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status,
      service: 'worker-backend',
      checks,
      metrics: { cpuPercent, memoryMb, memoryPercent, activeTests, maxTests: WORKER_CONCURRENCY },
      timestamp: new Date().toISOString(),
    });
  });
  const port = Number(process.env.PORT) || 3002;
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'Worker-backend health server listening');
};

const startWithQueue = async (): Promise<void> => {
  await start();
};

startHealthServer().catch(err => log.error({ err: (err as Error).message }, 'Health server failed'));
startWithQueue().catch(err => log.error({ err: (err as Error).message }, 'Worker-backend startup failed'));

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
