import amqplib from 'amqplib';
import { Pool } from 'pg';

import { TestResult, BackendMetrics, ClientMetrics } from '@alt/shared';
import { pool } from './db';
import { analyzeResult } from './analyzer';
import { log } from './logger';

const fireWebhooks = async (p: Pool, result: TestResult, perfStatus: string): Promise<void> => {
  const { rows } = await p.query(
    `SELECT url, secret FROM webhooks WHERE $1 = ANY(events)`,
    [perfStatus]
  );
  await Promise.allSettled(rows.map(({ url, secret }: { url: string; secret: string | null }) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Webhook-Secret': secret } : {})
      },
      body: JSON.stringify({ perfStatus, testId: result.testId, targetUrl: result.targetUrl, timestamp: new Date().toISOString() })
    })
  ));
};

const QUEUE       = 'test-results';
const DLQ         = `${QUEUE}.dlq`;
const MAX_RETRIES = 3;

let consumerConnected = false;
export const isConsumerConnected = (): boolean => consumerConnected;

export const handleResult = async (p: Pool, result: TestResult): Promise<void> => {
  const { rows: prevRows } = await p.query(
    `SELECT metrics FROM test_results
     WHERE target_url = $1
       AND type = $2
       AND status = 'completed'
       AND test_id != $3
     ORDER BY is_baseline DESC, created_at DESC
     LIMIT 1`,
    [result.targetUrl, result.metrics.type, result.testId]
  );

  const previousMetrics = prevRows.length > 0 ? prevRows[0].metrics : null;

  const analysis = analyzeResult(
    result.metrics as BackendMetrics | ClientMetrics,
    previousMetrics as BackendMetrics | ClientMetrics | null,
    result.thresholds
  );

  await p.query(
    `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at, perf_status, analysis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (test_id) DO UPDATE SET
       status       = EXCLUDED.status,
       metrics      = EXCLUDED.metrics,
       target_url   = COALESCE(EXCLUDED.target_url, test_results.target_url),
       completed_at = EXCLUDED.completed_at,
       perf_status  = EXCLUDED.perf_status,
       analysis     = EXCLUDED.analysis`,
    [
      result.testId,
      result.metrics.type,
      result.targetUrl,
      result.status,
      JSON.stringify(result.metrics),
      result.startedAt,
      result.completedAt,
      analysis.perfStatus,
      JSON.stringify(analysis),
    ]
  );

  if (analysis.perfStatus === 'failed' || analysis.perfStatus === 'degraded') {
    fireWebhooks(p, result, analysis.perfStatus).catch(() => {});
  }
};

export const startConsumer = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');
  const maxRetries = 20;
  const delay = 10000;

  let connection;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info({ attempt, maxRetries }, 'Connecting to RabbitMQ');
      connection = await amqplib.connect(url);
      consumerConnected = true;
      break;
    } catch (err) {
      log.error({ attempt, err: (err as Error).message }, 'RabbitMQ connection failed');
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const channel = await connection!.createChannel();
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.assertQueue(DLQ,   { durable: true });
  channel.prefetch(1);

  log.info({ queue: QUEUE }, 'Results-service consumer listening');

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const result: TestResult = JSON.parse(msg.content.toString());
    const testLog = log.child({ testId: result.testId });
    testLog.info('Saving result');

    try {
      await handleResult(pool, result);
      testLog.info('Result saved');
      channel.ack(msg);
    } catch (err) {
      log.error({ testId: result.testId, err: (err as Error).message }, 'Failed to save result');
      const retryCount = ((msg.properties.headers?.['x-retry-count'] as number) ?? 0);
      if (retryCount < MAX_RETRIES) {
        log.warn({ testId: result.testId, retryCount: retryCount + 1 }, 'Retrying result save');
        channel.publish('', QUEUE, msg.content, {
          persistent: true,
          headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 }
        });
      } else {
        log.error({ testId: result.testId }, 'Max retries exceeded, routing to DLQ');
        channel.sendToQueue(DLQ, msg.content, { persistent: true });
      }
      channel.ack(msg);
    }
  });
};
