declare global {
  interface LayoutShift extends PerformanceEntry {
    value: number;
    hadRecentInput: boolean;
  }

  interface ExtendedPerformanceEventTiming  extends PerformanceEventTiming  {
    processingStart: number;
  }
}
import amqplib from 'amqplib';
import puppeteer from 'puppeteer';

import { TestRequest, TestResult, ClientMetrics } from '@alt/shared';

const QUEUE = 'client-tests';
const RESULTS_QUEUE = 'test-results';

const runClientTest = async (test: TestRequest): Promise<ClientMetrics> => {
  console.log(`Launching browser for: ${test.targetUrl}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const metricsAccumulator: ClientMetrics[] = [];
  const options = test.options as { sessions: number; duration: string };
  const sessions = options.sessions || 1;

  for (let i = 0; i < sessions; i++) {
    console.log(`Running session ${i + 1}/${sessions}`);
    const page = await browser.newPage();

    // Збираємо Web Vitals через CDP (Chrome DevTools Protocol)
    const client = await page.createCDPSession();
    await client.send('Performance.enable');

    const startTime = Date.now();
    await page.goto(test.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const ttfb = Date.now() - startTime;

    // Отримуємо Performance метрики
    const perfMetrics = await client.send('Performance.getMetrics');
    const metrics = perfMetrics.metrics;

   const getValue = (name: string): number =>
  metrics.find((m: { name: string; value: number }) => m.name === name)?.value ?? 0;

    // Збираємо Web Vitals через JavaScript
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
            if (entry.name === 'first-contentful-paint') {
              fcp = entry.startTime;
            }
          }
        }).observe({ type: 'paint', buffered: true });

        // Даємо час на збір метрик
        setTimeout(() => resolve({ lcp, fid, cls, fcp }), 3000);
      });
    });

    metricsAccumulator.push({
      type: 'client',
      lcp: webVitals.lcp,
      fid: webVitals.fid,
      cls: webVitals.cls,
      ttfb,
      fcp: webVitals.fcp
    });

    await page.close();
    console.log(`Session ${i + 1} metrics:`, metricsAccumulator[i]);
  }

  await browser.close();

  // Усереднюємо метрики по всіх сесіях
  const avg = (key: keyof Omit<ClientMetrics, 'type'>): number => {
    const sum = metricsAccumulator.reduce((s, m) => s + m[key], 0);
    return Math.round((sum / metricsAccumulator.length) * 100) / 100;
  };

  return {
    type: 'client',
    lcp: avg('lcp'),
    fid: avg('fid'),
    cls: avg('cls'),
    ttfb: avg('ttfb'),
    fcp: avg('fcp')
  };
};

const start = async (): Promise<void> => {
  const url = process.env.RABBITMQ_URL || 'amqp://alt_user:alt_password@localhost:5672';
  const maxRetries = 10;
  const delay = 5000;

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

  console.log('Worker-client listening on queue:', QUEUE);

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const test: TestRequest = JSON.parse(msg.content.toString());
    console.log(`Received client test: ${test.id} — ${test.targetUrl}`);

    try {
      const metrics = await runClientTest(test);

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
        Buffer.from(JSON.stringify(result)),
        { persistent: true }
      );

      console.log('Client test completed:', JSON.stringify(metrics, null, 2));
      channel.ack(msg);
    } catch (err) {
      console.error('Client test failed:', err);
      channel.nack(msg, false, false);
    }
  });
};

start().catch(console.error);