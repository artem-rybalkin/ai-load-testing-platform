import './tracing';
import amqplib from 'amqplib';
import { ChildProcess } from 'child_process';
import { Pool } from 'pg';
import * as os from 'os';
import Fastify from 'fastify';

// @opentelemetry/api is a hoisted root dependency shared by all tracing-instrumented
// services — the rule only checks this service's own nearest package.json.
// eslint-disable-next-line import/no-extraneous-dependencies
import { trace } from '@opentelemetry/api';
import { shutdownTracing } from '@alt/tracing';
import { EnrichedTestRequest, TestResult, connectWithBackoff, drainInFlight, internalHeaders, LiveMetricWindowSec, DEFAULT_LIVE_METRIC_WINDOW_SEC, EnrichedTestRequestSchema, CancelMessageSchema } from '@alt/shared';
import { log } from './logger';
import { runK6Test, handleRetry, GRACE_PERIOD_MS } from './runner';

let queueConnected = false;
let connection: amqplib.ChannelModel | null = null;
// ConfirmChannel (not plain Channel) so publishing a test result can await
// waitForConfirms() — without it, a broker crash between sendToQueue() returning
// and the message actually being persisted silently drops the completed test's
// result with no way to know it happened.
let channel: amqplib.ConfirmChannel | null = null;
let queueConsumerTag: string | null = null;
// Counts a message as "in flight" for its full handler lifetime — including the
// post-k6-exit bookkeeping (DB write, result-queue send, ack) — not just while
// the k6 child process itself is alive, so shutdown() can't close the channel
// out from under an ack/send that's still in progress.
let inFlightMessages = 0;

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

export const saveScript = async (
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
  const { rows } = await pool.query<{ id: string }>(
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
export const notifyRunning = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/running`, { method: 'POST', headers: internalHeaders() }); }
  catch { /* best-effort */ }
};

export const notifyFailed = async (testId: string, executionLog?: string): Promise<void> => {
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/fail`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ executionLog: executionLog ?? null }),
    });
  }
  catch { /* best-effort */ }
};

export const notifyCancelled = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/cancel`, { method: 'POST', headers: internalHeaders() }); }
  catch { /* best-effort */ }
};

const postLogLines = async (testId: string, lines: Array<{ level: string; line: string }>): Promise<void> => {
  if (lines.length === 0) return;
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/log-line`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ lines }),
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

const LIVE_METRIC_WINDOW_CACHE_MS = 30000;
let liveMetricWindowCache: { windowSec: LiveMetricWindowSec; cachedAt: number } | null = null;

/** Fetches the admin-configured live-metrics aggregation window from results-service,
 *  cached for 30s. Read once per test at dequeue time, so a setting change only
 *  affects tests that start executing after the change — never a test already running. */
const getLiveMetricWindowSec = async (): Promise<LiveMetricWindowSec> => {
  if (liveMetricWindowCache && Date.now() - liveMetricWindowCache.cachedAt < LIVE_METRIC_WINDOW_CACHE_MS) {
    return liveMetricWindowCache.windowSec;
  }
  try {
    const res = await fetch(`${RESULTS_URL}/system/live-metric-window`, {
      headers: internalHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as { windowSec: LiveMetricWindowSec };
      liveMetricWindowCache = { windowSec: data.windowSec, cachedAt: Date.now() };
      return data.windowSec;
    }
  } catch { /* results-service unreachable — keep using cached/default setting */ }
  return liveMetricWindowCache?.windowSec ?? DEFAULT_LIVE_METRIC_WINDOW_SEC;
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
  }).catch((err: unknown) => {
    reconnecting = false;
    log.error({ err: (err as Error).message }, 'RabbitMQ reconnect loop exited unexpectedly');
  });
};

export const start = async (): Promise<void> => {
  const url        = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');

  connection = await connectWithBackoff(() => amqplib.connect(url), {
    onRetry: (err, attempt, nextDelayMs) =>
      log.error({ attempt, err: err.message, nextDelayMs }, 'RabbitMQ connection failed — retrying'),
  });
  const conn = connection;

  conn.on('error', (err) => {
    log.error({ err: err.message }, 'RabbitMQ connection error');
  });
  conn.on('close', () => {
    log.warn('RabbitMQ connection closed — reconnecting');
    queueConnected = false;
    scheduleReconnect();
  });

  channel = await conn.createConfirmChannel();
  const ch = channel;
  ch.on('error', (err) => {
    log.error({ err: err.message }, 'RabbitMQ channel error');
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
  await ch.prefetch(WORKER_CONCURRENCY);
  log.info({ queue: QUEUE, concurrency: WORKER_CONCURRENCY }, 'Worker-backend listening');

  // r2: cancel consumer — kills running k6 processes by testId
  // async callback intentional (even though nothing inside is awaited) — the whole
  // body is wrapped in its own try/catch (never actually rejects) and tests capture
  // this handler directly via channel.consume.mock.calls[0][1] and await/`.resolves`
  // it to synchronize with the real work, which requires it to return a real Promise.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/require-await
  await ch.consume(cancelQueue, async (msg) => {
    if (!msg) return;
    let testId: string;
    try {
      ({ testId } = CancelMessageSchema.parse(JSON.parse(msg.content.toString())));
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Malformed message on cancel-fanout — ignoring');
      ch.ack(msg);
      return;
    }
    const proc = runningTests.get(testId);
    if (proc) {
      log.info({ testId }, 'Cancelling k6 test');
      cancelledTests.add(testId);
      proc.kill('SIGTERM');
      // Escalate to SIGKILL after the grace period if the process is still
      // alive (mirrors the max-duration watchdog in runner.ts:195-199).
      // The check against runningTests is self-cleaning: runner's close handler
      // deletes the entry, so the timer is a no-op if the process already exited.
      setTimeout(() => {
        if (runningTests.has(testId)) {
          log.warn({ testId }, 'k6 process did not exit after cancel SIGTERM — escalating to SIGKILL');
          runningTests.get(testId)!.kill('SIGKILL');
        }
      }, GRACE_PERIOD_MS);
    }
    ch.ack(msg);
  }, { noAck: false });

  const handleTestMessage = async (msg: amqplib.ConsumeMessage | null): Promise<void> => {
    if (!msg) return;
    inFlightMessages++;
    try {
      const test: EnrichedTestRequest = EnrichedTestRequestSchema.parse(JSON.parse(msg.content.toString()));
      const testLog = log.child({ testId: test.id, targetUrl: test.targetUrl });
      testLog.info('Received backend test');

      // Tag the active OTel span so traces are searchable by testId in Tempo
      const span = trace.getActiveSpan();
      if (span) { span.setAttribute('test.id', test.id); span.setAttribute('test.url', test.targetUrl); }

      // r2: skip if already cancelled
      const { rows: statusRows } = await pool.query<{ status: string }>(
        `SELECT status FROM test_results WHERE test_id = $1`, [test.id]
      );
      if (statusRows[0]?.status === 'cancelled') {
        testLog.info('Test was cancelled before execution, skipping');
        ch.ack(msg);
        return;
      }

      try {
        // Docker containers cannot reach the host via 'localhost' — rewrite to host.docker.internal
        // so k6 can actually connect when the user tests a local service.
        const script = test.generatedScript!.replace(/\blocalhost\b/g, 'host.docker.internal');

        // Read once per test at dequeue time — a setting change only affects tests that
        // start executing after the change, never one already running.
        const liveWindowSec = await getLiveMetricWindowSec();

        const { metrics, executionLog } = await runK6Test(
          test.id,
          script,
          test.envVars,
          test.testData,
          test.csvData,
          {
            runningTests,
            notifyRunning,
            postLogLines,
            postLiveMetric,
            maxDurationMs:  MAX_TEST_DURATION_MS,
            gracePeriodMs:  GRACE_PERIOD_MS,
            liveIntervalMs: liveWindowSec * 1_000,
          },
        );

        const wasStopped = cancelledTests.has(test.id);
        if (wasStopped) cancelledTests.delete(test.id);

        const scriptSaveKey = test.scriptCacheKey ?? test.targetUrl;

        // When stopped with partial data, save the collected metrics as a completed
        // result so the user can inspect what ran before they clicked Stop.
        if (wasStopped && metrics.requestsTotal === 0) {
          await notifyCancelled(test.id);
          testLog.info('Test stopped with no metrics — marked cancelled');
          ch.ack(msg);
          return;
        }

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
        // Wait for the broker to actually persist the message before acking the
        // source message below — otherwise a broker crash in this window loses
        // the test's result permanently (the run completed but nothing recorded it).
        await ch.waitForConfirms();

        if (wasStopped) {
          testLog.info({ requestsTotal: metrics.requestsTotal }, 'Test stopped — partial metrics saved');
        } else {
          testLog.info({ requestsTotal: metrics.requestsTotal, rps: metrics.rps, p95: metrics.p95ResponseTime, errorRate: (metrics.requestsFailed / (metrics.requestsTotal || 1) * 100).toFixed(2) }, 'k6 test completed');
        }
        testLog.debug({ metrics }, 'k6 test full metrics');
        ch.ack(msg);
      } catch (err) {
        // If the test was stopped (cancelled) and k6 exited before collecting any
        // requests, treat it as a clean cancel — don't retry and don't fail the test.
        if (cancelledTests.has(test.id)) {
          cancelledTests.delete(test.id);
          await notifyCancelled(test.id);
          testLog.info('Test stopped before metrics were collected — marked cancelled');
          ch.ack(msg);
          return;
        }
        testLog.error({ err: (err as Error).message }, 'Test failed');
        const partialLog = (err as { partialLog?: string }).partialLog;
        await notifyFailed(test.id, partialLog);
        handleRetry(ch, msg, QUEUE, DLQ, test.id);
      }
    } finally {
      inFlightMessages--;
    }
  };

  // handleTestMessage already fully catches its own errors (never actually rejects)
  // and is passed directly (not wrapped) so tests can capture it via
  // channel.consume.mock.calls[1][1] and await it to synchronize with the real work.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { consumerTag } = await ch.consume(QUEUE, handleTestMessage);
  queueConsumerTag = consumerTag;
};

export const app = Fastify({ logger: false });
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

const startHealthServer = async (): Promise<void> => {
  const port = Number(process.env.PORT) || 3002;
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'Worker-backend health server listening');
};

const startWithQueue = async (): Promise<void> => {
  await start();
};

if (!process.env.VITEST) {
  startHealthServer().catch(err => log.error({ err: (err as Error).message }, 'Health server failed'));
  startWithQueue().catch(err => log.error({ err: (err as Error).message }, 'Worker-backend startup failed'));
}

// Worst-case a single in-flight message can still take: k6's own max-duration
// enforcement (SIGTERM then SIGKILL after a grace period) plus a buffer for the
// post-exit bookkeeping (DB write, result-queue send, ack) once k6 has exited.
const DRAIN_TIMEOUT_MS = MAX_TEST_DURATION_MS + GRACE_PERIOD_MS + 10_000;

async function shutdown(signal: string) {
  log.info({ signal, inFlight: inFlightMessages }, 'Shutting down — draining in-flight tests before exit');
  try {
    // Stop new deliveries — in-flight messages keep running to completion on this
    // same channel (cancel does not affect messages already delivered to us).
    if (channel && queueConsumerTag) await channel.cancel(queueConsumerTag);
  } catch (_) { /* best-effort — a KEDA scale-down still shouldn't hang forever on this */ }

  await drainInFlight(() => inFlightMessages, DRAIN_TIMEOUT_MS);
  if (inFlightMessages > 0) {
    log.warn({ remaining: inFlightMessages }, 'Shutdown drain deadline reached with tests still in flight — exiting anyway');
  }

  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (_) { /* ignore close errors during shutdown */ }
  await shutdownTracing();
  process.exit(0);
}

if (!process.env.VITEST) {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}
