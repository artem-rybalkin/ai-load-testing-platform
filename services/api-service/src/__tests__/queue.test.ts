/**
 * Unit tests for api-service/src/queue.ts
 *
 * queue.ts keeps a module-private `channel` variable that is only set after a
 * successful connectQueue() call. The vi.resetModules() + vi.doMock('amqplib')
 * + dynamic import() pattern gives each test a fresh null channel so routing
 * logic can be tested in complete isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as QueueTypes from '../queue';

// ── Test suite ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

type MockChannel = EventEmitter & {
  assertQueue:    MockFn;
  assertExchange: MockFn;
  sendToQueue:    MockFn;
  publish:        MockFn;
  checkQueue:     MockFn;
};

/** Real EventEmitters (not bare vi.fn() spies) so tests can actually
 *  connection.emit('close')/channel.emit('error') and exercise the real
 *  reconnect wiring in queue.ts, not just record that .on() was called. */
const makeMockChannel = (): MockChannel => {
  const ch = new EventEmitter() as MockChannel;
  ch.assertQueue    = vi.fn().mockResolvedValue(undefined);
  ch.assertExchange = vi.fn().mockResolvedValue(undefined);
  ch.sendToQueue    = vi.fn();
  ch.publish        = vi.fn();
  ch.checkQueue     = vi.fn().mockResolvedValue({ consumerCount: 2 });
  return ch;
};

const makeMockConnection = (channel: MockChannel): EventEmitter & { createChannel: MockFn } => {
  const conn = new EventEmitter() as EventEmitter & { createChannel: MockFn };
  conn.createChannel = vi.fn().mockResolvedValue(channel);
  return conn;
};

describe('queue module', () => {
  let queueMod: typeof QueueTypes;
  let mockChannel: MockChannel;
  let mockConnection: EventEmitter & { createChannel: MockFn };
  let mockConnect: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Fresh module registry every test → fresh null `channel`
    vi.resetModules();

    mockChannel = makeMockChannel();
    mockConnection = makeMockConnection(mockChannel);
    mockConnect = vi.fn().mockResolvedValue(mockConnection);

    vi.doMock('amqplib', () => ({ default: { connect: mockConnect } }));

    process.env.RABBITMQ_URL = 'amqp://test:test@localhost:5672';
    queueMod = await import('../queue') as typeof QueueTypes;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore env in case a test deleted it
    process.env.RABBITMQ_URL = 'amqp://placeholder:placeholder@localhost:5672';
  });

  /** Convenience: call connectQueue so the module-private channel is non-null. */
  const connect = (): ReturnType<typeof queueMod.connectQueue> => queueMod.connectQueue();

  // ── isQueueConnected ────────────────────────────────────────────────────────

  describe('isQueueConnected', () => {
    it('returns false before connectQueue is called', () => {
      expect(queueMod.isQueueConnected()).toBe(false);
    });

    it('returns true after connectQueue succeeds', async () => {
      await connect();
      expect(queueMod.isQueueConnected()).toBe(true);
    });
  });

  // ── connectQueue ────────────────────────────────────────────────────────────

  describe('connectQueue', () => {
    it('throws immediately when RABBITMQ_URL is not set', async () => {
      delete process.env.RABBITMQ_URL;
      await expect(queueMod.connectQueue()).rejects.toThrow(
        'RABBITMQ_URL environment variable is required',
      );
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('connects using the RABBITMQ_URL env var', async () => {
      await connect();
      expect(mockConnect).toHaveBeenCalledWith('amqp://test:test@localhost:5672');
    });

    it('asserts all three queues as durable', async () => {
      await connect();
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('ai-requests',   { durable: true });
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('backend-tests', { durable: true });
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('client-tests',  { durable: true });
    });

    it('asserts the cancel-fanout exchange as a durable fanout', async () => {
      await connect();
      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'cancel-fanout', 'fanout', { durable: true },
      );
    });

    it('retries after a transient failure and succeeds on the second attempt', async () => {
      mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ createChannel: vi.fn().mockResolvedValue(mockChannel), on: vi.fn() });

      vi.useFakeTimers();
      try {
        const promise = connect();
        await vi.runAllTimersAsync();
        await promise;
        expect(mockConnect).toHaveBeenCalledTimes(2);
        expect(queueMod.isQueueConnected()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('never gives up — keeps retrying past 20 attempts until RabbitMQ comes back', async () => {
      mockConnect.mockRejectedValue(new Error('Persistent failure'));

      vi.useFakeTimers();
      try {
        const promise = connect();
        // Let it fail and retry well past the old 20-attempt bound
        for (let i = 0; i < 25; i++) {
          await vi.advanceTimersByTimeAsync(30000);
        }
        expect(mockConnect.mock.calls.length).toBeGreaterThan(20);
        expect(queueMod.isQueueConnected()).toBe(false);

        // Now let it succeed
        mockConnect.mockResolvedValueOnce({ createChannel: vi.fn().mockResolvedValue(mockChannel), on: vi.fn() });
        await vi.advanceTimersByTimeAsync(30000);
        await promise;
        expect(queueMod.isQueueConnected()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Connection/channel lifecycle (close/error → reconnect) ─────────────────
  //
  // The mocks above are real EventEmitters specifically so these can drive
  // connection.emit('close')/channel.emit('error') and exercise the actual
  // scheduleReconnect() wiring in queue.ts, not just confirm .on() was called.

  describe('connection lifecycle', () => {
    it('marks the queue disconnected and reconnects when the connection closes', async () => {
      await connect();
      expect(queueMod.isQueueConnected()).toBe(true);
      expect(mockConnect).toHaveBeenCalledTimes(1);

      const secondChannel = makeMockChannel();
      mockConnect.mockResolvedValue(makeMockConnection(secondChannel));

      mockConnection.emit('close');

      // isQueueConnected briefly reads false the instant 'close' fires...
      await vi.waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
      // ...and true again once the reconnect completes against the new channel.
      await vi.waitFor(() => expect(queueMod.isQueueConnected()).toBe(true));
      expect(secondChannel.assertQueue).toHaveBeenCalledWith('ai-requests', { durable: true });
    });

    it('marks the queue disconnected on a channel error (without necessarily reconnecting)', async () => {
      await connect();
      expect(queueMod.isQueueConnected()).toBe(true);

      mockChannel.emit('error', new Error('channel died'));

      expect(queueMod.isQueueConnected()).toBe(false);
    });

    it('does not start a second reconnect loop if one is already in flight', async () => {
      await connect();
      expect(mockConnect).toHaveBeenCalledTimes(1);

      mockConnect.mockReturnValue(new Promise(() => {})); // RabbitMQ still down
      mockConnection.emit('close');
      mockConnection.emit('close');
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });

  // ── publishTest ─────────────────────────────────────────────────────────────

  describe('publishTest', () => {
    it('throws when the queue is not connected', () => {
      expect(() => queueMod.publishTest({} as never, false)).toThrow('Queue not connected');
    });

    it('routes to ai-requests when skipAI is false', async () => {
      await connect();
      queueMod.publishTest({ id: 't1', type: 'backend' } as never, false);
      expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
        'ai-requests', expect.any(Buffer), { persistent: true },
      );
    });

    it('routes a backend test directly to backend-tests when skipAI is true', async () => {
      await connect();
      queueMod.publishTest({ id: 't1', type: 'backend' } as never, true);
      expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
        'backend-tests', expect.any(Buffer), { persistent: true },
      );
    });

    it('routes a flow test to backend-tests when skipAI is true', async () => {
      await connect();
      queueMod.publishTest({ id: 't1', type: 'flow' } as never, true);
      expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
        'backend-tests', expect.any(Buffer), { persistent: true },
      );
    });

    it('routes a client-side test to client-tests when skipAI is true', async () => {
      await connect();
      queueMod.publishTest({ id: 't1', type: 'client-side' } as never, true);
      expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
        'client-tests', expect.any(Buffer), { persistent: true },
      );
    });

    it('serialises the full test object as JSON in the buffer', async () => {
      await connect();
      const test = { id: 'abc-123', type: 'backend', targetUrl: 'https://example.com' } as never;
      queueMod.publishTest(test, false);
      const buf = mockChannel.sendToQueue.mock.calls[0][1] as Buffer;
      expect(JSON.parse(buf.toString())).toMatchObject({
        id: 'abc-123', targetUrl: 'https://example.com',
      });
    });
  });

  // ── publishCancel ──────────────────────────────────────────────────────────

  describe('publishCancel', () => {
    it('throws when the queue is not connected', () => {
      expect(() => queueMod.publishCancel('test-123')).toThrow('Queue not connected');
    });

    it('publishes to the cancel-fanout exchange with an empty routing key', async () => {
      await connect();
      queueMod.publishCancel('test-abc');
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'cancel-fanout', '', expect.any(Buffer),
      );
    });

    it('includes the testId in the JSON payload', async () => {
      await connect();
      queueMod.publishCancel('test-xyz');
      const buf = mockChannel.publish.mock.calls[0][2] as Buffer;
      expect(JSON.parse(buf.toString())).toEqual({ testId: 'test-xyz' });
    });
  });

  // ── getWorkerConsumerCount ──────────────────────────────────────────────────

  describe('getWorkerConsumerCount', () => {
    it('returns 0 when the queue is not connected', async () => {
      expect(await queueMod.getWorkerConsumerCount('backend')).toBe(0);
    });

    it('checks backend-tests queue and returns consumerCount for backend type', async () => {
      await connect();
      mockChannel.checkQueue.mockResolvedValueOnce({ consumerCount: 3 });
      const count = await queueMod.getWorkerConsumerCount('backend');
      expect(mockChannel.checkQueue).toHaveBeenCalledWith('backend-tests');
      expect(count).toBe(3);
    });

    it('checks backend-tests queue for flow type', async () => {
      await connect();
      mockChannel.checkQueue.mockResolvedValueOnce({ consumerCount: 1 });
      const count = await queueMod.getWorkerConsumerCount('flow');
      expect(mockChannel.checkQueue).toHaveBeenCalledWith('backend-tests');
      expect(count).toBe(1);
    });

    it('checks client-tests queue for client-side type', async () => {
      await connect();
      mockChannel.checkQueue.mockResolvedValueOnce({ consumerCount: 2 });
      const count = await queueMod.getWorkerConsumerCount('client-side');
      expect(mockChannel.checkQueue).toHaveBeenCalledWith('client-tests');
      expect(count).toBe(2);
    });

    it('returns 0 when checkQueue throws', async () => {
      await connect();
      mockChannel.checkQueue.mockRejectedValue(new Error('Channel closed'));
      expect(await queueMod.getWorkerConsumerCount('backend')).toBe(0);
    });
  });
});
