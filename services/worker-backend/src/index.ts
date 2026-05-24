import amqplib from 'amqplib';
import { spawn, ChildProcess } from 'child_process';
import { writeFile, unlink, readFile, mkdir, rm } from 'fs/promises';
import { Pool } from 'pg';
import * as os from 'os';
import * as path from 'path';
import Fastify from 'fastify';

import { EnrichedTestRequest, TestResult, BackendMetrics, LiveMetricPoint } from '@alt/shared';
import { parseK6Output, aggregateWindow, parseK6Errors, parseK6GroupMetrics } from './parser';
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
const LIVE_INTERVAL_MS     = 2000;
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
  description?: string
): Promise<string> => {
  if (scriptId) {
    await pool.query(
      'UPDATE test_scripts SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
      [scriptId]
    );
    return scriptId;
  }
  const { rows } = await pool.query(
    `INSERT INTO test_scripts (target_url, test_type, script, description)
     VALUES ($1, 'backend', $2, $3)
     ON CONFLICT (target_url, test_type) DO UPDATE
     SET script = EXCLUDED.script, description = EXCLUDED.description, updated_at = NOW()
     RETURNING id`,
    [targetUrl, script, description ?? null]
  );
  return rows[0].id;
};

const postLiveMetric = async (testId: string, point: LiveMetricPoint): Promise<void> => {
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(point)
    });
  } catch { /* best-effort */ }
};

const validateScript = (scriptPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const k6 = spawn('k6', ['inspect', scriptPath]);
    k6.on('close', code => code === 0 ? resolve() : reject(new Error(`k6 script validation failed (exit ${code})`)));
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

  await writeFile(scriptPath, script);

  // Write parameterization data files so k6 open('./data.json') / open('./data.csv') resolves them
  if (testData && testData.length > 0) {
    await writeFile(path.join(runDir, 'data.json'), JSON.stringify(testData));
  }
  if (csvData) {
    await writeFile(path.join(runDir, 'data.csv'), Buffer.from(csvData, 'base64'));
  }

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
    setStartedAt(testId).catch(() => {}); // mark exact k6 start time for countdown

    let stdout = '';
    let stderr = '';
    let processedLines = 0;

    k6.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    k6.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const readAndPost = async () => {
      try {
        const content = await readFile(jsonPath, 'utf-8');
        const lines   = content.split('\n').filter(l => l.trim());
        const newLines = lines.slice(processedLines);
        processedLines = lines.length;
        const agg = aggregateWindow(newLines);
        if (agg) await postLiveMetric(testId, { timestamp: new Date().toISOString(), ...agg });
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

      const output = stdout + stderr;
      log.debug({ testId, exitCode: code }, 'k6 full output received');
      const metrics = parseK6Output(output);
      const { statusCodes, errorBreakdown } = parseK6Errors(jsonContent);
      metrics.statusCodes = statusCodes;
      metrics.errorBreakdown = errorBreakdown;
      const stepMetrics = parseK6GroupMetrics(jsonContent);
      if (stepMetrics.length > 0) metrics.stepMetrics = stepMetrics;

      // Only reject if we got nothing useful AND it was a hard failure (not a threshold violation)
      if (code !== 0 && code !== 99 && metrics.requestsTotal === 0) {
        reject(new Error(`k6 exited with code ${code}: ${stderr.slice(-500)}`));
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

const updateStatus = async (testId: string, status: string): Promise<void> => {
  await pool.query(`UPDATE test_results SET status = $1 WHERE test_id = $2`, [status, testId]);
};

const setStartedAt = async (testId: string): Promise<void> => {
  await pool.query(
    `UPDATE test_results SET started_at = NOW() WHERE test_id = $1`,
    [testId]
  );
};

// r1: retry helper — republish with incremented counter or route to DLQ
const handleRetry = (
  channel: amqplib.Channel,
  msg: amqplib.Message,
  queue: string,
  dlq: string,
  testId: string
) => {
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

const start = async (): Promise<void> => {
  const url        = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');
  const maxRetries = 20;
  const delay      = 10000;

  let connection;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info({ attempt, maxRetries }, 'Connecting to RabbitMQ');
      connection = await amqplib.connect(url);
      break;
    } catch (err) {
      log.error({ attempt, err: (err as Error).message }, 'RabbitMQ connection failed');
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const channel = await connection!.createChannel();
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
      await updateStatus(test.id, 'running');

      const metrics = await runK6Test(test.id, test.generatedScript!, test.envVars, test.testData, test.csvData);

      // r2: check if the test was cancelled while running
      if (cancelledTests.has(test.id)) {
        cancelledTests.delete(test.id);
        await updateStatus(test.id, 'cancelled');
        testLog.info('Test cancelled during execution');
        channel.ack(msg);
        return;
      }

      const scriptSaveKey = test.scriptCacheKey ?? test.targetUrl;
      const scriptId = await saveScript(scriptSaveKey, test.generatedScript!, test.scriptId, test.description);

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
        Buffer.from(JSON.stringify({ ...result, scriptId, reusedScript: test.reusedScript, thresholds: test.thresholds })),
        { persistent: true }
      );

      testLog.info({ metrics }, 'k6 test completed');
      channel.ack(msg);
    } catch (err) {
      testLog.error({ err: (err as Error).message }, 'Test failed');
      await updateStatus(test.id, 'failed').catch(() => {});
      handleRetry(channel, msg, QUEUE, DLQ, test.id);
    }
  });
};

const startHealthServer = async () => {
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

const startWithQueue = async () => {
  await start();
};

startHealthServer().catch(err => log.error({ err: (err as Error).message }, 'Health server failed'));
startWithQueue().catch(err => log.error({ err: (err as Error).message }, 'Worker-backend startup failed'));
