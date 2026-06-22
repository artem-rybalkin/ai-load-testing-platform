import amqplib from 'amqplib';
import { createHmac } from 'crypto';
import { Pool } from 'pg';

import { TestResult, BackendMetrics, ClientMetrics, AnalysisResult, connectWithBackoff } from '@alt/shared';
import { pool } from './db';
import { analyzeResult } from './analyzer';
import { log } from './logger';
import { broadcast } from './ws';

const ANALYSER_URL = process.env.ANALYSER_URL || 'http://analyser-service:3008';

/** Fetch external observability data from configured log sources for this test's time window. */
const fetchExternalMetricsForTest = async (
  p: Pool,
  targetUrl: string,
  startedAt: string | null,
  completedAt: string | null,
  projectId?: string | null,
): Promise<Array<{ sourceName: string; platform: string | null; data: string }>> => {
  try {
    const { rows } = await p.query(
      `SELECT name, platform, metrics_endpoint_template, auth_header
       FROM log_sources WHERE metrics_endpoint_template IS NOT NULL
         AND ($1::uuid IS NULL OR project_id = $1::uuid)`,
      [projectId ?? null]
    );
    if (rows.length === 0) return [];

    const started   = startedAt   ? new Date(startedAt)   : new Date(Date.now() - 3_600_000);
    const completed = completedAt ? new Date(completedAt) : new Date();

    const interpolate = (t: string): string =>
      t.replaceAll('{startedAtMs}',  String(started.getTime()))
       .replaceAll('{completedAtMs}', String(completed.getTime()))
       .replaceAll('{startedAtS}',   String(Math.floor(started.getTime() / 1000)))
       .replaceAll('{completedAtS}', String(Math.floor(completed.getTime() / 1000)))
       .replaceAll('{startedAtISO}', started.toISOString())
       .replaceAll('{completedAtISO}', completed.toISOString())
       .replaceAll('{targetUrl}', targetUrl)
       .replaceAll('{targetUrlEncoded}', encodeURIComponent(targetUrl));

    const results: Array<{ sourceName: string; platform: string | null; data: string }> = [];
    await Promise.allSettled(
      rows.map(async (row: { name: string; platform: string | null; metrics_endpoint_template: string; auth_header: string | null }) => {
        try {
          const headers: Record<string, string> = { 'Accept': 'application/json' };
          if (row.auth_header) headers['Authorization'] = row.auth_header;
          const res = await fetch(interpolate(row.metrics_endpoint_template), { headers, signal: AbortSignal.timeout(5000) });
          if (!res.ok) return;
          const text = await res.text();
          results.push({ sourceName: row.name, platform: row.platform, data: text.slice(0, 3000) });
        } catch { /* non-fatal */ }
      })
    );
    return results;
  } catch { return []; }
};

/** Call analyser-service; returns null on any error so caller falls back to local analysis. */
const callAnalyserService = async (
  p: Pool,
  testId: string,
  targetUrl: string,
  type: string,
  metrics: BackendMetrics | ClientMetrics,
  previousMetrics: BackendMetrics | ClientMetrics | null,
  thresholds: TestResult['thresholds'],
  startedAt: string | null = null,
  completedAt: string | null = null,
  projectId: string | null = null,
): Promise<AnalysisResult | null> => {
  const externalMetrics = await fetchExternalMetricsForTest(p, targetUrl, startedAt, completedAt, projectId);
  try {
    const res = await fetch(`${ANALYSER_URL}/analyse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testId, targetUrl, type, metrics, previousMetrics, thresholds: thresholds ?? null, externalMetrics, teamId: projectId }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const body = await res.json() as AnalysisResult & { geminiRateLimited?: boolean };
    if (body.geminiRateLimited) {
      // Persist a status_message so /system/ai-status can surface this to the UI
      fetch(`${process.env.RESULTS_URL || 'http://results-service:3004'}/results/${testId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Gemini quota exceeded — AI insights unavailable until quota resets (midnight UTC)' }),
      }).catch(() => {});
    }
    const { geminiRateLimited: _, ...analysis } = body;
    return analysis as AnalysisResult;
  } catch {
    return null;
  }
};

const buildWebhookPayload = (
  format: string,
  result: TestResult,
  perfStatus: string,
): { body: string; contentType: string } => {
  const ts = new Date().toISOString();
  const icon = perfStatus === 'failed' ? '🔴' : '🟡';
  const color = perfStatus === 'failed' ? '#cf222e' : '#9a6700';

  if (format === 'slack') {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        text: `${icon} Load test *${perfStatus.toUpperCase()}*`,
        attachments: [{
          color,
          fields: [
            { title: 'URL',    value: result.targetUrl, short: false },
            { title: 'Status', value: perfStatus,        short: true  },
            { title: 'Test ID', value: result.testId,   short: true  },
          ],
          footer: 'AI Load Testing Platform',
          ts: Math.floor(Date.now() / 1000),
        }],
      }),
    };
  }

  if (format === 'pagerduty') {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        routing_key: '', // user fills in integration key via webhook URL
        event_action: perfStatus === 'failed' ? 'trigger' : 'acknowledge',
        payload: {
          summary:   `Load test ${perfStatus}: ${result.targetUrl}`,
          severity:  perfStatus === 'failed' ? 'error' : 'warning',
          source:    result.targetUrl,
          timestamp: ts,
          custom_details: { testId: result.testId, perfStatus },
        },
      }),
    };
  }

  if (format === 'opsgenie') {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        message: `Load test ${perfStatus}: ${result.targetUrl}`,
        alias:   result.testId,
        priority: perfStatus === 'failed' ? 'P2' : 'P3',
        details:  { testId: result.testId, targetUrl: result.targetUrl, perfStatus },
        source:   'AI Load Testing Platform',
      }),
    };
  }

  // Generic (default)
  const body = JSON.stringify({ perfStatus, testId: result.testId, targetUrl: result.targetUrl, timestamp: ts });
  return { body, contentType: 'application/json' };
};

const fireWebhooks = async (p: Pool, result: TestResult, perfStatus: string, projectId: string | null): Promise<void> => {
  const { rows } = await p.query(
    `SELECT url, secret, format FROM webhooks WHERE $1 = ANY(events) AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
    [perfStatus, projectId]
  );
  const deliveries = rows.map(({ url, secret, format }: { url: string; secret: string | null; format: string | null }) => {
    const fmt = format ?? 'generic';
    const { body, contentType } = buildWebhookPayload(fmt, result, perfStatus);
    const sig = (fmt === 'generic' && secret)
      ? createHmac('sha256', secret).update(body).digest('hex')
      : null;
    return { url, promise: fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...(sig ? { 'X-Webhook-Signature': `sha256=${sig}` } : {}),
      },
      body,
    }) };
  });
  const results = await Promise.allSettled(deliveries.map(d => d.promise));
  results.forEach((res, i) => {
    if (res.status === 'rejected') {
      log.warn({ url: deliveries[i].url, err: (res.reason as Error).message }, 'Webhook delivery failed');
    }
  });
};

const QUEUE       = 'test-results';
const DLQ         = `${QUEUE}.dlq`;
const MAX_RETRIES = 3;

let consumerConnected = false;
export const isConsumerConnected = (): boolean => consumerConnected;

export const handleResult = async (p: Pool, result: TestResult): Promise<void> => {
  const projectId = result.projectId ?? null;

  // 1. Fetch previous metrics (read-only — no pg client held during slow analyser call)
  const { rows: prevRows } = await p.query(
    `SELECT metrics FROM test_results
     WHERE target_url = $1
       AND type = $2
       AND status = 'completed'
       AND test_id != $3
       AND ($4::uuid IS NULL OR project_id = $4::uuid)
     ORDER BY is_baseline DESC, created_at DESC
     LIMIT 1`,
    [result.targetUrl, result.metrics.type, result.testId, projectId]
  );
  const previousMetrics = prevRows.length > 0 ? prevRows[0].metrics : null;

  // 2. Call analyser-service (up to 12 s) without holding a pg client
  const analysis: AnalysisResult = await callAnalyserService(
    p,
    result.testId,
    result.targetUrl,
    result.metrics.type,
    result.metrics as BackendMetrics | ClientMetrics,
    previousMetrics as BackendMetrics | ClientMetrics | null,
    result.thresholds,
    result.startedAt ?? null,
    result.completedAt ?? null,
    projectId,
  ) ?? analyzeResult(
    result.metrics as BackendMetrics | ClientMetrics,
    previousMetrics as BackendMetrics | ClientMetrics | null,
    result.thresholds
  );

  // 3. Persist result in a short-lived transaction
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at, perf_status, analysis, script_id, reused_script, project_id, execution_log)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (test_id) DO UPDATE SET
         status        = EXCLUDED.status,
         status_message = NULL,
         metrics       = EXCLUDED.metrics,
         target_url    = COALESCE(EXCLUDED.target_url, test_results.target_url),
         completed_at  = EXCLUDED.completed_at,
         perf_status   = EXCLUDED.perf_status,
         analysis      = EXCLUDED.analysis,
         script_id     = COALESCE(EXCLUDED.script_id, test_results.script_id),
         reused_script = COALESCE(EXCLUDED.reused_script, test_results.reused_script),
         project_id    = COALESCE(EXCLUDED.project_id, test_results.project_id),
         execution_log = COALESCE(EXCLUDED.execution_log, test_results.execution_log)`,
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
        result.scriptId ?? null,
        result.reusedScript ?? false,
        projectId,
        result.executionLog ?? null,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (analysis.perfStatus === 'failed' || analysis.perfStatus === 'degraded') {
    fireWebhooks(p, result, analysis.perfStatus, projectId).catch(() => {});
  }

  // Push real-time updates to all connected UI clients
  broadcast({ type: 'test:status', testId: result.testId, status: result.status, perfStatus: analysis.perfStatus ?? null });
  broadcast({ type: 'tests:changed' });
};

let reconnecting = false;

/** Reconnect with capped exponential backoff (1s -> 30s), retrying forever until RabbitMQ is back. */
const scheduleReconnect = (): void => {
  if (reconnecting) return;
  reconnecting = true;
  connectWithBackoff(startConsumer, {
    onRetry: (err, attempt, nextDelayMs) =>
      log.error({ attempt, err: err.message, nextDelayMs }, 'RabbitMQ reconnect failed — retrying'),
  }).then(() => {
    reconnecting = false;
  });
};

export const startConsumer = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL;
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
    consumerConnected = false;
    scheduleReconnect();
  });

  const channel = await connection.createChannel();
  channel.on('error', (err) => {
    log.error({ err: (err as Error).message }, 'RabbitMQ channel error');
    consumerConnected = false;
  });

  await channel.assertQueue(QUEUE, { durable: true });
  await channel.assertQueue(DLQ,   { durable: true });
  channel.prefetch(1);

  consumerConnected = true;
  log.info({ queue: QUEUE }, 'Results-service consumer listening');

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const result: TestResult = JSON.parse(msg.content.toString());
    const testLog = log.child({ testId: result.testId });
    testLog.info('Saving result');

    // Tag the active OTel span so traces are searchable by testId in Tempo
    const { trace } = await import('@opentelemetry/api');
    const span = trace.getActiveSpan();
    if (span) { span.setAttribute('test.id', result.testId); span.setAttribute('test.url', result.targetUrl); }

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
