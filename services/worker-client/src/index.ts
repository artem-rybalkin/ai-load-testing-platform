declare global {
  interface LayoutShift extends PerformanceEntry {
    value: number;
    hadRecentInput: boolean;
  }

  interface ExtendedPerformanceEventTiming extends PerformanceEventTiming {
    processingStart: number;
  }
}

import './tracing';
import amqplib from 'amqplib';
import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import Fastify from 'fastify';
import * as os from 'os';

import { TestRequest, TestResult, ClientMetrics, LighthouseScore, ResourceBreakdown, connectWithBackoff, stripAnsi, internalHeaders } from '@alt/shared';
import { log } from './logger';
import { handleRetry, MAX_RETRIES } from './retry';

const QUEUE              = 'client-tests';
const CANCEL_EXCHANGE    = 'cancel-fanout';
let queueConnected = false;
let reconnecting = false;
let connection: amqplib.Connection | null = null;
let channel: amqplib.Channel | null = null;

// Rolling CPU usage sampled every 5 seconds
let cpuPercent = 0;
let _lastCpu = process.cpuUsage();
let _lastCpuTime = Date.now();
setInterval(() => {
  const delta = process.cpuUsage(_lastCpu);
  const elapsed = (Date.now() - _lastCpuTime) * 1000;
  cpuPercent = elapsed > 0 ? Math.min(100, Math.round(((delta.user + delta.system) / elapsed) * 100)) : 0;
  _lastCpu = process.cpuUsage();
  _lastCpuTime = Date.now();
}, 5000);
const RESULTS_QUEUE      = 'test-results';
const DLQ                = `${QUEUE}.dlq`;
const MAX_TEST_DURATION_MS = parseInt(process.env.PUPPETEER_MAX_DURATION_MS ?? '300000'); // 5 min
const NAV_TIMEOUT_MS = parseInt(process.env.PUPPETEER_NAV_TIMEOUT_MS ?? '60000'); // 1 min
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '2');

import { Browser } from 'puppeteer';
const runningBrowsers  = new Map<string, Browser>();
const cancelledTests   = new Set<string>();

// Web Vitals without the optional lighthouse field (for per-session accumulation)
type WebVitalsSnapshot = Omit<ClientMetrics, 'type' | 'lighthouseScore'>;

// r1: retry helper imported from ./retry

// ── Per-session metric aggregation (exported for unit testing) ─────────────────

// Averages a numeric Web Vitals field across session snapshots, rounded to 2 decimals.
// Returns 0 for an empty snapshots array (division by zero -> NaN -> handled by caller checks).
export const avgNum = (
  snapshots: WebVitalsSnapshot[],
  key: 'lcp' | 'fid' | 'cls' | 'ttfb' | 'fcp' | 'inp' | 'longTaskCount'
): number => {
  if (snapshots.length === 0) return 0;
  const sum = snapshots.reduce((s, m) => s + (m[key] ?? 0), 0);
  return Math.round((sum / snapshots.length) * 100) / 100;
};

// Averages resourceBreakdown across sessions that have one, rounded to 1 decimal.
// Returns undefined if no session has a resourceBreakdown.
export const avgResourceBreakdown = (snapshots: WebVitalsSnapshot[]): ResourceBreakdown | undefined => {
  const valid = snapshots.filter(s => s.resourceBreakdown);
  if (!valid.length) return undefined;
  const keys: Array<keyof ResourceBreakdown> = ['jsSize', 'cssSize', 'imageSize', 'fontSize', 'xhrSize', 'totalSize', 'requestCount'];
  const result = {} as ResourceBreakdown;
  for (const k of keys) {
    const sum = valid.reduce((s, m) => s + (m.resourceBreakdown?.[k] ?? 0), 0);
    result[k] = Math.round((sum / valid.length) * 10) / 10;
  }
  return result;
};

// ── Execution log helpers ─────────────────────────────────────────────────────

const RESULTS_URL = process.env.RESULTS_URL || 'http://results-service:3004';

const MAX_LOG_LINES = 5000;
const MAX_LOG_BYTES = 100 * 1024; // 100 KB — mirrors worker-backend cap

const postLogLine = async (testId: string, level: string, line: string): Promise<void> => {
  try {
    await fetch(`${RESULTS_URL}/results/${testId}/log-line`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ level, line }),
    });
  } catch { /* best-effort */ }
};

const runClientTest = async (test: TestRequest): Promise<{ metrics: ClientMetrics; executionLog: string }> => {
  const testLog = log.child({ testId: test.id, targetUrl: test.targetUrl });
  testLog.info('Launching browser');

  const postMessage = (message: string): Promise<Response | void> =>
    fetch(`${RESULTS_URL}/results/${test.id}/message`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message }),
    }).catch((err: Error) => testLog.debug({ err: err.message }, 'postMessage delivery failed'));

  // Execution log accumulation (capped at MAX_LOG_LINES / MAX_LOG_BYTES)
  const logLines: string[] = [];
  let logBytes = 0;
  const addLog = (level: string, text: string): void => {
    const clean = stripAnsi(text).trimEnd();
    if (!clean || logLines.length >= MAX_LOG_LINES || logBytes >= MAX_LOG_BYTES) return;
    logLines.push(`[${level}] ${clean}`);
    logBytes += level.length + Buffer.byteLength(clean, 'utf8') + 3;
    postLogLine(test.id, level, clean).catch(() => {});
  };

  addLog('INFO', `Starting browser test: ${test.targetUrl}`);

  let pageLoadCount = 0;

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

  // Work around a lighthouse bug: its isBundledEnvironment() check (lighthouse/core/lib/page-functions.js)
  // mis-detects a normal npm install as not needing an esbuild __name() polyfill in the page, but
  // lighthouse's own published files ARE esbuild-bundled with keepNames, so functions it serializes
  // and evaluates in the page (e.g. truncate, getNodeLabel) still reference __name and throw
  // "ReferenceError: __name is not defined". Pre-define it on every page (current + future, since
  // lighthouse closes our pages and opens its own) before lighthouse ever runs.
  const NAME_POLYFILL = 'globalThis.__name = globalThis.__name || ((fn, value) => { try { Object.defineProperty(fn, "name", { value, configurable: true }); } catch { /* ignore */ } return fn; });';
  browser.on('targetcreated', async (target) => {
    const newPage = await target.page().catch(() => null);
    if (newPage) await newPage.evaluateOnNewDocument(NAME_POLYFILL).catch(() => {});
  });
  for (const existingPage of await browser.pages()) {
    await existingPage.evaluateOnNewDocument(NAME_POLYFILL).catch(() => {});
  }

  try {
    const snapshots: WebVitalsSnapshot[] = [];
    const options = test.options as { sessions: number; duration: string; headers?: Record<string, string> };
    const sessions = options.sessions || 1;
  
    let totalJsErrors = 0;
  
    // ── Puppeteer sessions: collect Web Vitals ───────────────────────────────
    for (let i = 0; i < sessions; i++) {
      testLog.info({ session: i + 1, sessions }, 'Running session');
      await postMessage(`Running browser session ${i + 1} of ${sessions}…`);
      const page = await browser.newPage();

      addLog('INFO', `[session ${i + 1}/${sessions}] Navigating to ${test.targetUrl}`);

      let sessionJsErrors = 0;
      page.on('pageerror', (err) => {
        sessionJsErrors++;
        addLog('ERROR', `[session ${i + 1}] pageerror: ${err.message}`);
      });
      page.on('console', (msg) => {
        const t = msg.type();
        const level = t === 'error' ? 'ERROR' : t === 'warn' ? 'WARN' : 'DEBUG';
        addLog(level, `[session ${i + 1}] [browser] ${msg.text()}`);
      });

      const cdp = await page.createCDPSession();
      await cdp.send('Performance.enable');

      if (options.headers && Object.keys(options.headers).length > 0) {
        await page.setExtraHTTPHeaders(options.headers);
      }

      await page.goto(test.targetUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      pageLoadCount++;
      // True TTFB = responseStart - requestStart from Navigation Timing API.
      // The old wall-clock approach included DNS + TCP + TLS + networkidle2 settle time.
      const ttfb = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        return nav ? Math.round(nav.responseStart - nav.requestStart) : 0;
      });
  
      const webVitals = await page.evaluate(() => {
        return new Promise<{ lcp: number; fid: number; cls: number; fcp: number; inp: number; longTaskCount: number }>((resolve) => {
          let lcp = 0;
          let fid = 0;
          let cls = 0;
          let fcp = 0;
          let inp = 0;
          let longTaskCount = 0;
  
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
  
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                const e = entry as ExtendedPerformanceEventTiming;
                const duration = e.processingStart - e.startTime;
                if (duration > inp) inp = duration;
              }
            }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
          } catch { /* event type unsupported */ }
  
          try {
            new PerformanceObserver((list) => {
              longTaskCount += list.getEntries().length;
            }).observe({ type: 'longtask', buffered: true });
          } catch { /* longtask type unsupported */ }
  
          setTimeout(() => resolve({ lcp, fid, cls, fcp, inp, longTaskCount }), 3000);
        });
      });
  
      const resourceBreakdown = await page.evaluate((): ResourceBreakdown => {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const bd = { jsSize: 0, cssSize: 0, imageSize: 0, fontSize: 0, xhrSize: 0, totalSize: 0, requestCount: entries.length };
        for (const e of entries) {
          const kb = (e.transferSize || 0) / 1024;
          bd.totalSize += kb;
          if (e.initiatorType === 'script') bd.jsSize += kb;
          else if (e.initiatorType === 'link' || e.initiatorType === 'css') bd.cssSize += kb;
          else if (e.initiatorType === 'img') bd.imageSize += kb;
          else if (e.initiatorType === 'font' || /\.(woff2?|ttf|otf|eot)/i.test(e.name)) bd.fontSize += kb;
          else if (e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'fetch') bd.xhrSize += kb;
        }
        return {
          jsSize: Math.round(bd.jsSize * 10) / 10,
          cssSize: Math.round(bd.cssSize * 10) / 10,
          imageSize: Math.round(bd.imageSize * 10) / 10,
          fontSize: Math.round(bd.fontSize * 10) / 10,
          xhrSize: Math.round(bd.xhrSize * 10) / 10,
          totalSize: Math.round(bd.totalSize * 10) / 10,
          requestCount: bd.requestCount,
        };
      });
  
      totalJsErrors += sessionJsErrors;
      snapshots.push({ lcp: webVitals.lcp, fid: webVitals.fid, cls: webVitals.cls, ttfb, fcp: webVitals.fcp, inp: webVitals.inp, longTaskCount: webVitals.longTaskCount, resourceBreakdown });
      await page.close();
      testLog.info({ session: i + 1, metrics: snapshots[i] }, 'Session complete');
      addLog('INFO', `[session ${i + 1}/${sessions}] Complete — LCP ${Math.round(webVitals.lcp)}ms FCP ${Math.round(webVitals.fcp)}ms TTFB ${ttfb}ms CLS ${webVitals.cls.toFixed(3)}${sessionJsErrors > 0 ? ` jsErrors=${sessionJsErrors}` : ''}`);
    }
  
    // ── Lighthouse audit — reuses the same Chrome instance via CDP port ──────
    let lighthouseScore: LighthouseScore | undefined;
    let lhTbt: number | undefined;
    let lhTti: number | undefined;
    let lhInp: number | undefined;
    let lhDomNodes: number | undefined;
    try {
      // Close all remaining pages so Lighthouse gets a clean state
      const openPages = await browser.pages();
      await Promise.all(openPages.map((p) => p.close()));
  
      const wsEndpoint = browser.wsEndpoint();
      const port = parseInt(new URL(wsEndpoint).port, 10);
  
      testLog.info({ port }, 'Running Lighthouse');
      await postMessage('Running Lighthouse audit…');
      pageLoadCount++;
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
      }
      if (lhResult?.lhr?.audits) {
        const a = lhResult.lhr.audits as Record<string, { numericValue?: number }>;
        lhTbt      = a['total-blocking-time']?.numericValue != null ? Math.round(a['total-blocking-time'].numericValue) : undefined;
        lhTti      = a['interactive']?.numericValue        != null ? Math.round(a['interactive'].numericValue)         : undefined;
        lhInp      = a['interaction-to-next-paint']?.numericValue != null ? Math.round(a['interaction-to-next-paint'].numericValue) : undefined;
        lhDomNodes = a['dom-size']?.numericValue           != null ? Math.round(a['dom-size'].numericValue)            : undefined;
      }
      testLog.info({ lighthouseScore, lhTbt, lhTti, lhInp, lhDomNodes }, 'Lighthouse complete');
      if (lighthouseScore) {
        addLog('INFO', `Lighthouse complete — perf=${lighthouseScore.performance} a11y=${lighthouseScore.accessibility} bp=${lighthouseScore.bestPractices} seo=${lighthouseScore.seo}${lhTbt != null ? ` TBT=${lhTbt}ms` : ''}${lhInp != null ? ` INP=${lhInp}ms` : ''}`);
      }
    } catch (err) {
      testLog.error({ err: (err as Error).message }, 'Lighthouse audit failed (non-fatal)');
      addLog('WARN', `Lighthouse audit failed (non-fatal): ${(err as Error).message}`);
    }
  
    // ── Average Web Vitals across sessions ───────────────────────────────────
    // INP: prefer Lighthouse audit value (more accurate); fall back to PerformanceObserver average
    const avgInp = avgNum(snapshots, 'inp');
    const inpValue = lhInp ?? (avgInp > 0 ? avgInp : undefined);
    const avgLongTaskCount = avgNum(snapshots, 'longTaskCount');

    return {
      metrics: {
        type: 'client',
        lcp:              avgNum(snapshots, 'lcp'),
        fid:              avgNum(snapshots, 'fid'),
        cls:              avgNum(snapshots, 'cls'),
        ttfb:             avgNum(snapshots, 'ttfb'),
        fcp:              avgNum(snapshots, 'fcp'),
        inp:              inpValue,
        tbt:              lhTbt,
        tti:              lhTti,
        jsErrors:         totalJsErrors > 0 ? totalJsErrors : undefined,
        longTaskCount:    avgLongTaskCount > 0 ? Math.round(avgLongTaskCount) : undefined,
        domNodeCount:     lhDomNodes,
        pageLoadCount,
        resourceBreakdown: avgResourceBreakdown(snapshots),
        lighthouseScore,
      },
      executionLog: logLines.join('\n'),
    };
  } catch (err) {
    (err as Error & { partialLog?: string }).partialLog = logLines.join('\n');
    throw err;
  } finally {
    clearTimeout(killTimer);
    runningBrowsers.delete(test.id);
    await browser.close().catch(() => {});
  }
};

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
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL environment variable is required');

  connection = await connectWithBackoff(() => amqplib.connect(url), {
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

  channel = await connection.createChannel();
  channel.on('error', (err) => {
    log.error({ err: (err as Error).message }, 'RabbitMQ channel error');
    queueConnected = false;
  });
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
      fetch(`${resultsUrl}/results/${test.id}/running`, { method: 'POST', headers: internalHeaders() }).catch(() => {});

      const { metrics, executionLog } = await runClientTest(test);

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

      channel.sendToQueue(RESULTS_QUEUE, Buffer.from(JSON.stringify({ ...result, thresholds: test.thresholds, projectId: test.projectId, executionLog })), { persistent: true });
      log.info({ testId: test.id, metrics }, 'Client test completed');
      channel.ack(msg);
    } catch (err) {
      log.error({ testId: test.id, err: (err as Error).message }, 'Client test failed');
      const retryCount = Number(msg.properties.headers?.['x-retry-count'] ?? 0);
      if (retryCount >= MAX_RETRIES) {
        const partialLog = (err as { partialLog?: string }).partialLog;
        fetch(`${RESULTS_URL}/results/${test.id}/fail`, {
          method: 'POST',
          headers: internalHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ executionLog: partialLog ?? null }),
        }).catch(() => {});
      }
      handleRetry(channel, msg, QUEUE, DLQ, test.id);
    }
  });
};

const startHealthServer = async (): Promise<void> => {
  const app = Fastify({ logger: false });
  app.get('/health', async (_req, reply) => {
    const checks: Record<string, string> = {};
    checks.queue = queueConnected ? 'ok' : 'disconnected';

    const mem = process.memoryUsage();
    const memoryMb = Math.round(mem.rss / 1024 / 1024);
    const memoryPercent = Math.round(mem.rss / os.totalmem() * 100);
    const activeTests = runningBrowsers.size;
    const saturated = activeTests >= WORKER_CONCURRENCY && WORKER_CONCURRENCY > 0;
    if (saturated) checks.capacity = 'saturated';

    const status = !queueConnected ? 'degraded' : saturated ? 'saturated' : 'ok';
    return reply.code(queueConnected ? 200 : 503).send({
      status,
      service: 'worker-client',
      checks,
      metrics: { cpuPercent, memoryMb, memoryPercent, activeTests, maxTests: WORKER_CONCURRENCY },
      timestamp: new Date().toISOString(),
    });
  });
  const port = Number(process.env.PORT) || 3003;
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'Worker-client health server listening');
};

startHealthServer().catch(err => log.error({ err: (err as Error).message }, 'Health server failed'));
start().catch(err => log.error({ err: (err as Error).message }, 'Worker-client startup failed'));

async function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down gracefully');
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (_) { /* ignore close errors during shutdown */ }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
