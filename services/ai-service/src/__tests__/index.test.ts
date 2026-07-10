/**
 * Unit tests for ai-service's own responsibilities in src/index.ts —
 * connection/channel lifecycle, queue setup, the malformed-message guard,
 * and the /health route. The REUSE/REGENERATE/retry/DLQ decision tree lives
 * in processor.ts (processAiRequest) and is exhaustively covered by
 * processor.test.ts — it is mocked here, not re-tested.
 *
 * amqplib is mocked with EventEmitter-based fake connection/channel objects
 * so the real startConsumer()/scheduleReconnect() code runs against them,
 * instead of hand-reimplementing the routing logic as a parallel function
 * (the previous version of this file did that, and could silently drift
 * from src/index.ts without failing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { EnrichedTestRequest } from '@alt/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

const mockConnect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ default: { connect: mockConnect } }));

const mockProcessAiRequest = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../processor', () => ({ processAiRequest: mockProcessAiRequest }));

vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Fakes ──────────────────────────────────────────────────────────────────

type FakeChannel = EventEmitter & {
  assertQueue: MockFn; consume: MockFn; ack: MockFn; sendToQueue: MockFn;
  publish: MockFn; prefetch: MockFn;
};

function makeFakeChannel(): FakeChannel {
  const ch = new EventEmitter() as FakeChannel;
  ch.assertQueue = vi.fn().mockResolvedValue(undefined);
  ch.consume     = vi.fn().mockResolvedValue({ consumerTag: 'fake-consumer-tag' });
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

const makeTest = (overrides: Partial<EnrichedTestRequest> = {}): EnrichedTestRequest => ({
  id:          'test-id',
  type:        'backend',
  targetUrl:   'https://example.com',
  description: 'load test with 10 users',
  options:     { vus: 10, duration: '1m' },
  createdAt:   '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('ai-service index.ts', () => {
  let channel: FakeChannel;
  let connection: FakeConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    channel = makeFakeChannel();
    connection = makeFakeConnection(channel);
    mockConnect.mockResolvedValue(connection);
  });

  afterEach(async () => {
    const { app } = await import('../index');
    await app.close();
  });

  // ── Queue setup ────────────────────────────────────────────────────────

  it('asserts all four queues as durable and sets prefetch to WORKER_CONCURRENCY', async () => {
    process.env.WORKER_CONCURRENCY = '5';
    const { startConsumer, CONSUME_QUEUE, DLQ, BACKEND_QUEUE, CLIENT_QUEUE } = await import('../index');

    await startConsumer();

    expect(channel.assertQueue).toHaveBeenCalledWith(CONSUME_QUEUE, { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith(DLQ, { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith(BACKEND_QUEUE, { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith(CLIENT_QUEUE, { durable: true });
    expect(channel.prefetch).toHaveBeenCalledWith(5);
    delete process.env.WORKER_CONCURRENCY;
  });

  it('registers a consumer on CONSUME_QUEUE', async () => {
    const { startConsumer, CONSUME_QUEUE } = await import('../index');
    await startConsumer();
    expect(channel.consume).toHaveBeenCalledWith(CONSUME_QUEUE, expect.any(Function));
  });

  // ── Connection/channel lifecycle ────────────────────────────────────────

  it('reconnects (calls amqplib.connect again) when the connection closes', async () => {
    const { startConsumer } = await import('../index');
    await startConsumer();
    expect(mockConnect).toHaveBeenCalledTimes(1);

    const secondChannel = makeFakeChannel();
    const secondConnection = makeFakeConnection(secondChannel);
    mockConnect.mockResolvedValue(secondConnection);

    connection.emit('close');
    await vi.waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
    // The reconnect fully re-initializes the consumer on the new channel.
    await vi.waitFor(() => expect(secondChannel.consume).toHaveBeenCalled());
  });

  it('does not start a second reconnect loop if one is already in flight', async () => {
    const { startConsumer } = await import('../index');
    await startConsumer();
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Never resolves — simulates RabbitMQ still being down while we fire
    // 'close' twice in a row (connection + channel error can both land).
    mockConnect.mockReturnValue(new Promise(() => {}));

    connection.emit('close');
    connection.emit('close');
    await new Promise(resolve => setTimeout(resolve, 20));

    // Exactly one extra reconnect attempt was started, not two.
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('/health reports 503/disconnected after the connection closes', async () => {
    const { startConsumer, app } = await import('../index');
    await startConsumer();

    const before = await app.inject({ method: 'GET', url: '/health' });
    expect(before.statusCode).toBe(200);
    expect(before.json().checks.queue).toBe('ok');

    mockConnect.mockReturnValue(new Promise(() => {})); // stall the reconnect
    connection.emit('close');

    const after = await app.inject({ method: 'GET', url: '/health' });
    expect(after.statusCode).toBe(503);
    expect(after.json().checks.queue).toBe('disconnected');
  });

  it('/health reports disconnected on a channel error', async () => {
    const { startConsumer, app } = await import('../index');
    await startConsumer();

    channel.emit('error', new Error('channel died'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
  });

  // ── Malformed message guard ──────────────────────────────────────────────

  it('routes a non-JSON message to the DLQ, acks it, and never calls processAiRequest', async () => {
    const { startConsumer, DLQ } = await import('../index');
    await startConsumer();
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer }) => Promise<void>;

    await handler({ content: Buffer.from('not valid json {{{') });

    expect(channel.sendToQueue).toHaveBeenCalledWith(DLQ, expect.any(Buffer), { persistent: true });
    expect(channel.ack).toHaveBeenCalledOnce();
    expect(mockProcessAiRequest).not.toHaveBeenCalled();
  });

  it('ignores a null message (consumer cancellation notice)', async () => {
    const { startConsumer } = await import('../index');
    await startConsumer();
    const handler = channel.consume.mock.calls[0][1] as (msg: null) => Promise<void>;

    await expect(handler(null)).resolves.toBeUndefined();
    expect(mockProcessAiRequest).not.toHaveBeenCalled();
  });

  // ── Valid message delegates to processor.ts ─────────────────────────────

  it('parses a valid message and delegates to processAiRequest with the channel/msg/resultsUrl', async () => {
    process.env.RESULTS_URL = 'http://results-service:3004';
    const { startConsumer } = await import('../index');
    await startConsumer();
    const handler = channel.consume.mock.calls[0][1] as (msg: { content: Buffer }) => Promise<void>;
    const test = makeTest();
    const msg = { content: Buffer.from(JSON.stringify(test)) };

    await handler(msg);

    expect(mockProcessAiRequest).toHaveBeenCalledOnce();
    const [passedTest, deps] = mockProcessAiRequest.mock.calls[0];
    expect(passedTest.id).toBe(test.id);
    expect(deps.channel).toBe(channel);
    expect(deps.msg).toBe(msg);
    expect(deps.resultsUrl).toBe('http://results-service:3004');
    delete process.env.RESULTS_URL;
  });
});
