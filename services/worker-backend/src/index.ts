import amqplib from 'amqplib';
import { spawn, ChildProcess } from 'child_process';
import { writeFile, unlink, readFile } from 'fs/promises';
import { Pool } from 'pg';
import * as os from 'os';
import * as path from 'path';

import { EnrichedTestRequest, TestResult, BackendMetrics, LiveMetricPoint } from '@alt/shared';
import { parseK6Output, aggregateWindow, parseK6StatusCodes } from './parser';
import { log } from './logger';

const QUEUE            = 'backend-tests';
const CANCEL_EXCHANGE  = 'cancel-fanout';  // fanout — all replicas get every cancel
const RESULTS_QUEUE    = 'test-results';
const DLQ              = `${QUEUE}.dlq`;
const MAX_RETRIES   = 3;
const RESULTS_URL   = process.env.RESULTS_URL || 'http://results-service:3004';
const LIVE_INTERVAL_MS     = 5000;
const MAX_TEST_DURATION_MS = parseInt(process.env.K6_MAX_DURATION_MS ?? '600000'); // 10 min
const GRACE_PERIOD_MS      = 30000;
const WORKER_CONCURRENCY   = parseInt(process.env.WORKER_CONCURRENCY ?? '1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://alt_user:alt_password@localhost:5432/alt_db'
});

// Track in-progress k6 processes for cancellation
const runningTests  = new Map<string, ChildProcess>();
const cancelledTests = new Set<string>();

const saveScript = async (
  targetUrl: string,
  script: string,
  scriptId?: string
): Promise<string> => {
  if (scriptId) return scriptId;
  const { rows } = await pool.query(
    `INSERT INTO test_scripts (target_url, test_type, script)
     VALUES ($1, 'backend', $2)
     ON CONFLICT (target_url, test_type) DO UPDATE
     SET script = EXCLUDED.script, updated_at = NOW()
     RETURNING id`,
    [targetUrl, script]
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

const runK6Test = async (testId: string, script: string): Promise<BackendMetrics> => {
  const scriptPath = path.join(os.tmpdir(), `k6-${testId}.js`);
  const jsonPath   = `/tmp/k6-live-${testId}.json`;

  await writeFile(scriptPath, script);

  await validateScript(scriptPath).catch(async (err) => {
    await unlink(scriptPath).catch(() => {});
    throw err;
  });

  return new Promise((resolve, reject) => {
    const k6 = spawn('k6', ['run', '--out', `json=${jsonPath}`, scriptPath]);
    runningTests.set(testId, k6);

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

    k6.on('close', async () => {
      clearInterval(liveInterval);
      clearTimeout(killTimer);
      runningTests.delete(testId);
      await readAndPost();

      const jsonContent = await readFile(jsonPath, 'utf-8').catch(() => '');
      await unlink(scriptPath).catch(() => {});
      await unlink(jsonPath).catch(() => {});

      const output  = stdout + stderr;
      log.debug({ testId }, 'k6 full output received');
      const metrics = parseK6Output(output);
      metrics.statusCodes = parseK6StatusCodes(jsonContent);
      resolve(metrics);
    });

    k6.on('error', async (err) => {
      clearInterval(liveInterval);
      clearTimeout(killTimer);
      runningTests.delete(testId);
      await unlink(scriptPath).catch(() => {});
      await unlink(jsonPath).catch(() => {});
      reject(err);
    });
  });
};

const updateStatus = async (testId: string, status: string): Promise<void> => {
  await pool.query(`UPDATE test_results SET status = $1 WHERE test_id = $2`, [status, testId]);
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
  const url        = process.env.RABBITMQ_URL || 'amqp://alt_user:alt_password@localhost:5672';
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

      const metrics = await runK6Test(test.id, test.generatedScript!);

      // r2: check if the test was cancelled while running
      if (cancelledTests.has(test.id)) {
        cancelledTests.delete(test.id);
        await updateStatus(test.id, 'cancelled');
        testLog.info('Test cancelled during execution');
        channel.ack(msg);
        return;
      }

      const scriptId = await saveScript(test.targetUrl, test.generatedScript!, test.scriptId);

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

start().catch(err => log.error({ err: (err as Error).message }, 'Worker-backend startup failed'));
