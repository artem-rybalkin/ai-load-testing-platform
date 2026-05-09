import amqplib from 'amqplib';
import { execFile } from 'child_process';
import { writeFile, unlink, readFile } from 'fs/promises';
import { promisify } from 'util';
import { Pool } from 'pg';
import * as os from 'os';
import * as path from 'path';

import { EnrichedTestRequest, TestResult, BackendMetrics } from '@alt/shared';

const execFileAsync = promisify(execFile);

const QUEUE = 'backend-tests';
const RESULTS_QUEUE = 'test-results';

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

const parseK6Output = (output: string): BackendMetrics => {
  const getMetric = (name: string): number => {
    const regex = new RegExp(`${name}[^\\d]+(\\d+(?:\\.\\d+)?)`);
    const match = output.match(regex);
    return match ? parseFloat(match[1]) : 0;
  };

  return {
    type: 'backend',
    requestsTotal: getMetric('http_reqs'),
    requestsFailed: getMetric('http_req_failed'),
    avgResponseTime: getMetric('http_req_duration.*avg'),
    p95ResponseTime: getMetric('http_req_duration.*p\\(95\\)'),
    p99ResponseTime: getMetric('http_req_duration.*p\\(99\\)'),
    rps: getMetric('http_reqs.*rate')
  };
};

const runK6Test = async (test: EnrichedTestRequest): Promise<BackendMetrics> => {
  if (!test.generatedScript) {
    throw new Error('No script provided for k6 test');
  }

  const scriptPath = path.join(os.tmpdir(), `k6-${test.id}.js`);

  try {
    await writeFile(scriptPath, test.generatedScript);
    console.log(`Running k6 test for: ${test.targetUrl}`);

    let output = '';
    try {
      const { stdout, stderr } = await execFileAsync('k6', [
        'run',
        '--out', 'json=/tmp/k6-results.json',
        scriptPath
      ], { timeout: 120000 });
      output = stdout + stderr;
    } catch (err: unknown) {
      // k6 повертає non-zero exit code коли threshold перевищено
      // це нормальна поведінка — парсимо результати з output
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      if (execErr.stdout || execErr.stderr) {
        output = (execErr.stdout || '') + (execErr.stderr || '');
        console.log('k6 finished with threshold violations — parsing results anyway');
      } else {
        throw err;
      }
    }

    console.log('k6 output snippet:', output.slice(0, 300));
    return parseK6Output(output);
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
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
      const metrics = await runK6Test(test);

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
      channel.nack(msg, false, false);
    }
  });
};

start().catch(console.error);