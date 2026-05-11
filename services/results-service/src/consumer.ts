import amqplib from 'amqplib';

import { TestResult, BackendMetrics, ClientMetrics } from '@alt/shared';
import { pool } from './db';
import { analyzeResult } from './analyzer';

const QUEUE = 'test-results';

export const startConsumer = async (): Promise<void> => {
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
  channel.prefetch(1);

  console.log('Results-service listening on queue:', QUEUE);

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const result: TestResult = JSON.parse(msg.content.toString());
    console.log(`Saving result for test: ${result.testId}`);

    try {
      // Знаходимо попередній тест для цього URL
      const { rows: prevRows } = await pool.query(
        `SELECT metrics FROM test_results
         WHERE target_url = $1
           AND type = $2
           AND status = 'completed'
           AND test_id != $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [result.targetUrl, result.metrics.type, result.testId]
      );

      const previousMetrics = prevRows.length > 0 ? prevRows[0].metrics : null;

      // Аналізуємо результат
      const analysis = analyzeResult(
        result.metrics as BackendMetrics | ClientMetrics,
        previousMetrics as BackendMetrics | ClientMetrics | null
      );

      console.log(`Analysis: ${analysis.perfStatus} — ${analysis.summary}`);

      // Зберігаємо результат з аналізом
      await pool.query(
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
          JSON.stringify(analysis)
        ]
      );

      console.log(`Result saved with analysis: ${analysis.perfStatus}`);
      channel.ack(msg);
    } catch (err) {
      console.error('Failed to save result:', err);
      channel.nack(msg, false, false);
    }
  });
};