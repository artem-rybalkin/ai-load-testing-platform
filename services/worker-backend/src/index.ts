import './tracing';
import amqplib from 'amqplib';
import { spawn, ChildProcess } from 'child_process';
import { writeFile, readFile, mkdir, rm, open } from 'fs/promises';
import { Pool } from 'pg';
import * as os from 'os';
import * as path from 'path';
import Fastify from 'fastify';

import { EnrichedTestRequest, TestResult, BackendMetrics, LiveMetricPoint, connectWithBackoff } from '@alt/shared';
import { parseK6Output, aggregateWindow, parseK6JsonOutput, LIVE_WINDOW_SEC } from './parser';
import { log } from './logger';

let queueConnected = false;

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
const MAX_RETRIES   = 3;
const RESULTS_URL   = process.env.RESULTS_URL || 'http://results-service:3004';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const internalHeaders = (extra?: Record<string, string>): Record<string, string> => ({
  ...(INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {}),
  ...extra,
});
const LIVE_INTERVAL_MS     = LIVE_WINDOW_SEC * 1000;
const MAX_TEST_DURATION_MS = parseInt(process.env.K6_MAX_DURATION_MS ?? '600000'); // 10 min
const GRACE_PERIOD_MS      = 30000;
const WORKER_CONCURRENCY   = parseInt(process.env.WORKER_CONCURRENCY ?? '1');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Track in-progress k6 processes for cancellation
const runningTests  = new Map<string, ChildProcess>();
const cancelledTests = new Set<string>();

const saveScript = async (
  targetUrl: string,
  script: string,
  scriptId?: string,
  description?: string,
  projectId?: string,
): Promise<string> => {
  if (scriptId) {
    await pool.query(
      'UPDATE test_scripts SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
      [scriptId]
    );
    return scriptId;
  }
  const { rows } = await pool.query(
    `INSERT INTO test_scripts (target_url, test_type, script, description, project_id)
     VALUES ($1, 'backend', $2, $3, $4)
     ON CONFLICT (target_url, test_type) DO UPDATE
     SET script = EXCLUDED.script, description = EXCLUDED.description, updated_at = NOW(),
         project_id = COALESCE(test_scripts.project_id, EXCLUDED.project_id)
     RETURNING id`,
    [targetUrl, script, description ?? null, projectId ?? null]
  );
  return rows[0].id;
};

const postLiveMetric = async (testId: string, point: LiveMetricPoint): Promise<void> => {
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/live`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(point)
    });
  } catch { /* best-effort */ }
};

const validateScript = (scriptPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const k6 = spawn('k6', ['inspect', scriptPath]);
    const stderrChunks: Buffer[] = [];
    k6.stderr?.on('data', chunk => stderrChunks.push(chunk));
    k6.on('close', code => {
      if (code === 0) { resolve(); return; }
      // k6 inspect loads + statically evaluates the script's init scope (no
      // network calls), so a non-zero exit here means the AI-generated script
      // itself is broken (syntax/runtime error) — capture stderr so the cause
      // is diagnosable instead of just an opaque exit code.
      const detail = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 2000);
      reject(new Error(`k6 script validation failed (exit ${code})${detail ? `: ${detail}` : ''}`));
    });
    k6.on('error', reject);
  });

const runK6Test = async (
  testId: string,
  script: string,
  envVars?: Record<string, string>,
  testData?: Array<Record<string, string>>,
  csvData?: string,
): Promise<BackendMetrics> => {
  // Per-test directory avoids file collisions when WORKER_CONCURRENCY > 1
  const runDir    = path.join(os.tmpdir(), `k6-run-${testId}`);
  await mkdir(runDir, { recursive: true });
  const scriptPath = path.join(runDir, 'script.js');
  const jsonPath   = path.join(runDir, 'live.json');

  // Write all data files in parallel — they are independent
  await Promise.all([
    writeFile(scriptPath, script),
    testData && testData.length > 0
      ? writeFile(path.join(runDir, 'data.json'), JSON.stringify(testData))
      : Promise.resolve(),
    csvData
      ? writeFile(path.join(runDir, 'data.csv'), Buffer.from(csvData, 'base64'))
      : Promise.resolve(),
  ]);

  await validateScript(scriptPath).catch(async (err) => {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  });

  return new Promise((resolve, reject) => {
    const SAFE_KEY = /^[A-Z_][A-Z0-9_]*$/i;
    const envArgs = Object.entries(envVars ?? {})
      .filter(([k, v]) => SAFE_KEY.test(k) && !v.includes('\n') && !v.includes('\0') && k.length <= 64 && v.length <= 1024)
      .flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    const k6 = spawn('k6', [
      'run',
      '--out', `json=${jsonPath}`,
      '--summary-trend-stats', 'avg,min,med,max,p(90),p(95),p(99)',
      ...envArgs,
      scriptPath,
    ]);
    runningTests.set(testId, k6);
    // Mark running + exact k6 start time (for countdown) in one call — fires
    // only once validation has passed and the process has actually spawned,
    // so a validation failure never produces a misleading "running" blip.
    notifyRunning(testId).catch(() => {});

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let fileOffset = 0;

    k6.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
    k6.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

    const readAndPost = async (): Promise<void> => {
      try {
        const fh = await open(jsonPath, 'r');
        try {
          const { size } = await fh.stat();
          if (size <= fileOffset) return;
          const buf = Buffer.allocUnsafe(size - fileOffset);
          await fh.read(buf, 0, buf.length, fileOffset);
          fileOffset = size;
          const newLines = buf.toString('utf-8').split('\n').filter(l => l.trim());
          const agg = aggregateWindow(newLines);
          if (agg) await postLiveMetric(testId, { timestamp: new Date().toISOString(), ...agg });
        } finally {
          await fh.close();
        }
      } catch { /* file may not exist yet */ }
    };

    const liveInterval = setInterval(readAndPost, LIVE_INTERVAL_MS);

    // r4: hard execution timeout
    const killTimer = setTimeout(() => {
      log.warn({ testId, maxMs: MAX_TEST_DURATION_MS }, 'k6 test exceeded max duration, sending SIGTERM');
      k6.kill('SIGTERM');
      setTimeout(() => { if (runningTests.has(testId)) k6.kill('SIGKILL'); }, GRACE_PERIOD_MS);
    }, MAX_TEST_DURATION_MS);

    k6.on('close', async (code) => {
      clearInterval(liveInterval);
      clearTimeout(killTimer);
      runningTests.delete(testId);
      await readAndPost();

      const jsonContent = await readFile(jsonPath, 'utf-8').catch(() => '');
      await rm(runDir, { recursive: true, force: true }).catch(() => {});

      // k6 exit codes:
      //   0  — all good
      //   99 — threshold violations (test ran to completion; our analyzer handles SLO checks)
      // else — script error, configuration failure, or crash
      if (code !== 0 && code !== 99) {
        log.warn({ testId, code }, 'k6 exited with non-zero code — parsing partial output');
      }

      const output = Buffer.concat(stdoutChunks).toString() + Buffer.concat(stderrChunks).toString();
      log.debug({ testId, exitCode: code }, 'k6 full output received');
      const metrics = parseK6Output(output);
      const { statusCodes, errorBreakdown, stepMetrics } = parseK6JsonOutput(jsonContent);
      metrics.statusCodes = statusCodes;
      metrics.errorBreakdown = errorBreakdown;
      if (stepMetrics.length > 0) metrics.stepMetrics = stepMetrics;

      // Only reject if we got nothing useful AND it was a hard failure (not a threshold violation)
      if (code !== 0 && code !== 99 && metrics.requestsTotal === 0) {
        reject(new Error(`k6 exited with code ${code}: ${Buffer.concat(stderrChunks).toString().slice(-500)}`));
        return;
      }

      resolve(metrics);
    });

    k6.on('error', async (err) => {
      clearInterval(liveInterval);
      clearTimeout(killTimer);
      runningTests.delete(testId);
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
      reject(err);
    });
  });
};

// Status transitions go through results-service's REST endpoints (matching
// worker-client) rather than writing test_results directly: those endpoints
// both clear the stale status_message AND broadcast the test:status WebSocket
// event. A direct pool.query here would silently desync any open result page —
// it'd never receive the push notification and would be stuck showing the
// last status it fetched (e.g. "pending") until manually reloaded.
const notifyRunning = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/running`, { method: 'POST', headers: internalHeaders() }); }
  catch { /* best-effort */ }
};

const notifyFailed = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/fail`, { method: 'POST', headers: internalHeaders() }); }
  catch { /* best-effort */ }
};

const notifyCancelled = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/cancel`, { method: 'POST', headers: internalHeaders() }); }
  catch { /* best-effort */ }
};

// r1: retry helper — republish with incremented counter or route to DLQ
const handleRetry = (
  channel: amqplib.Channel,
  msg: amqplib.Message,
  queue: string,
  dlq: string,
  testId: string
): void => {
  const retryCount = ((msg.properties.headers?.['x-retry-count'] as number) ?? 0);
  if (retryCount < MAX_RETRIES) {
    log.warn({ testId, retryCount: retryCount + 1, maxRetries: MAX_RETRIES }, 'Retrying message');
    channel.publish('', queue, msg.content, {
      persistent: true,
      headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 }
    });
  } else {
    log.error({ testId, retryCount }, 'Max retries exceeded, routing to DLQ');
    channel.sendToQueue(dlq, msg.content, { persistent: true });
  }
  channel.ack(msg);
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

  await channel.assertQueue(QUEUE,         { durable: true });
  await channel.assertQueue(DLQ,           { durable: true });
  await channel.assertQueue(RESULTS_QUEUE, { durable: true });

  // s1: each replica gets its own exclusive cancel queue bound to the fanout exchange
  await channel.assertExchange(CANCEL_EXCHANGE, 'fanout', { durable: true });
  const { queue: cancelQueue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
  await channel.bindQueue(cancelQueue, CANCEL_EXCHANGE, '');

  queueConnected = true;
  channel.prefetch(WORKER_CONCURRENCY);
  log.info({ queue: QUEUE, concurrency: WORKER_CONCURRENCY }, 'Worker-backend listening');

  // r2: cancel consumer — kills running k6 processes by testId
  channel.consume(cancelQueue, async (msg) => {
    if (!msg) return;
    const { testId } = JSON.parse(msg.content.toString()) as { testId: string };
    const proc = runningTests.get(testId);
    if (proc) {
      log.info({ testId }, 'Cancelling k6 test');
      cancelledTests.add(testId);
      proc.kill('SIGTERM');
    }
    channel.ack(msg);
  }, { noAck: false });

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const test: EnrichedTestRequest = JSON.parse(msg.content.toString());
    const testLog = log.child({ testId: test.id, targetUrl: test.targetUrl });
    testLog.info('Received backend test');

    // Tag the active OTel span so traces are searchable by testId in Tempo
    const { trace } = await import('@opentelemetry/api');
    const span = trace.getActiveSpan();
    if (span) { span.setAttribute('test.id', test.id); span.setAttribute('test.url', test.targetUrl); }

    // r2: skip if already cancelled
    const { rows: statusRows } = await pool.query(
      `SELECT status FROM test_results WHERE test_id = $1`, [test.id]
    );
    if (statusRows[0]?.status === 'cancelled') {
      testLog.info('Test was cancelled before execution, skipping');
      channel.ack(msg);
      return;
    }

    try {
      // Status flips to 'running' (+ started_at) inside runK6Test, once
      // validation passes and the k6 process actually spawns — see notifyRunning.
      const metrics = await runK6Test(test.id, test.generatedScript!, test.envVars, test.testData, test.csvData);

      // r2: check if the test was cancelled while running
      if (cancelledTests.has(test.id)) {
        cancelledTests.delete(test.id);
        await notifyCancelled(test.id);
        testLog.info('Test cancelled during execution');
        channel.ack(msg);
        return;
      }

      const scriptSaveKey = test.scriptCacheKey ?? test.targetUrl;
      const scriptId = await saveScript(scriptSaveKey, test.generatedScript!, test.scriptId, test.description, test.projectId);

      const result: TestResult = {
        testId: test.id,
        targetUrl: test.targetUrl,
        status: 'completed',
        metrics,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      };

      channel.sendToQueue(
        RESULTS_QUEUE,
        Buffer.from(JSON.stringify({ ...result, scriptId, reusedScript: test.reusedScript, thresholds: test.thresholds, projectId: test.projectId })),
        { persistent: true }
      );

      testLog.info({ requestsTotal: metrics.requestsTotal, rps: metrics.rps, p95: metrics.p95ResponseTime, errorRate: (metrics.requestsFailed / (metrics.requestsTotal || 1) * 100).toFixed(2) }, 'k6 test completed');
      testLog.debug({ metrics }, 'k6 test full metrics');
      channel.ack(msg);
    } catch (err) {
      testLog.error({ err: (err as Error).message }, 'Test failed');
      await notifyFailed(test.id);
      handleRetry(channel, msg, QUEUE, DLQ, test.id);
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
