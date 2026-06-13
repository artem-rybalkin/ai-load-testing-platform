import { describe, it, expect, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as os from 'os';

/**
 * Builds the same health handler that worker-backend's startHealthServer()
 * registers (services/worker-backend/src/index.ts), in isolation — no real
 * Postgres or RabbitMQ required. `dbOk` simulates `pool.query('SELECT 1')`
 * succeeding/throwing.
 */
const buildHealthApp = (opts: {
  dbOk: boolean;
  queueConnected: boolean;
  activeTests: number;
  workerConcurrency: number;
  cpuPercent?: number;
}): FastifyInstance => {
  const app = Fastify({ logger: false });

  app.get('/health', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    if (opts.dbOk) checks.database = 'ok';
    else { checks.database = 'error'; healthy = false; }

    checks.queue = opts.queueConnected ? 'ok' : 'disconnected';
    if (!opts.queueConnected) healthy = false;

    const mem = process.memoryUsage();
    const memoryMb = Math.round(mem.rss / 1024 / 1024);
    const memoryPercent = Math.round(mem.rss / os.totalmem() * 100);
    const activeTests = opts.activeTests;
    const saturated = activeTests >= opts.workerConcurrency && opts.workerConcurrency > 0;
    if (saturated) checks.capacity = 'saturated';

    const status = !healthy ? 'degraded' : saturated ? 'saturated' : 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status,
      service: 'worker-backend',
      checks,
      metrics: {
        cpuPercent: opts.cpuPercent ?? 0,
        memoryMb,
        memoryPercent,
        activeTests,
        maxTests: opts.workerConcurrency,
      },
      timestamp: new Date().toISOString(),
    });
  });

  return app;
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('worker-backend health endpoint', () => {
  let app: FastifyInstance;

  afterAll(async () => { await app?.close(); });

  it('returns 200 and status ok when DB and queue are healthy and not saturated', async () => {
    app = buildHealthApp({ dbOk: true, queueConnected: true, activeTests: 0, workerConcurrency: 1 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('worker-backend');
    expect(body.checks.database).toBe('ok');
    expect(body.checks.queue).toBe('ok');
    expect(body.checks.capacity).toBeUndefined();
  });

  it('returns 503 and status degraded when the DB check fails', async () => {
    app = buildHealthApp({ dbOk: false, queueConnected: true, activeTests: 0, workerConcurrency: 1 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('error');
  });

  it('returns 503 and status degraded when the queue is disconnected', async () => {
    app = buildHealthApp({ dbOk: true, queueConnected: false, activeTests: 0, workerConcurrency: 1 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.queue).toBe('disconnected');
  });

  it('returns 200 and status saturated when activeTests >= WORKER_CONCURRENCY but DB/queue are healthy', async () => {
    app = buildHealthApp({ dbOk: true, queueConnected: true, activeTests: 1, workerConcurrency: 1 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    // healthy=true (DB ok, queue ok) -> code 200, but status reflects saturation
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('saturated');
    expect(body.checks.capacity).toBe('saturated');
  });

  it('does not mark saturated when WORKER_CONCURRENCY is 0 (disabled check)', async () => {
    app = buildHealthApp({ dbOk: true, queueConnected: true, activeTests: 5, workerConcurrency: 0 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.capacity).toBeUndefined();
  });

  it('includes a metrics block with the expected fields', async () => {
    app = buildHealthApp({ dbOk: true, queueConnected: true, activeTests: 2, workerConcurrency: 4, cpuPercent: 37 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const { metrics } = res.json();
    expect(metrics).toBeDefined();
    expect(typeof metrics.memoryMb).toBe('number');
    expect(typeof metrics.memoryPercent).toBe('number');
    expect(metrics.activeTests).toBe(2);
    expect(metrics.maxTests).toBe(4);
    expect(metrics.cpuPercent).toBe(37);
  });

  it('prioritizes degraded over saturated when both DB failure and saturation occur', async () => {
    app = buildHealthApp({ dbOk: false, queueConnected: true, activeTests: 5, workerConcurrency: 1 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.capacity).toBe('saturated');
  });
});
