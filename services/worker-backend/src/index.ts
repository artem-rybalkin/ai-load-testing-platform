import amqplib from 'amqplib';
import { spawn } from 'child_process';
import { writeFile, unlink, readFile } from 'fs/promises';
import { Pool } from 'pg';
import * as os from 'os';
import * as path from 'path';

import { EnrichedTestRequest, TestResult, BackendMetrics, LiveMetricPoint } from '@alt/shared';
import { parseK6Output, aggregateWindow } from './parser';

const QUEUE = 'backend-tests';
const RESULTS_QUEUE = 'test-results';
const RESULTS_URL = process.env.RESULTS_URL || 'http://results-service:3004';
const LIVE_INTERVAL_MS = 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://alt_user:alt_password@localhost:5432/alt_db'
});

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
  } catch {
    // best-effort — don't fail the test if live posting fails
  }
};

const runK6Test = async (testId: string, script: string): Promise<BackendMetrics> => {
  const scriptPath = path.join(os.tmpdir(), `k6-${testId}.js`);
  const jsonPath = `/tmp/k6-live-${testId}.json`;

  await writeFile(scriptPath, script);

  return new Promise((resolve, reject) => {
    const k6 = spawn('k6', ['run', '--out', `json=${jsonPath}`, scriptPath]);

    let stdout = '';
    let stderr = '';
    let processedLines = 0;

    k6.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    k6.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const readAndPost = async () => {
      try {
        const content = await readFile(jsonPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        const newLines = lines.slice(processedLines);
        processedLines = lines.length;

        const agg = aggregateWindow(newLines);
        if (agg) {
          await postLiveMetric(testId, { timestamp: new Date().toISOString(), ...agg });
        }
      } catch { /* file may not exist yet */ }
    };

    const interval = setInterval(readAndPost, LIVE_INTERVAL_MS);

    k6.on('close', async () => {
      clearInterval(interval);
      await readAndPost();
      await unlink(scriptPath).catch(() => {});
      await unlink(jsonPath).catch(() => {});

      const output = stdout + stderr;
      console.log('k6 full output:', output);
      resolve(parseK6Output(output));
    });

    k6.on('error', async (err) => {
      clearInterval(interval);
      await unlink(scriptPath).catch(() => {});
      await unlink(jsonPath).catch(() => {});
      reject(err);
    });
  });
};

const updateStatus = async (testId: string, status: string): Promise<void> => {
  await pool.query(
    `UPDATE test_results SET status = $1 WHERE test_id = $2`,
    [status, testId]
  );
};

const start = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL || 'amqp://alt_user:alt_password@localhost:5672';
  const maxRetries = 20;
  const delay = 10000;

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
  await channel.assertQueue(RESULTS_QUEUE, { durable: true });
  channel.prefetch(1);

  console.log('Worker-backend listening on queue:', QUEUE);

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const test: EnrichedTestRequest = JSON.parse(msg.content.toString());
    console.log(`Received test: ${test.id} — ${test.targetUrl}`);

    try {
      await updateStatus(test.id, 'running');

      const metrics = await runK6Test(test.id, test.generatedScript!);

      const scriptId = await saveScript(
        test.targetUrl,
        test.generatedScript!,
        test.scriptId
      );

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
        Buffer.from(JSON.stringify({ ...result, scriptId, reusedScript: test.reusedScript })),
        { persistent: true }
      );

      console.log('k6 test completed:', JSON.stringify(metrics, null, 2));
      channel.ack(msg);
    } catch (err) {
      console.error('Test failed:', err);
      await updateStatus(test.id, 'failed').catch(() => {});
      channel.nack(msg, false, false);
    }
  });
};

start().catch(console.error);
