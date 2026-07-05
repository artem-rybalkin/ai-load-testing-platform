/**
 * Unit tests for worker-client/src/index.ts — its own responsibilities:
 * connection/channel lifecycle (reconnect on close/error), queue setup, the
 * real /health route, and the Stop-button cancel orchestration in the real
 * queue consumer. Puppeteer execution itself (runClientTest) is mocked —
 * that's runner.test.ts's job; handleRetry's own behavior is retry.test.ts's
 * job (kept real here, not mocked, so this file verifies index.ts actually
 * wires it up correctly on failure).
 *
 * Supersedes health.test.ts, which hand-reimplemented the /health handler
 * as a parallel Fastify app instead of testing the real exported `app` —
 * that reimplementation could silently drift from src/index.ts without
 * failing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { TestRequest, ClientMetrics } from '@alt/shared';

process.env.RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://placeholder:placeholder@localhost:5672';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

const mockConnect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ default: { connect: mockConnect } }));

const mockRunClientTest = vi.hoisted(() => vi.fn());
vi.mock('../runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner')>();
  return { ...actual, runClientTest: mockRunClientTest };
});

vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('../tracing', () => ({}));

// ── Fakes ────────────────────────────────────────────────────────────────

type FakeChannel = EventEmitter & {
  assertQueue: MockFn; assertExchange: MockFn; bindQueue: MockFn; consume: MockFn;
  ack: MockFn; sendToQueue: MockFn; publish: MockFn; prefetch: MockFn; cancel: MockFn;
};

function makeFakeChannel(): FakeChannel {
  const ch = new EventEmitter() as FakeChannel;
  ch.assertQueue    = vi.fn().mockResolvedValue({ queue: 'cancel-queue-name' });
  ch.assertExchange = vi.fn().mockResolvedValue(undefined);
  ch.bindQueue      = vi.fn().mockResolvedValue(undefined);
  ch.consume        = vi.fn().mockResolvedValue({ consumerTag: 'tag-1' });
  ch.ack            = vi.fn();
  ch.sendToQueue    = vi.fn();
  ch.publish        = vi.fn();
  ch.prefetch       = vi.fn();
  ch.cancel         = vi.fn().mockResolvedValue(undefined);
  return ch;
}

type FakeConnection = EventEmitter & { createChannel: MockFn; close: MockFn };

function makeFakeConnection(channel: FakeChannel): FakeConnection {
  const conn = new EventEmitter() as FakeConnection;
  conn.createChannel = vi.fn().mockResolvedValue(channel);
  conn.close = vi.fn().mockResolvedValue(undefined);
  return conn;
}

const makeMsg = (body: unknown): { content: Buffer; properties: { headers: Record<string, unknown> } } => ({
  content: Buffer.from(JSON.stringify(body)),
  properties: { headers: {} },
});

const makeTest = (overrides: Partial<TestRequest> = {}): TestRequest => ({
  id:          'test-id',
  type:        'client-side',
  targetUrl:   'https://example.com',
  description: 'browser test',
  options:     { sessions: 1, duration: '1m', collectWebVitals: true },
  createdAt:   '2025-01-01T00:00:00Z',
  ...overrides,
});

const makeMetrics = (): ClientMetrics => ({
  type: 'client', lcp: 100, fid: 0, cls: 0, ttfb: 50, fcp: 80,
});

describe('worker-client index.ts', () => {
  let channel: FakeChannel;
  let connection: FakeConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    channel = makeFakeChannel();
    connection = makeFakeConnection(channel);
    mockConnect.mockResolvedValue(connection);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { app } = await import('../index');
    await app.close();
  });

  // ── Queue setup ──────────────────────────────────────────────────────────

  it('asserts the work/DLQ/results queues as durable and sets prefetch', async () => {
    process.env.WORKER_CONCURRENCY = '3';
    const { start } = await import('../index');
    await start();

    expect(channel.assertQueue).toHaveBeenCalledWith('client-tests', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('client-tests.dlq', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('test-results', { durable: true });
    expect(channel.prefetch).toHaveBeenCalledWith(3);
    delete process.env.WORKER_CONCURRENCY;
  });

  it('binds an exclusive auto-delete queue to the cancel-fanout exchange', async () => {
    const { start } = await import('../index');
    await start();

    expect(channel.assertExchange).toHaveBeenCalledWith('cancel-fanout', 'fanout', { durable: true });
    expect(channel.bindQueue).toHaveBeenCalledWith('cancel-queue-name', 'cancel-fanout', '');
  });

  // ── Connection/channel lifecycle ─────────────────────────────────────────

  it('reconnects when the connection closes', async () => {
    const { start } = await import('../index');
    await start();
    expect(mockConnect).toHaveBeenCalledTimes(1);

    const secondChannel = makeFakeChannel();
    mockConnect.mockResolvedValue(makeFakeConnection(secondChannel));

    connection.emit('close');
    await vi.waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(secondChannel.consume).toHaveBeenCalledTimes(2));
  });

  it('does not start a second reconnect loop if one is already in flight', async () => {
    const { start } = await import('../index');
    await start();
    expect(mockConnect).toHaveBeenCalledTimes(1);

    mockConnect.mockReturnValue(new Promise(() => {}));
    connection.emit('close');
    connection.emit('close');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  // ── /health (real route) ──────────────────────────────────────────────────

  it('/health returns 200/ok when connected and not saturated', async () => {
    const { start, app } = await import('../index');
    await start();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().checks.queue).toBe('ok');
  });

  it('/health returns 503/disconnected after the connection closes', async () => {
    const { start, app } = await import('../index');
    await start();

    mockConnect.mockReturnValue(new Promise(() => {}));
    connection.emit('close');

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.queue).toBe('disconnected');
  });

  it('/health returns 503/disconnected on a channel error', async () => {
    const { start, app } = await import('../index');
    await start();

    channel.emit('error', new Error('channel died'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
  });

  // ── Work-queue consumer — real message handler ───────────────────────────

  describe('work queue consumer', () => {
    it('completes normally: sends metrics to test-results and acks', async () => {
      mockRunClientTest.mockResolvedValue({ metrics: makeMetrics(), executionLog: 'log' });
      const { start } = await import('../index');
      await start();
      const queueHandler = channel.consume.mock.calls[1][1] as (msg: unknown) => Promise<void>;

      await queueHandler(makeMsg(makeTest()));

      const sent = channel.sendToQueue.mock.calls.find(c => c[0] === 'test-results');
      expect(sent).toBeDefined();
      const payload = JSON.parse((sent![1] as Buffer).toString());
      expect(payload.status).toBe('completed');
      expect(channel.ack).toHaveBeenCalledOnce();
    });

    it('rewrites localhost to host.docker.internal in the target URL', async () => {
      mockRunClientTest.mockResolvedValue({ metrics: makeMetrics(), executionLog: '' });
      const { start } = await import('../index');
      await start();
      const queueHandler = channel.consume.mock.calls[1][1] as (msg: unknown) => Promise<void>;

      await queueHandler(makeMsg(makeTest({ targetUrl: 'http://localhost:8080' })));

      const passedTest = mockRunClientTest.mock.calls[0][0] as TestRequest;
      expect(passedTest.targetUrl).toBe('http://host.docker.internal:8080');
    });

    it('retries via the real handleRetry when runClientTest throws', async () => {
      mockRunClientTest.mockRejectedValue(Object.assign(new Error('puppeteer crashed'), { partialLog: 'boom' }));
      const { start } = await import('../index');
      await start();
      const queueHandler = channel.consume.mock.calls[1][1] as (msg: unknown) => Promise<void>;

      await queueHandler(makeMsg(makeTest({ id: 'retry-test' })));

      expect(channel.publish).toHaveBeenCalledOnce();
      expect(channel.publish.mock.calls[0][1]).toBe('client-tests');
      expect(channel.sendToQueue).not.toHaveBeenCalledWith('test-results', expect.anything(), expect.anything());
    });

    it('Stop button: a test cancelled during execution is not published to test-results', async () => {
      let resolveRun!: (v: { metrics: ClientMetrics; executionLog: string }) => void;
      mockRunClientTest.mockImplementation((test: TestRequest, ctx: { runningBrowsers: Map<string, { close: MockFn }> }) => {
        ctx.runningBrowsers.set(test.id, { close: vi.fn().mockResolvedValue(undefined) });
        return new Promise(resolve => { resolveRun = resolve; });
      });

      const { start } = await import('../index');
      await start();
      const cancelHandler = channel.consume.mock.calls[0][1] as (msg: unknown) => Promise<void>;
      const queueHandler  = channel.consume.mock.calls[1][1] as (msg: unknown) => Promise<void>;

      const test = makeTest({ id: 'stop-test-1' });
      const queuePromise = queueHandler(makeMsg(test));
      await vi.waitFor(() => expect(mockRunClientTest).toHaveBeenCalled());

      await cancelHandler(makeMsg({ testId: test.id }));
      resolveRun({ metrics: makeMetrics(), executionLog: '' });
      await queuePromise;

      expect(channel.sendToQueue).not.toHaveBeenCalledWith('test-results', expect.anything(), expect.anything());
      expect(channel.ack).toHaveBeenCalled();
    });

    it('cancel-queue consumer closes the tracked browser and acks', async () => {
      const fakeBrowser = { close: vi.fn().mockResolvedValue(undefined) };
      mockRunClientTest.mockImplementation((test: TestRequest, ctx: { runningBrowsers: Map<string, unknown> }) => {
        ctx.runningBrowsers.set(test.id, fakeBrowser);
        return new Promise(() => {}); // still "running"
      });
      const { start } = await import('../index');
      await start();
      const cancelHandler = channel.consume.mock.calls[0][1] as (msg: unknown) => Promise<void>;
      const queueHandler  = channel.consume.mock.calls[1][1] as (msg: unknown) => Promise<void>;

      void queueHandler(makeMsg(makeTest({ id: 'kill-me' })));
      await vi.waitFor(() => expect(mockRunClientTest).toHaveBeenCalled());

      await cancelHandler(makeMsg({ testId: 'kill-me' }));

      expect(fakeBrowser.close).toHaveBeenCalledOnce();
      expect(channel.ack).toHaveBeenCalled();
    });

    it('cancel-queue consumer is a no-op (but still acks) for an unknown testId', async () => {
      const { start } = await import('../index');
      await start();
      const cancelHandler = channel.consume.mock.calls[0][1] as (msg: unknown) => Promise<void>;

      await expect(cancelHandler(makeMsg({ testId: 'never-started' }))).resolves.toBeUndefined();
      expect(channel.ack).toHaveBeenCalled();
    });
  });
});
