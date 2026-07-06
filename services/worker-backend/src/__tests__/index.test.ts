/**
 * Unit tests for worker-backend/src/index.ts — its own responsibilities:
 * connection/channel lifecycle (reconnect on close/error), queue setup,
 * saveScript/notify* REST helpers, and the Stop-button cancel orchestration
 * in the real queue consumer. k6 execution itself (runK6Test) is mocked —
 * that's runner.test.ts's job (exit codes, SIGTERM/SIGKILL escalation, log
 * batching are all covered there against the real function).
 *
 * amqplib is mocked with EventEmitter-based fake connection/channel objects
 * so the real start()/scheduleReconnect() code runs against them, instead of
 * hand-reimplementing the logic as a parallel function that can silently
 * drift from src/index.ts without failing (the previous version of this
 * file did that for handleRetry/validateScript/the stop branch — both
 * handleRetry and validateScript already have real-module coverage in
 * runner.test.ts, so those duplicates were dead weight, not just untested).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { EnrichedTestRequest, BackendMetrics } from '@alt/shared';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
process.env.RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://placeholder:placeholder@localhost:5672';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

// ── pg mock ──────────────────────────────────────────────────────────────
// A real class, not vi.fn().mockImplementation(() => ({...})) — an arrow
// function has no [[Construct]], so `new Pool(...)` would throw "is not a
// constructor" the moment a test actually imports the real module.
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('pg', () => ({
  Pool: class { query = mockQuery; },
}));

// ── amqplib mock ─────────────────────────────────────────────────────────
const mockConnect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ default: { connect: mockConnect } }));

// ── runner mock — keep the real handleRetry/GRACE_PERIOD_MS, fake runK6Test ─
const mockRunK6Test = vi.hoisted(() => vi.fn());
vi.mock('../runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner')>();
  return { ...actual, runK6Test: mockRunK6Test };
});

vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@opentelemetry/api', () => ({ trace: { getActiveSpan: vi.fn().mockReturnValue(null) } }));

// initTracing() (@alt/tracing) registers its own process signal handlers for
// graceful span-flush-on-shutdown; across 20+ vi.resetModules() re-imports in
// this file that trips Node's MaxListenersExceededWarning. Side-effect-only
// import (no exports used), safe to no-op in tests.
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

const makeTest = (overrides: Partial<EnrichedTestRequest> = {}): EnrichedTestRequest => ({
  id:              'test-id',
  type:            'backend',
  targetUrl:       'https://example.com',
  description:     'load test',
  options:         { vus: 10, duration: '1m' },
  createdAt:       '2025-01-01T00:00:00Z',
  generatedScript: 'export default function() {}',
  ...overrides,
});

const makeMetrics = (overrides: Partial<BackendMetrics> = {}): BackendMetrics => ({
  type: 'backend',
  requestsTotal: 10,
  requestsFailed: 0,
  avgResponseTime: 100,
  p50ResponseTime: 90,
  p95ResponseTime: 150,
  p99ResponseTime: 200,
  rps: 5,
  ...overrides,
});

const makeMsg = (body: unknown): { content: Buffer; properties: { headers: Record<string, unknown> } } => ({
  content: Buffer.from(JSON.stringify(body)),
  properties: { headers: {} },
});

describe('worker-backend index.ts', () => {
  let channel: FakeChannel;
  let connection: FakeConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    channel = makeFakeChannel();
    connection = makeFakeConnection(channel);
    mockConnect.mockResolvedValue(connection);
    mockQuery.mockResolvedValue({ rows: [] });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in test')));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { app } = await import('../index');
    await app.close();
  });

  // ── Queue setup ──────────────────────────────────────────────────────────

  it('asserts the work/DLQ/results queues as durable and sets prefetch', async () => {
    process.env.WORKER_CONCURRENCY = '4';
    const { start } = await import('../index');
    await start();

    expect(channel.assertQueue).toHaveBeenCalledWith('backend-tests', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('backend-tests.dlq', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('test-results', { durable: true });
    expect(channel.prefetch).toHaveBeenCalledWith(4);
    delete process.env.WORKER_CONCURRENCY;
  });

  it('binds an exclusive auto-delete queue to the cancel-fanout exchange', async () => {
    const { start } = await import('../index');
    await start();

    expect(channel.assertExchange).toHaveBeenCalledWith('cancel-fanout', 'fanout', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('', { exclusive: true, autoDelete: true });
    expect(channel.bindQueue).toHaveBeenCalledWith('cancel-queue-name', 'cancel-fanout', '');
  });

  it('registers a consumer on the cancel queue and the work queue', async () => {
    const { start } = await import('../index');
    await start();
    expect(channel.consume).toHaveBeenCalledTimes(2);
    expect(channel.consume.mock.calls[1][0]).toBe('backend-tests');
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

    mockConnect.mockReturnValue(new Promise(() => {})); // RabbitMQ still down
    connection.emit('close');
    connection.emit('close');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('/health reports disconnected after the connection closes', async () => {
    const { start, app } = await import('../index');
    await start();

    const before = await app.inject({ method: 'GET', url: '/health' });
    expect(before.json().checks.queue).toBe('ok');

    mockConnect.mockReturnValue(new Promise(() => {}));
    connection.emit('close');

    const after = await app.inject({ method: 'GET', url: '/health' });
    expect(after.statusCode).toBe(503);
    expect(after.json().checks.queue).toBe('disconnected');
  });

  it('/health reports disconnected on a channel error', async () => {
    const { start, app } = await import('../index');
    await start();

    channel.emit('error', new Error('channel died'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
  });

  // ── saveScript (real function) ───────────────────────────────────────────

  describe('saveScript', () => {
    it('increments used_count and returns the same scriptId when one is provided', async () => {
      const { saveScript } = await import('../index');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await saveScript('http://x.com', 'k6script', 'existing-id');

      expect(result).toBe('existing-id');
      expect(mockQuery.mock.calls[0][0]).toMatch(/UPDATE test_scripts SET used_count/);
      expect(mockQuery.mock.calls[0][1]).toEqual(['existing-id']);
    });

    it('inserts a new script row and returns the generated id when no scriptId is given', async () => {
      const { saveScript } = await import('../index');
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new-uuid' }] });

      const result = await saveScript('http://x.com', 'k6script', undefined, 'desc', 'proj-1', 'ws-1');

      expect(result).toBe('new-uuid');
      expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO test_scripts/);
      expect(mockQuery.mock.calls[0][1]).toEqual(['http://x.com', 'k6script', 'desc', 'proj-1', 'ws-1']);
    });

    it('preserves an existing project_id/workspace_id on conflict via COALESCE', async () => {
      const { saveScript } = await import('../index');
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'id' }] });

      await saveScript('http://x.com', 'k6script');

      expect(mockQuery.mock.calls[0][0]).toMatch(/project_id = COALESCE/);
      expect(mockQuery.mock.calls[0][0]).toMatch(/workspace_id = COALESCE/);
    });
  });

  // ── notify* (real functions) ──────────────────────────────────────────────

  describe('notify* REST helpers', () => {
    it('notifyRunning POSTs to /results/:testId/running', async () => {
      const { notifyRunning } = await import('../index');
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await notifyRunning('tid-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://results-service:3004/results/tid-1/running',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('notifyFailed POSTs the execution log to /results/:testId/fail', async () => {
      const { notifyFailed } = await import('../index');
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await notifyFailed('tid-2', 'partial log');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://results-service:3004/results/tid-2/fail');
      expect(JSON.parse(opts.body)).toEqual({ executionLog: 'partial log' });
    });

    it('notifyCancelled POSTs to /results/:testId/cancel', async () => {
      const { notifyCancelled } = await import('../index');
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await notifyCancelled('tid-3');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://results-service:3004/results/tid-3/cancel',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('swallows network errors from all three (best-effort)', async () => {
      const { notifyRunning, notifyFailed, notifyCancelled } = await import('../index');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      await expect(notifyRunning('t')).resolves.toBeUndefined();
      await expect(notifyFailed('t')).resolves.toBeUndefined();
      await expect(notifyCancelled('t')).resolves.toBeUndefined();
    });
  });

  // ── Work-queue consumer — real message handler ───────────────────────────

  describe('work queue consumer', () => {
    it('completes normally: saves the script, sends to test-results, and acks', async () => {
      mockRunK6Test.mockResolvedValue({ metrics: makeMetrics(), executionLog: 'log' });
      mockQuery.mockImplementation((sql: string) =>
        sql.includes('SELECT status') ? Promise.resolve({ rows: [] }) : Promise.resolve({ rows: [{ id: 'script-1' }] }),
      );
      const { start } = await import('../index');
      await start();
      const queueHandler = channel.consume.mock.calls[1][1] as (msg: { content: Buffer }) => Promise<void>;

      const test = makeTest();
      await queueHandler(makeMsg(test));

      expect(mockRunK6Test).toHaveBeenCalledOnce();
      const sent = channel.sendToQueue.mock.calls.find(c => c[0] === 'test-results');
      expect(sent).toBeDefined();
      const payload = JSON.parse((sent![1] as Buffer).toString());
      expect(payload.status).toBe('completed');
      expect(payload.scriptId).toBe('script-1');
      expect(channel.ack).toHaveBeenCalledOnce();
    });

    it('skips execution when the DB already marked the test cancelled before dequeue', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'cancelled' }] });
      const { start } = await import('../index');
      await start();
      const queueHandler = channel.consume.mock.calls[1][1] as (msg: { content: Buffer }) => Promise<void>;

      await queueHandler(makeMsg(makeTest()));

      expect(mockRunK6Test).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalledOnce();
    });

    it('retries via handleRetry when runK6Test throws and the test was not stopped', async () => {
      mockRunK6Test.mockRejectedValue(Object.assign(new Error('k6 crashed'), { partialLog: 'boom' }));
      const { start } = await import('../index');
      await start();
      const queueHandler = channel.consume.mock.calls[1][1] as (msg: { content: Buffer }) => Promise<void>;

      await queueHandler(makeMsg(makeTest({ id: 'retry-test' })));

      // handleRetry (real, imported from runner.ts) republishes with an incremented retry count.
      expect(channel.publish).toHaveBeenCalledOnce();
      expect(channel.publish.mock.calls[0][1]).toBe('backend-tests');
      expect(channel.sendToQueue).not.toHaveBeenCalledWith('test-results', expect.anything(), expect.anything());
    });

    it('Stop button: a stopped test with zero requests is marked cancelled, not completed', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      let resolveRun!: (v: { metrics: BackendMetrics; executionLog: string }) => void;
      mockRunK6Test.mockImplementation((testId: string, ..._rest: unknown[]) => {
        const ctx = _rest[_rest.length - 1] as { runningTests: Map<string, { kill: MockFn }> };
        ctx.runningTests.set(testId, { kill: vi.fn() });
        return new Promise(resolve => { resolveRun = resolve; });
      });
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const { start } = await import('../index');
      await start();
      const cancelHandler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer }) => Promise<void>;
      const queueHandler  = channel.consume.mock.calls[1][1] as (msg: { content: Buffer }) => Promise<void>;

      const test = makeTest({ id: 'stop-test-1' });
      const queuePromise = queueHandler(makeMsg(test));
      await vi.waitFor(() => expect(mockRunK6Test).toHaveBeenCalled());

      // The Stop button sends a cancel-fanout message for this testId.
      await cancelHandler(makeMsg({ testId: test.id }));

      // k6 is killed and exits having captured nothing.
      resolveRun({ metrics: makeMetrics({ requestsTotal: 0 }), executionLog: '' });
      await queuePromise;

      const cancelCall = mockFetch.mock.calls.find(c => (c[0] as string).endsWith('/cancel'));
      expect(cancelCall).toBeDefined();
      expect(channel.sendToQueue).not.toHaveBeenCalledWith('test-results', expect.anything(), expect.anything());
      expect(channel.ack).toHaveBeenCalled();
    });

    it('Stop button: a stopped test with partial requests is saved as completed, not discarded', async () => {
      mockQuery.mockImplementation((sql: string) =>
        sql.includes('SELECT status') ? Promise.resolve({ rows: [] }) : Promise.resolve({ rows: [{ id: 'script-2' }] }),
      );
      let resolveRun!: (v: { metrics: BackendMetrics; executionLog: string }) => void;
      mockRunK6Test.mockImplementation((testId: string, ..._rest: unknown[]) => {
        const ctx = _rest[_rest.length - 1] as { runningTests: Map<string, { kill: MockFn }> };
        ctx.runningTests.set(testId, { kill: vi.fn() });
        return new Promise(resolve => { resolveRun = resolve; });
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      const { start } = await import('../index');
      await start();
      const cancelHandler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer }) => Promise<void>;
      const queueHandler  = channel.consume.mock.calls[1][1] as (msg: { content: Buffer }) => Promise<void>;

      const test = makeTest({ id: 'stop-test-2' });
      const queuePromise = queueHandler(makeMsg(test));
      await vi.waitFor(() => expect(mockRunK6Test).toHaveBeenCalled());
      await cancelHandler(makeMsg({ testId: test.id }));

      resolveRun({ metrics: makeMetrics({ requestsTotal: 7 }), executionLog: 'partial log' });
      await queuePromise;

      const sent = channel.sendToQueue.mock.calls.find(c => c[0] === 'test-results');
      expect(sent).toBeDefined();
      const payload = JSON.parse((sent![1] as Buffer).toString());
      expect(payload.status).toBe('completed');
      expect(payload.metrics.requestsTotal).toBe(7);
    });

    it('cancel-queue consumer kills the tracked process and acks', async () => {
      const { start } = await import('../index');
      await start();
      const cancelHandler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer }) => Promise<void>;

      const fakeProc = { kill: vi.fn() };
      mockRunK6Test.mockImplementation((testId: string, ..._rest: unknown[]) => {
        const ctx = _rest[_rest.length - 1] as { runningTests: Map<string, { kill: MockFn }> };
        ctx.runningTests.set(testId, fakeProc);
        return new Promise(() => {}); // never resolves — process is "running"
      });
      const queueHandler = channel.consume.mock.calls[1][1] as (msg: { content: Buffer }) => Promise<void>;
      void queueHandler(makeMsg(makeTest({ id: 'kill-me' })));
      await vi.waitFor(() => expect(mockRunK6Test).toHaveBeenCalled());

      await cancelHandler(makeMsg({ testId: 'kill-me' }));

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(channel.ack).toHaveBeenCalled();
    });

    it('cancel-queue consumer is a no-op (but still acks) for an unknown testId', async () => {
      const { start } = await import('../index');
      await start();
      const cancelHandler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer }) => Promise<void>;

      await expect(
        cancelHandler(makeMsg({ testId: 'never-started' })),
      ).resolves.toBeUndefined();
      expect(channel.ack).toHaveBeenCalled();
    });
  });

  // ── Regression #1: cancel consumer — missing SIGKILL escalation ──────────
  //
  // Finding (Medium): "Cancel has no SIGKILL escalation, unlike the max-duration watchdog"
  // The cancel-fanout consumer (index.ts:211-217) only sends SIGTERM to the k6
  // child process with no follow-up timer. The max-duration watchdog in the
  // same codebase escalates SIGTERM → SIGKILL after GRACE_PERIOD_MS
  // (runner.ts:195-199). If a k6 process ignores SIGTERM, a user-initiated
  // Stop does nothing further; the worker slot is not freed until the
  // independent max-duration timer eventually fires (up to MAX_TEST_DURATION_MS,
  // default 10 minutes).
  //
  // Desired: after sending SIGTERM on cancel, a follow-up timer should send
  // SIGKILL after GRACE_PERIOD_MS if the process is still in runningTests.
  // Current: no SIGKILL is ever sent from the cancel path.

  describe('cancel consumer — missing SIGKILL escalation (regression finding #1)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('cancel consumer should SIGKILL the process after grace period when SIGTERM is ignored', async () => {
      const { start } = await import('../index');
      // start() only uses microtasks (mocked amqplib resolves immediately), not setTimeout — safe with fake timers.
      await start();

      const cancelHandler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer }) => Promise<void>;
      const queueHandler  = channel.consume.mock.calls[1][1] as (msg: { content: Buffer }) => Promise<void>;

      // A process that stubbornly ignores SIGTERM — stays alive in runningTests forever.
      const fakeProc = { kill: vi.fn() };
      mockRunK6Test.mockImplementation((testId: string, ..._rest: unknown[]) => {
        const ctx = _rest[_rest.length - 1] as { runningTests: Map<string, { kill: MockFn }> };
        ctx.runningTests.set(testId, fakeProc);
        return new Promise(() => {}); // never resolves — process ignores SIGTERM
      });

      // Start the test without awaiting (the handler blocks on the never-resolving mockRunK6Test).
      void queueHandler(makeMsg(makeTest({ id: 'sigkill-test' })));

      // Flush the async chain: parse → pool.query (mockQuery, microtask) →
      // getLiveMetricWindowSec (fetch, rejected microtask) → mockRunK6Test (called).
      // Plain await Promise.resolve() is safe with fake timers — Promises use microtasks,
      // not macrotasks, so fake timers don't intercept them.
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Send cancel — current code sends SIGTERM only, no follow-up SIGKILL timer.
      await cancelHandler(makeMsg({ testId: 'sigkill-test' }));
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

      // Desired: after GRACE_PERIOD_MS (30 000ms), SIGKILL is sent because the
      // process is still in runningTests (it ignored SIGTERM).
      // runner.ts max-duration watchdog does exactly this escalation; cancel does not.
      vi.advanceTimersByTime(30_001);

      // This assertion FAILS in the current code — the cancel path never sets a SIGKILL timer.
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });
});
