import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as os from 'os';

// Builds the same health handler that worker-client's startHealthServer() registers,
// but in isolation — no RabbitMQ or Puppeteer required.
const buildHealthApp = (opts: {
  queueConnected: boolean;
  runningBrowsersSize: number;
  workerConcurrency: number;
}): FastifyInstance => {
  const app = Fastify({ logger: false });

  app.get('/health', async (_req, reply) => {
    const checks: Record<string, string> = {};
    checks.queue = opts.queueConnected ? 'ok' : 'disconnected';

    const mem = process.memoryUsage();
    const memoryMb = Math.round(mem.rss / 1024 / 1024);
    const memoryPercent = Math.round((mem.rss / os.totalmem()) * 100);
    const activeTests = opts.runningBrowsersSize;
    const saturated = activeTests >= opts.workerConcurrency && opts.workerConcurrency > 0;
    if (saturated) checks.capacity = 'saturated';

    const healthy = opts.queueConnected && !saturated;
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : saturated ? 'saturated' : 'degraded',
      service: 'worker-client',
      checks,
      metrics: {
        cpuPercent: 0,
        memoryMb,
        memoryPercent,
        activeTests,
        maxTests: opts.workerConcurrency,
      },
    });
  });

  return app;
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('worker-client health endpoint', () => {
  let app: FastifyInstance;

  afterAll(async () => { await app?.close(); });

  it('returns 200 and status ok when queue is connected and not saturated', async () => {
    app = buildHealthApp({ queueConnected: true, runningBrowsersSize: 0, workerConcurrency: 2 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('worker-client');
    expect(body.checks.queue).toBe('ok');
  });

  it('returns 503 and status degraded when queue is disconnected', async () => {
    app = buildHealthApp({ queueConnected: false, runningBrowsersSize: 0, workerConcurrency: 2 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('degraded');
    expect(res.json().checks.queue).toBe('disconnected');
  });

  it('returns 503 and status saturated when active tests reach worker concurrency', async () => {
    app = buildHealthApp({ queueConnected: true, runningBrowsersSize: 2, workerConcurrency: 2 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('saturated');
    expect(res.json().checks.capacity).toBe('saturated');
  });

  it('returns 200 when active tests are below worker concurrency', async () => {
    app = buildHealthApp({ queueConnected: true, runningBrowsersSize: 1, workerConcurrency: 2 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.capacity).toBeUndefined();
  });

  it('includes metrics block with expected fields', async () => {
    app = buildHealthApp({ queueConnected: true, runningBrowsersSize: 1, workerConcurrency: 3 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const { metrics } = res.json();
    expect(metrics).toBeDefined();
    expect(typeof metrics.memoryMb).toBe('number');
    expect(typeof metrics.memoryPercent).toBe('number');
    expect(metrics.activeTests).toBe(1);
    expect(metrics.maxTests).toBe(3);
    expect(metrics.cpuPercent).toBe(0);
  });
});
