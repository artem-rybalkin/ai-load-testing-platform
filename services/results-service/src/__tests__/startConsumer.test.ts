/**
 * Unit tests for results-service's own startConsumer() — connection/channel
 * lifecycle (reconnect on close/error), queue/DLQ setup, the malformed-
 * message guard, and the retry/DLQ routing when handleResult throws.
 *
 * handleResult's own logic (analyser integration, persistence, webhooks) is
 * exhaustively covered against a real DB in consumer.test.ts and is not
 * re-tested here — it's exercised through the real startConsumer() using a
 * real Testcontainers Postgres, via the `deps.pool` override startConsumer
 * accepts specifically so tests don't need to mock db.ts's module-level
 * pool export.
 *
 * amqplib is mocked with EventEmitter-based fake connection/channel objects
 * so the real startConsumer()/scheduleReconnect() code runs against them.
 * vi.resetModules() + a dynamic import() per test gives each test fresh
 * `reconnecting`/`consumerConnected` module state (both are plain
 * module-level singletons in consumer.ts).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Pool } from 'pg';
import { createTestDatabase, truncateAll } from '../../../../test-support/sharedPostgres';
import { createSchema } from '../db';
import type { TestResult, BackendMetrics } from '@alt/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

const mockConnect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ default: { connect: mockConnect } }));

vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('../ws', () => ({ broadcast: vi.fn() }));

vi.mock('@opentelemetry/api', () => ({ trace: { getActiveSpan: vi.fn().mockReturnValue(null) } }));

type FakeChannel = EventEmitter & {
  assertQueue: MockFn; consume: MockFn; ack: MockFn; sendToQueue: MockFn; publish: MockFn; prefetch: MockFn;
};

function makeFakeChannel(): FakeChannel {
  const ch = new EventEmitter() as FakeChannel;
  ch.assertQueue = vi.fn().mockResolvedValue(undefined);
  ch.consume     = vi.fn();
  ch.ack         = vi.fn();
  ch.sendToQueue = vi.fn();
  ch.publish     = vi.fn();
  ch.prefetch    = vi.fn();
  return ch;
}

type FakeConnection = EventEmitter & { createChannel: MockFn; close: MockFn };

function makeFakeConnection(channel: FakeChannel): FakeConnection {
  const conn = new EventEmitter() as FakeConnection;
  conn.createChannel = vi.fn().mockResolvedValue(channel);
  conn.close = vi.fn().mockResolvedValue(undefined);
  return conn;
}

const baseMetrics: BackendMetrics = {
  type: 'backend', requestsTotal: 100, requestsFailed: 0,
  avgResponseTime: 100, p50ResponseTime: 90, p95ResponseTime: 150, p99ResponseTime: 200, rps: 10,
};

const makeResult = (overrides: Partial<TestResult> = {}): TestResult => ({
  testId: crypto.randomUUID(),
  targetUrl: 'https://example.com',
  status: 'completed',
  metrics: baseMetrics,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  completedAt: new Date().toISOString(),
  ...overrides,
});

let pool: Pool;
let dropDb: () => Promise<void>;

beforeAll(async () => {
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false })); // analyser-service unreachable -> local analyzeResult fallback
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await dropDb();
});

beforeEach(async () => {
  await truncateAll(pool, 'TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets, log_sources CASCADE');
  process.env.RABBITMQ_URL = 'amqp://test:test@localhost:5672';
});

describe('startConsumer', () => {
  let channel: FakeChannel;
  let connection: FakeConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    channel = makeFakeChannel();
    connection = makeFakeConnection(channel);
    mockConnect.mockResolvedValue(connection);
  });

  afterEach(() => {
    delete process.env.RABBITMQ_URL;
  });

  // ── Queue setup ────────────────────────────────────────────────────────

  it('asserts the queue and DLQ as durable and sets prefetch(1)', async () => {
    const { startConsumer, QUEUE, DLQ } = await import('../consumer');
    await startConsumer({ pool });

    expect(channel.assertQueue).toHaveBeenCalledWith(QUEUE, { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith(DLQ, { durable: true });
    expect(channel.prefetch).toHaveBeenCalledWith(1);
  });

  it('registers a consumer on the queue', async () => {
    const { startConsumer, QUEUE } = await import('../consumer');
    await startConsumer({ pool });
    expect(channel.consume).toHaveBeenCalledWith(QUEUE, expect.any(Function));
  });

  // ── Connection/channel lifecycle ────────────────────────────────────────

  it('reconnects (calls amqplib.connect again) when the connection closes', async () => {
    const { startConsumer } = await import('../consumer');
    await startConsumer({ pool });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    const secondChannel = makeFakeChannel();
    mockConnect.mockResolvedValue(makeFakeConnection(secondChannel));

    connection.emit('close');
    await vi.waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(secondChannel.consume).toHaveBeenCalled());
  });

  it('does not start a second reconnect loop if one is already in flight', async () => {
    const { startConsumer } = await import('../consumer');
    await startConsumer({ pool });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    mockConnect.mockReturnValue(new Promise(() => {})); // RabbitMQ still down
    connection.emit('close');
    connection.emit('close');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('isConsumerConnected() is true once connected and false after the connection closes', async () => {
    const { startConsumer, isConsumerConnected } = await import('../consumer');
    await startConsumer({ pool });
    expect(isConsumerConnected()).toBe(true);

    mockConnect.mockReturnValue(new Promise(() => {}));
    connection.emit('close');

    expect(isConsumerConnected()).toBe(false);
  });

  it('isConsumerConnected() is false after a channel error', async () => {
    const { startConsumer, isConsumerConnected } = await import('../consumer');
    await startConsumer({ pool });

    channel.emit('error', new Error('channel died'));

    expect(isConsumerConnected()).toBe(false);
  });

  // ── Malformed message guard ──────────────────────────────────────────────

  it('routes a non-JSON message to the DLQ, acks it, and never touches the database', async () => {
    const { startConsumer, DLQ } = await import('../consumer');
    await startConsumer({ pool });
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer } | null) => Promise<void>;

    await handler({ content: Buffer.from('not valid json {{{') });

    expect(channel.sendToQueue).toHaveBeenCalledWith(DLQ, expect.any(Buffer), { persistent: true });
    expect(channel.ack).toHaveBeenCalledOnce();
    const { rows } = await pool.query('SELECT count(*) FROM test_results');
    expect(Number(rows[0].count)).toBe(0);
  });

  it('routes a message failing schema validation (missing required field) to the DLQ', async () => {
    const { startConsumer, DLQ } = await import('../consumer');
    await startConsumer({ pool });
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer } | null) => Promise<void>;

    await handler({ content: Buffer.from(JSON.stringify({ targetUrl: 'https://example.com' })) }); // no testId, no status, no metrics

    expect(channel.sendToQueue).toHaveBeenCalledWith(DLQ, expect.any(Buffer), { persistent: true });
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('ignores a null message (consumer cancellation notice)', async () => {
    const { startConsumer } = await import('../consumer');
    await startConsumer({ pool });
    const handler = channel.consume.mock.calls[0][1] as (msg: null) => Promise<void>;

    await expect(handler(null)).resolves.toBeUndefined();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  // ── Valid message -> the real handleResult, against the injected pool ────

  it('parses a valid message, persists it via the real handleResult, and acks', async () => {
    const { startConsumer } = await import('../consumer');
    await startConsumer({ pool });
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer; properties: { headers: Record<string, number> } }) => Promise<void>;
    const result = makeResult();

    await handler({ content: Buffer.from(JSON.stringify(result)), properties: { headers: {} } });

    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [result.testId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    expect(channel.ack).toHaveBeenCalledOnce();
    expect(channel.publish).not.toHaveBeenCalled();
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  // ── handleResult throws -> real retry/DLQ routing ────────────────────────
  //
  // A scriptId referencing a non-existent test_scripts row triggers a real FK
  // violation inside handleResult's INSERT — the same trigger consumer.test.ts's
  // "transaction rollback" tests use — so these exercise the actual retry math
  // in consumer.ts, not a hand-copied reimplementation of it.

  it('republishes with an incremented x-retry-count when handleResult throws and retries remain', async () => {
    const { startConsumer, QUEUE } = await import('../consumer');
    await startConsumer({ pool });
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer; properties: { headers: Record<string, number> } }) => Promise<void>;
    const result = makeResult({ scriptId: crypto.randomUUID() });
    const msg = { content: Buffer.from(JSON.stringify(result)), properties: { headers: { 'x-retry-count': 0 } } };

    await handler(msg);

    expect(channel.publish).toHaveBeenCalledWith(
      '', QUEUE, msg.content,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 1 }) }),
    );
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('routes to the DLQ once MAX_RETRIES is exhausted', async () => {
    const { startConsumer, DLQ } = await import('../consumer');
    await startConsumer({ pool });
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer; properties: { headers: Record<string, number> } }) => Promise<void>;
    const result = makeResult({ scriptId: crypto.randomUUID() });
    const msg = { content: Buffer.from(JSON.stringify(result)), properties: { headers: { 'x-retry-count': 3 } } };

    await handler(msg);

    expect(channel.sendToQueue).toHaveBeenCalledWith(DLQ, msg.content, { persistent: true });
    expect(channel.publish).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('routes to the DLQ when retryCount exceeds MAX_RETRIES', async () => {
    const { startConsumer, DLQ } = await import('../consumer');
    await startConsumer({ pool });
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer; properties: { headers: Record<string, number> } }) => Promise<void>;
    const result = makeResult({ scriptId: crypto.randomUUID() });
    const msg = { content: Buffer.from(JSON.stringify(result)), properties: { headers: { 'x-retry-count': 8 } } };

    await handler(msg);

    expect(channel.sendToQueue).toHaveBeenCalledWith(DLQ, msg.content, { persistent: true });
  });

  it('treats a missing x-retry-count header as 0 (first attempt)', async () => {
    const { startConsumer, QUEUE } = await import('../consumer');
    await startConsumer({ pool });
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer; properties: { headers: Record<string, number> } }) => Promise<void>;
    const result = makeResult({ scriptId: crypto.randomUUID() });
    const msg = { content: Buffer.from(JSON.stringify(result)), properties: { headers: {} } };

    await handler(msg);

    expect(channel.publish).toHaveBeenCalledWith(
      '', QUEUE, msg.content,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 1 }) }),
    );
  });
});
