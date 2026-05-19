declare global {
  interface LayoutShift extends PerformanceEntry {
    value: number;
    hadRecentInput: boolean;
  }

  interface ExtendedPerformanceEventTiming extends PerformanceEventTiming {
    processingStart: number;
  }
}

import amqplib from 'amqplib';
import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import Fastify from 'fastify';

import { TestRequest, TestResult, ClientMetrics, LighthouseScore } from '@alt/shared';
import { log } from './logger';

const QUEUE              = 'client-tests';
const CANCEL_EXCHANGE    = 'cancel-fanout';
let queueConnected = false;
const RESULTS_QUEUE      = 'test-results';
const DLQ                = `${QUEUE}.dlq`;
const MAX_RETRIES        = 3;
const MAX_TEST_DURATION_MS = parseInt(process.env.PUPPETEER_MAX_DURATION_MS ?? '300000'); // 5 min
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '2');

import { Browser } from 'puppeteer';
const runningBrowsers  = new Map<string, Browser>();
const cancelledTests   = new Set<string>();

// Web Vitals without the optional lighthouse field (for per-session accumulation)
type WebVitalsSnapshot = Omit<ClientMetrics, 'type' | 'lighthouseScore'>;

// r1: retry helper
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

const runClientTest = async (test: TestRequest): Promise<ClientMetrics> => {
  const testLog = log.child({ testId: test.id, targetUrl: test.targetUrl });
  testLog.info('Launching browser');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  // r2: track browser for cancellation; r4: hard timeout
  runningBrowsers.set(test.id, browser);
  const killTimer = setTimeout(async () => {
    log.warn({ testId: test.id, maxMs: MAX_TEST_DURATION_MS }, 'Puppeteer test exceeded max duration, closing browser');
    await browser.close().catch(() => {});
  }, MAX_TEST_DURATION_MS);

  const snapshots: WebVitalsSnapshot[] = [];
  const options = test.options as { sessions: number; duration: string };
  const sessions = options.sessions || 1;

  // ── Puppeteer sessions: collect Web Vitals ───────────────────────────────
  for (let i = 0; i < sessions; i++) {
    testLog.info({ session: i + 1, sessions }, 'Running session');
    const page = await browser.newPage();

    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');

    const startTime = Date.now();
    await page.goto(test.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const ttfb = Date.now() - startTime;

    const webVitals = await page.evaluate(() => {
      return new Promise<{ lcp: number; fid: number; cls: number; fcp: number }>((resolve) => {
        let lcp = 0;
        let fid = 0;
        let cls = 0;
        let fcp = 0;

        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          lcp = entries[entries.length - 1].startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });

        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const e = entry as ExtendedPerformanceEventTiming;
            fid = e.processingStart - e.startTime;
          }
        }).observe({ type: 'first-input', buffered: true });

        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const e = entry as LayoutShift;
            if (!e.hadRecentInput) cls += e.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });

        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') fcp = entry.startTime;
          }
        }).observe({ type: 'paint', buffered: true });

        setTimeout(() => resolve({ lcp, fid, cls, fcp }), 3000);
      });
    });

    snapshots.push({ lcp: webVitals.lcp, fid: webVitals.fid, cls: webVitals.cls, ttfb, fcp: webVitals.fcp });
    await page.close();
    testLog.info({ session: i + 1, metrics: snapshots[i] }, 'Session complete');
  }

  // ── Lighthouse audit — reuses the same Chrome instance via CDP port ──────
  let lighthouseScore: LighthouseScore | undefined;
  try {
    // Close all remaining pages so Lighthouse gets a clean state
    const openPages = await browser.pages();
    await Promise.all(openPages.map((p) => p.close()));

    const wsEndpoint = browser.wsEndpoint();
    const port = parseInt(new URL(wsEndpoint).port, 10);

    testLog.info({ port }, 'Running Lighthouse');
    const lhResult = await lighthouse(test.targetUrl, {
      port,
      output: 'json' as const,
      logLevel: 'silent' as const,
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });

    if (lhResult?.lhr?.categories) {
      const cats = lhResult.lhr.categories;
      lighthouseScore = {
        performance:   Math.round((cats['performance']?.score   ?? 0) * 100),
        accessibility: Math.round((cats['accessibility']?.score ?? 0) * 100),
        bestPractices: Math.round((cats['best-practices']?.score ?? 0) * 100),
        seo:           Math.round((cats['seo']?.score           ?? 0) * 100),
      };
      testLog.info({ lighthouseScore }, 'Lighthouse complete');
    }
  } catch (err) {
    testLog.error({ err: (err as Error).message }, 'Lighthouse audit failed (non-fatal)');
  }

  clearTimeout(killTimer);
  runningBrowsers.delete(test.id);
  await browser.close();

  // ── Average Web Vitals across sessions ───────────────────────────────────
  const avg = (key: keyof WebVitalsSnapshot): number => {
    const sum = snapshots.reduce((s, m) => s + m[key], 0);
    return Math.round((sum / snapshots.length) * 100) / 100;
  };

  return {
    type: 'client',
    lcp:  avg('lcp'),
    fid:  avg('fid'),
    cls:  avg('cls'),
    ttfb: avg('ttfb'),
    fcp:  avg('fcp'),
    lighthouseScore,
  };
};

const start = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');
  const maxRetries = 10;
  const delay = 5000;

  let connection;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info({ attempt, maxRetries }, 'Connecting to RabbitMQ');
      connection = await amqplib.connect(url);
      break;
    } catch (err) {
      log.error({ attempt, err: (err as Error).message }, 'RabbitMQ connection failed');
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const channel = await connection!.createChannel();
  await channel.assertQueue(QUEUE,         { durable: true });
  await channel.assertQueue(DLQ,           { durable: true });
  await channel.assertQueue(RESULTS_QUEUE, { durable: true });

  // s1: exclusive cancel queue per replica bound to fanout exchange
  await channel.assertExchange(CANCEL_EXCHANGE, 'fanout', { durable: true });
  const { queue: cancelQueue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
  await channel.bindQueue(cancelQueue, CANCEL_EXCHANGE, '');

  queueConnected = true;
  channel.prefetch(WORKER_CONCURRENCY);
  log.info({ queue: QUEUE, concurrency: WORKER_CONCURRENCY }, 'Worker-client listening');

  // r2: cancel consumer — closes running Puppeteer browser by testId
  channel.consume(cancelQueue, async (msg) => {
    if (!msg) return;
    const { testId } = JSON.parse(msg.content.toString()) as { testId: string };
    const browser = runningBrowsers.get(testId);
    if (browser) {
      log.info({ testId }, 'Cancelling client test');
      cancelledTests.add(testId);
      await browser.close().catch(() => {});
    }
    channel.ack(msg);
  }, { noAck: false });

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const test: TestRequest = JSON.parse(msg.content.toString());
    log.info({ testId: test.id, targetUrl: test.targetUrl }, 'Received client test');

    try {
      const resultsUrl = process.env.RESULTS_URL || 'http://results-service:3004';
      fetch(`${resultsUrl}/results/${test.id}/running`, { method: 'POST' }).catch(() => {});

      const metrics = await runClientTest(test);

      // r2: check if cancelled while running
      if (cancelledTests.has(test.id)) {
        cancelledTests.delete(test.id);
        log.info({ testId: test.id }, 'Client test cancelled during execution');
        channel.ack(msg);
        return;
      }

      const result: TestResult = {
        testId: test.id,
        targetUrl: test.targetUrl,
        status: 'completed',
        metrics,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      channel.sendToQueue(RESULTS_QUEUE, Buffer.from(JSON.stringify({ ...result, thresholds: test.thresholds })), { persistent: true });
      log.info({ testId: test.id, metrics }, 'Client test completed');
      channel.ack(msg);
    } catch (err) {
      log.error({ testId: test.id, err: (err as Error).message }, 'Client test failed');
      handleRetry(channel, msg, QUEUE, DLQ, test.id);
    }
  });
};

const startHealthServer = async () => {
  const app = Fastify({ logger: false });
  app.get('/health', async (_req, reply) => {
    const healthy = queueConnected;
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'worker-client',
      checks: { queue: healthy ? 'ok' : 'disconnected' },
      timestamp: new Date().toISOString(),
    });
  });
  const port = Number(process.env.PORT) || 3003;
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'Worker-client health server listening');
};

startHealthServer().catch(err => log.error({ err: (err as Error).message }, 'Health server failed'));
start().catch(err => log.error({ err: (err as Error).message }, 'Worker-client startup failed'));
